import { sql } from 'drizzle-orm';
import type { Executor } from '../db/index.js';

/*
 * RITMO DO MÊS — "estou no ritmo de vendas dos meses anteriores?"
 * Base: dinheiro RECEBIDO (pagamentos não estornados) pelo DIA DO PAGAMENTO, no fuso de Brasília.
 *  - Líquido (padrão) = recebido. Desconto, cancelamento e estorno nunca viram dinheiro recebido.
 *  - Bruto = recebido + descontos concedidos no dia (contas canceladas fora).
 * Tudo em centavos inteiros. As médias são feitas dia a dia sobre as curvas ACUMULADAS dos meses
 * completos anteriores (o mês atual nunca entra); meses curtos repetem o último valor até o dia 31.
 */

export const TZ = 'America/Sao_Paulo';
export type Modo = 'liquido' | 'bruto';
const DIAS = 31;

// ---------- funções puras (testadas isoladamente) ----------

export const diasNoMes = (ano: number, mes: number) => new Date(Date.UTC(ano, mes, 0)).getUTCDate(); // mes 1..12
export const diaDaSemana = (ano: number, mes: number, dia: number) => new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay(); // 0 = domingo
export const chaveMes = (ano: number, mes: number) => `${ano}-${String(mes).padStart(2, '0')}`;
export function somarMeses(chave: string, n: number) {
  const [a, m] = chave.split('-').map(Number);
  const t = a * 12 + (m - 1) + n;
  return chaveMes(Math.floor(t / 12), (t % 12) + 1);
}

/** Curva acumulada de 31 posições (dia 1..31). Depois do último dia do mês, repete o último valor. */
export function curvaAcumulada(porDia: Map<number, number>, nDias: number): number[] {
  const out: number[] = [];
  let soma = 0;
  for (let d = 1; d <= DIAS; d++) {
    if (d <= nDias) soma += porDia.get(d) ?? 0;
    out.push(soma);
  }
  return out;
}

/** Média dia a dia de várias curvas acumuladas (centavos inteiros, arredondado). */
export function mediaDiaADia(curvas: number[][]): number[] {
  if (!curvas.length) return [];
  return Array.from({ length: DIAS }, (_, i) => Math.round(curvas.reduce((s, c) => s + c[i], 0) / curvas.length));
}

export function faixaDiaADia(curvas: number[][]) {
  return {
    min: Array.from({ length: DIAS }, (_, i) => Math.min(...curvas.map((c) => c[i]))),
    max: Array.from({ length: DIAS }, (_, i) => Math.max(...curvas.map((c) => c[i]))),
  };
}

/**
 * Projeção de fechamento pelo FORMATO da curva (não regra de três): se até o dia D a média histórica já
 * tinha vendido F do mês, projeção = atual ÷ F. Faixa: a mesma conta com a fração de cada mês da base.
 * Escondida no começo do mês (dia < 5 ou F < 15%), quando dividir por pouco gera faixa sem sentido.
 */
export function projetar(atual: number, dia: number, base: number[][]) {
  if (!base.length) return { ok: false as const, motivo: 'Sem meses completos para usar como referência.' };
  const media = mediaDiaADia(base);
  const totalMedia = media[DIAS - 1];
  if (totalMedia <= 0) return { ok: false as const, motivo: 'Os meses de referência não têm vendas.' };
  const fracao = media[dia - 1] / totalMedia;
  if (dia < 5 || fracao < 0.15) return { ok: false as const, motivo: 'A projeção aparece a partir do dia 5 (antes disso o mês ainda diz pouco).' };
  const centro = Math.round((atual * totalMedia) / media[dia - 1]);
  const porMes = base.filter((c) => c[dia - 1] > 0 && c[DIAS - 1] > 0).map((c) => Math.round((atual * c[DIAS - 1]) / c[dia - 1]));
  return {
    ok: true as const, centro, fracao: Math.round(fracao * 1000) / 1000, meses: base.length,
    min: porMes.length ? Math.min(...porMes) : centro, max: porMes.length ? Math.max(...porMes) : centro,
  };
}

/** Variação percentual inteira com uma casa (null sem base). */
export const variacao = (agora: number, antes: number | undefined | null) =>
  antes == null || antes <= 0 ? null : Math.round(((agora - antes) / antes) * 1000) / 10;

/**
 * Peso do calendário: quanto o mês "vale" pela quantidade de cada dia da semana, usando o peso real de cada
 * dia da semana no histórico (média de venda por dia aberto). Compara com a média dos meses da base.
 */
export function efeitoCalendario(ano: number, mes: number, pesos: number[], basesMeses: { ano: number; mes: number }[]) {
  const valorMes = (a: number, m: number) => { let s = 0; for (let d = 1; d <= diasNoMes(a, m); d++) s += pesos[diaDaSemana(a, m, d)]; return s; };
  const conta = (a: number, m: number, dow: number) => { let n = 0; for (let d = 1; d <= diasNoMes(a, m); d++) if (diaDaSemana(a, m, d) === dow) n++; return n; };
  if (!basesMeses.length || pesos.every((p) => p <= 0)) return null;
  const atual = valorMes(ano, mes);
  const ref = basesMeses.reduce((s, b) => s + valorMes(b.ano, b.mes), 0) / basesMeses.length;
  if (ref <= 0) return null;
  const pct = Math.round(((atual - ref) / ref) * 1000) / 10;
  const media = (dow: number) => Math.round((basesMeses.reduce((s, b) => s + conta(b.ano, b.mes, dow), 0) / basesMeses.length) * 10) / 10;
  return { pct, sabados: conta(ano, mes, 6), domingos: conta(ano, mes, 0), sextas: conta(ano, mes, 5), mediaSabados: media(6), mediaDomingos: media(0), mediaSextas: media(5) };
}

// ---------- consulta ----------

type DiaValor = { dia: string; cents: number };
const nomeMes = (chave: string) => {
  const [a, m] = chave.split('-').map(Number);
  return `${['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'][m - 1]} de ${a}`;
};

export async function ritmoDoMes(tx: Executor, opts: { mes?: string; modo?: Modo; hoje: string }) {
  const modo: Modo = opts.modo ?? 'liquido';
  const hojeMes = opts.hoje.slice(0, 7);
  const mes = opts.mes ?? hojeMes;
  const [ano, m] = mes.split('-').map(Number);
  const nDias = diasNoMes(ano, m);
  const emCurso = mes === hojeMes;
  const diaHoje = emCurso ? Number(opts.hoje.slice(8, 10)) : nDias;
  const inicio = `${somarMeses(mes, -12)}-01`;
  const fim = `${somarMeses(mes, 1)}-01`;
  const rows = async <T,>(q: ReturnType<typeof sql>) => (await tx.execute(q)).rows as T[];

  // recebido por dia local (estornos fora); bruto soma os descontos do dia (contas canceladas fora)
  const recebido = await rows<DiaValor>(sql`
    SELECT (p.created_at AT TIME ZONE ${TZ})::date::text AS dia, SUM(p.amount_cents)::bigint AS cents
    FROM payments p
    WHERE p.reversed_at IS NULL
      AND p.created_at >= (${inicio}::date::timestamp AT TIME ZONE ${TZ}) AND p.created_at < (${fim}::date::timestamp AT TIME ZONE ${TZ})
    GROUP BY 1`);
  const descontos = modo === 'bruto' ? await rows<DiaValor>(sql`
    SELECT (d.created_at AT TIME ZONE ${TZ})::date::text AS dia, SUM(d.amount_cents)::bigint AS cents
    FROM discounts d JOIN accounts a ON a.id = d.account_id
    WHERE a.status <> 'CANCELLED'
      AND d.created_at >= (${inicio}::date::timestamp AT TIME ZONE ${TZ}) AND d.created_at < (${fim}::date::timestamp AT TIME ZONE ${TZ})
    GROUP BY 1`) : [];
  // dias com caixa aberto (em qualquer momento do dia local)
  const abertos = await rows<{ dia: string }>(sql`
    SELECT g.dia::date::text AS dia FROM generate_series(${inicio}::date, (${fim}::date - 1), interval '1 day') AS g(dia)
    WHERE EXISTS (SELECT 1 FROM cash_registers r
      WHERE r.opened_at < ((g.dia::date + 1)::timestamp AT TIME ZONE ${TZ})
        AND (r.closed_at IS NULL OR r.closed_at >= (g.dia::date::timestamp AT TIME ZONE ${TZ})))`);
  const excluidos = await rows<{ dia: string; reason: string }>(sql`
    SELECT day::text AS dia, reason FROM excluded_days WHERE day >= ${inicio}::date AND day < ${fim}::date`);
  const [primeiro] = await rows<{ dia: string | null }>(sql`
    SELECT LEAST(
      (SELECT MIN((created_at AT TIME ZONE ${TZ})::date) FROM payments),
      (SELECT MIN((opened_at AT TIME ZONE ${TZ})::date) FROM cash_registers))::text AS dia`);

  // valores por mês → dia
  const porMes = new Map<string, Map<number, number>>();
  const add = (lista: DiaValor[]) => { for (const r of lista) {
    const k = r.dia.slice(0, 7), d = Number(r.dia.slice(8, 10));
    if (!porMes.has(k)) porMes.set(k, new Map());
    const mm = porMes.get(k)!; mm.set(d, (mm.get(d) ?? 0) + Number(r.cents));
  } };
  add(recebido); add(descontos);
  const abertosSet = new Set(abertos.map((a) => a.dia));
  const curvaDe = (k: string) => { const [a, mm] = k.split('-').map(Number); return curvaAcumulada(porMes.get(k) ?? new Map(), diasNoMes(a, mm)); };

  // mês "completo" para comparação: anterior ao mês olhado, depois do começo do uso (o mês em que o sistema
  // começou só conta se começou até o dia 2) e com alguma venda
  const inicioUso = primeiro?.dia ?? null;
  const mesCompleto = (k: string) => {
    if (k >= mes || !inicioUso) return false;
    const mesInicio = inicioUso.slice(0, 7);
    if (k < mesInicio) return false;
    if (k === mesInicio && Number(inicioUso.slice(8, 10)) > 2) return false;
    return (curvaDe(k)[DIAS - 1] ?? 0) > 0;
  };
  const anteriores = Array.from({ length: 6 }, (_, i) => somarMeses(mes, -(i + 1)));
  const completos = anteriores.filter(mesCompleto);
  const base3 = anteriores.slice(0, 3).filter(mesCompleto);
  const passadoK = somarMeses(mes, -1);
  const anoK = somarMeses(mes, -12);

  const atualCurva = curvaDe(mes).slice(0, diaHoje);
  const passado = mesCompleto(passadoK) ? { mes: passadoK, nome: nomeMes(passadoK), pontos: curvaDe(passadoK) } : null;
  const media3 = base3.length >= 2 ? { meses: base3, pontos: mediaDiaADia(base3.map(curvaDe)) } : null;
  const media6 = completos.length > 3 ? { meses: completos, pontos: mediaDiaADia(completos.map(curvaDe)), ...faixaDiaADia(completos.map(curvaDe)) } : null;
  const anoAnterior = mesCompleto(anoK) ? { mes: anoK, nome: nomeMes(anoK), pontos: curvaDe(anoK) } : null;

  // resumo no mesmo dia do mês
  const valorHoje = atualCurva[diaHoje - 1] ?? 0;
  const resumo = {
    dia: diaHoje, valor: valorHoje,
    vsPassado: passado ? variacao(valorHoje, passado.pontos[diaHoje - 1]) : null,
    vsMedia3: base3.length >= 2 ? variacao(valorHoje, mediaDiaADia(base3.map(curvaDe))[diaHoje - 1]) : null,
    mesesMedia3: base3.length,
  };
  const proj = emCurso ? projetar(valorHoje, diaHoje, base3.map(curvaDe)) : { ok: false as const, motivo: 'Mês já encerrado.' };

  // dias fechados do mês olhado (até hoje) e dia da semana em que nunca abre
  const fechados: { dia: number; motivo: string }[] = [];
  const exclMap = new Map(excluidos.map((e) => [e.dia, e.reason]));
  for (let d = 1; d <= diaHoje; d++) {
    const iso = `${mes}-${String(d).padStart(2, '0')}`;
    const vendeu = (porMes.get(mes)?.get(d) ?? 0) > 0;
    if (exclMap.has(iso)) fechados.push({ dia: d, motivo: exclMap.get(iso)! });
    else if (!abertosSet.has(iso) && !vendeu && !(emCurso && d === diaHoje)) fechados.push({ dia: d, motivo: 'Caixa não abriu' });
  }
  const contagemDow = Array.from({ length: 7 }, () => ({ dias: 0, abertos: 0, cents: 0 }));
  for (const k of completos) {
    const [a, mm] = k.split('-').map(Number);
    for (let d = 1; d <= diasNoMes(a, mm); d++) {
      const iso = `${k}-${String(d).padStart(2, '0')}`; const dow = diaDaSemana(a, mm, d);
      const v = porMes.get(k)?.get(d) ?? 0;
      contagemDow[dow].dias++;
      if (abertosSet.has(iso) || v > 0) { contagemDow[dow].abertos++; contagemDow[dow].cents += v; }
    }
  }
  const diaSemanaFechado = contagemDow.map((c, dow) => (c.dias >= 4 && c.abertos === 0 ? dow : -1)).filter((x) => x >= 0);
  const pesos = contagemDow.map((c) => (c.abertos ? c.cents / c.abertos : 0));
  const cal = efeitoCalendario(ano, m, pesos, base3.map((k) => { const [a, mm] = k.split('-').map(Number); return { ano: a, mes: mm }; }));

  // o que falta para cada linha aparecer
  const faltam: { linha: string; texto: string }[] = [];
  const mesInicioConta = inicioUso ? (Number(inicioUso.slice(8, 10)) > 2 ? somarMeses(inicioUso.slice(0, 7), 1) : inicioUso.slice(0, 7)) : null;
  const quando = (nMeses: number) => (mesInicioConta ? nomeMes(somarMeses(mesInicioConta, nMeses)) : 'quando houver meses completos de vendas');
  if (!passado) faltam.push({ linha: 'passado', texto: `"Mês passado" aparece em ${quando(1)} (precisa de 1 mês completo).` });
  if (!media3) faltam.push({ linha: 'media3', texto: `"Média 3 meses" aparece em ${quando(2)} (com 2 meses; completa com 3 em ${quando(3)}).` });
  else if (base3.length < 3) faltam.push({ linha: 'media3', texto: `Média de ${base3.length} meses por enquanto (completa com 3 em ${quando(3)}).` });
  if (!media6) faltam.push({ linha: 'media6', texto: `"Média 6 meses" aparece em ${quando(4)} (com mais de 3 meses; completa com 6 em ${quando(6)}).` });
  if (!anoAnterior) faltam.push({ linha: 'anoAnterior', texto: `"Mesmo mês do ano anterior" aparece em ${quando(12)}.` });

  const avisos: string[] = [];
  if (cal && Math.abs(cal.pct) >= 4) {
    avisos.push(`Calendário: ${nomeMes(mes).split(' ')[0]} tem ${cal.sextas} sextas, ${cal.sabados} sábados e ${cal.domingos} domingos (nos meses da média: ${String(cal.mediaSextas).replace('.', ',')}, ${String(cal.mediaSabados).replace('.', ',')} e ${String(cal.mediaDomingos).replace('.', ',')}). Pelo peso de cada dia da semana nas suas vendas, espere cerca de ${cal.pct > 0 ? '+' : ''}${String(cal.pct).replace('.', ',')}% no fechamento só por causa do calendário.`);
  }

  return {
    mes, nome: nomeMes(mes), modo, base: 'pagamento' as const, emCurso, diaHoje, diasNoMes: nDias,
    linhas: { atual: { pontos: atualCurva }, passado, media3, media6, anoAnterior },
    resumo, projecao: proj, calendario: cal, avisos, faltam,
    fechados, diaSemanaFechado, inicioUso,
  };
}
