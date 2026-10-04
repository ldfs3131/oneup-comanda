import { useEffect, useRef, useState, type ReactNode } from 'react';
import { brl, pct } from '../../../format';
import type { Achado, AcaoPlano, Confianca, Destrava, ItemCardapio, Pacote, Pilar, Quadrante } from './tipos';

/*
 * Peças da Central de Análise e do relatório para imprimir. Tudo vem pronto do servidor.
 * Gráficos (skill de dataviz): cores só por token (--cat-1..4), UMA escala por gráfico, legenda com 2+ séries,
 * rótulos seletivos, toque/mouse mostra o valor, meses sem dados aparecem como "sem dados" (nunca zero).
 */

// ---------- formatos ----------
export const brl0 = (c: number) => `R$ ${Math.round(c / 100).toLocaleString('pt-BR')}`;
export const brlMil = (c: number) => { const r = c / 100; const s = r < 0 ? '−' : ''; return Math.abs(r) < 1000 ? `${s}R$ ${Math.abs(Math.round(r))}` : `${s}R$ ${(Math.abs(r) / 1000).toLocaleString('pt-BR', { maximumFractionDigits: Math.abs(r) < 100000 ? 1 : 0 })} mil`; };
const MESES_CURTOS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
export const mesCurto = (k: string) => `${MESES_CURTOS[Number(k.slice(5, 7)) - 1]}/${k.slice(2, 4)}`;
const CONF_TXT: Record<Confianca, string> = { BAIXA: 'confiança baixa', MEDIA: 'confiança média', ALTA: 'confiança alta' };
export const nivelTxt = (c: Confianca) => ({ BAIXA: 'baixa', MEDIA: 'média', ALTA: 'alta' })[c];
const CONF_TOM: Record<Confianca, string> = { BAIXA: 'warn', MEDIA: 'info', ALTA: 'ok' };
export const QUAD: Record<Quadrante, { nome: string; cor: string; dica: string }> = {
  ESTRELA: { nome: 'Estrela', cor: 'var(--cat-4)', dica: 'vende muito e com boa margem' },
  BURRO_DE_CARGA: { nome: 'Burro de carga', cor: 'var(--cat-3)', dica: 'vende muito com margem baixa' },
  QUEBRA_CABECA: { nome: 'Quebra-cabeça', cor: 'var(--cat-1)', dica: 'boa margem, vende pouco' },
  ABACAXI: { nome: 'Abacaxi', cor: 'var(--cat-2)', dica: 'vende pouco e margem baixa' },
};
const HORIZ: Record<string, string> = { CURTO: 'Curto prazo (até 30 dias)', MEDIO: 'Médio prazo (1 a 3 meses)', LONGO: 'Longo prazo (3 a 12 meses)' };
const SITU: Record<string, { txt: string; tom: string }> = { OK: { txt: 'ok', tom: 'ok' }, BAIXO: { txt: 'baixo', tom: 'warn' }, ZERADO: { txt: 'zerado', tom: 'danger' }, PARADO: { txt: 'parado', tom: 'info' }, SEM_GIRO: { txt: 'sem giro', tom: 'muted' } };

export function ConfBadge({ c }: { c: Confianca }) { return <span className={`badge ${CONF_TOM[c]}`}>{CONF_TXT[c]}</span>; }
export function Estimativa() { return <span className="badge warn">estimativa</span>; }

export function Secao({ n, titulo, sub, aviso, children, id }: { n?: number; titulo: string; sub?: ReactNode; aviso?: string | null; children: ReactNode; id?: string }) {
  return (
    <section className="an-secao" id={id}>
      <div className="an-secao-cab">
        <h2>{n != null && <span className="an-num">{n}</span>}{titulo}</h2>
        {sub && <div className="small muted">{sub}</div>}
      </div>
      {children}
      {aviso && <div className="small muted an-aviso">ⓘ {aviso}</div>}
    </section>
  );
}

/** Cartão de um achado: frase, número, amostra, confiança, ação e impacto (com a premissa). */
export function AchadoCard({ a, i, tom }: { a: Achado; i?: number; tom: 'neg' | 'pos' | 'neu' }) {
  return (
    <div className={`an-achado ${tom}`}>
      <div className="row between wrap" style={{ gap: 6 }}>
        <b className="an-achado-titulo">{i != null && <span className="an-rank">{i + 1}</span>}{a.titulo}</b>
        <ConfBadge c={a.confianca} />
      </div>
      <div className="an-achado-frase">{a.frase}</div>
      <div className="an-achado-num num">{a.numero}</div>
      <div className="small faint">Amostra: {a.amostra} · limiar: {a.limiar}</div>
      {a.acao && <div className="an-acao">👉 {a.acao}{a.dono ? <span className="faint"> · quem: {a.dono}</span> : null}</div>}
      {a.impacto && (
        <div className="an-impacto small">
          <Estimativa /> <b className="num">{a.impacto.tipo === 'LUCRO' ? `≈ ${brl0(a.impacto.centsMes)}/mês` : `≈ ${brl0(a.impacto.centsMes)} (uma vez)`}</b>
          <span className="muted"> — premissa: {a.impacto.premissa}</span>
        </div>
      )}
    </div>
  );
}

export function ListaAchados({ lista, tom, vazio }: { lista: Achado[]; tom: 'neg' | 'pos' | 'neu'; vazio: string }) {
  if (!lista.length) return <div className="card muted small">{vazio}</div>;
  return <div className="an-grade">{lista.map((a, i) => <AchadoCard key={a.id + a.codigo} a={a} i={i} tom={tom} />)}</div>;
}

// ---------- dica do toque/mouse ----------
type TipState = { x: number; y: number; linhas: string[] } | null;
function useTip() {
  const [tip, setTip] = useState<TipState>(null);
  const ref = useRef<HTMLDivElement>(null);
  const mostrar = (e: { clientX: number; clientY: number }, linhas: string[]) => {
    const r = ref.current?.getBoundingClientRect(); if (!r) return;
    setTip({ x: e.clientX - r.left, y: e.clientY - r.top, linhas });
  };
  const el = tip && (
    <div className="an-tip" role="status" style={{ left: Math.max(4, Math.min(tip.x + 10, (ref.current?.clientWidth ?? 300) - 210)), top: Math.max(0, tip.y - 52) }}>
      {tip.linhas.map((l, i) => <div key={i} className={i === 0 ? 'an-tip-t' : ''}>{l}</div>)}
    </div>
  );
  return { ref, mostrar, esconder: () => setTip(null), el };
}
function useLargura(ref: React.RefObject<HTMLDivElement | null>, inicial = 640) {
  const [w, setW] = useState(inicial);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(ref.current); return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** Notas dos 6 pilares (0–100): barras horizontais, uma série, rótulo no fim de cada barra. */
export function GraficoPilares({ pilares }: { pilares: Pilar[] }) {
  const t = useTip();
  return (
    <div ref={t.ref} className="an-pilares" style={{ position: 'relative' }} onPointerLeave={t.esconder}>
      {pilares.map((p) => (
        <div key={p.id} className="an-pilar">
          <div className="an-pilar-nome">{p.nome}</div>
          <div className="an-pilar-trilho" role="img" aria-label={`${p.nome}: ${p.nota == null ? 'sem dados' : `${p.nota} de 100`}`}
            onPointerDown={(e) => t.mostrar(e, [p.nome, p.nota == null ? 'sem dados' : `${p.nota}/100`, p.numero])}
            onPointerMove={(e) => e.pointerType === 'mouse' && t.mostrar(e, [p.nome, p.nota == null ? 'sem dados' : `${p.nota}/100`, p.numero])}>
            {p.nota != null && <div className="an-pilar-barra" style={{ width: `${Math.max(2, p.nota)}%` }} />}
            <span className="an-pilar-val num">{p.nota == null ? 'sem dados' : p.nota}
              {p.variacao != null && p.variacao !== 0 && <span className={p.variacao > 0 ? 'an-up' : 'an-down'}> {p.variacao > 0 ? '▲' : '▼'}{Math.abs(p.variacao)}</span>}
            </span>
          </div>
          <div className="small muted an-pilar-num">{p.numero}</div>
          <div className="small an-pilar-sub">Para subir: {p.comoSubir}</div>
        </div>
      ))}
      {t.el}
    </div>
  );
}

/** 12 meses: receita e resultado lado a lado, mesma escala em R$, meses sem dados marcados. */
export function GraficoMeses({ serie }: { serie: Pacote['serie12'] }) {
  const t = useTip();
  const w = useLargura(t.ref);
  const H = 220, m = { t: 12, r: 8, b: 28, l: 70 };
  const iw = w - m.l - m.r, ih = H - m.t - m.b;
  const vals = serie.flatMap((s) => [s.receita, s.lucro]).filter((v): v is number => v != null);
  const max = Math.max(100_00, ...vals), min = Math.min(0, ...vals);
  const passo = (() => { const bruto = (max - min) / 4; const pot = 10 ** Math.floor(Math.log10(Math.max(bruto, 100))); for (const f of [1, 2, 2.5, 5, 10]) if (f * pot >= bruto) return f * pot; return 10 * pot; })();
  const topo = Math.ceil(max / passo) * passo, piso = Math.floor(min / passo) * passo;
  const y = (v: number) => m.t + ih - ((v - piso) / (topo - piso)) * ih;
  const bw = iw / serie.length, barra = Math.max(3, Math.min(18, bw / 2 - 3));
  const ticks: number[] = []; for (let v = piso; v <= topo + 1; v += passo) ticks.push(v);
  return (
    <div ref={t.ref} style={{ position: 'relative' }} onPointerLeave={t.esconder}>
      <svg width={w} height={H} role="img" aria-label="Receita e resultado dos últimos 12 meses">
        {ticks.map((v) => <g key={v}><line x1={m.l} x2={m.l + iw} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth={v === 0 ? 1.2 : 0.6} /><text x={m.l - 6} y={y(v) + 4} textAnchor="end" className="an-eixo">{v === 0 ? 'R$ 0' : brlMil(v)}</text></g>)}
        {serie.map((s, i) => {
          const cx = m.l + bw * i + bw / 2;
          const sem = s.receita == null;
          const linhas = [mesCurto(s.mes), sem ? 'sem dados' : `Receita: ${brl(s.receita!)}`, ...(sem ? [] : [s.lucro == null ? 'Resultado: sem custo suficiente' : `Resultado: ${brl(s.lucro)}`])];
          return (
            <g key={s.mes} onPointerDown={(e) => t.mostrar(e, linhas)} onPointerMove={(e) => e.pointerType === 'mouse' && t.mostrar(e, linhas)}>
              <rect x={m.l + bw * i} y={m.t} width={bw} height={ih} fill="transparent" />
              {sem ? <text x={cx} y={y(0) - 6} textAnchor="middle" className="an-eixo">—</text> : <>
                <rect x={cx - barra - 1} y={y(Math.max(0, s.receita!))} width={barra} height={Math.max(1, Math.abs(y(0) - y(s.receita!)))} rx={3} fill="var(--cat-1)" />
                {s.lucro != null && <rect x={cx + 1} y={s.lucro >= 0 ? y(s.lucro) : y(0)} width={barra} height={Math.max(1, Math.abs(y(0) - y(s.lucro)))} rx={3} fill="var(--cat-2)" />}
              </>}
              {(i % (w < 480 ? 2 : 1) === 0 || i === serie.length - 1) && <text x={cx} y={H - 8} textAnchor="middle" className="an-eixo">{mesCurto(s.mes)}</text>}
            </g>
          );
        })}
      </svg>
      <div className="an-legenda"><span><i style={{ background: 'var(--cat-1)' }} />Receita</span><span><i style={{ background: 'var(--cat-2)' }} />Resultado (lucro)</span><span className="faint">— = sem dados</span></div>
      {t.el}
    </div>
  );
}

/** Matriz popularidade × margem (engenharia de cardápio). */
export function MatrizCardapio({ itens, corte, meta }: { itens: ItemCardapio[]; corte: number; meta: number }) {
  const t = useTip();
  const w = useLargura(t.ref);
  const H = Math.min(360, Math.max(260, w * 0.6)), m = { t: 14, r: 14, b: 34, l: 48 };
  const iw = w - m.l - m.r, ih = H - m.t - m.b;
  const maxQ = Math.max(corte * 2, ...itens.map((i) => i.qtd)) * 1.08;
  const minM = Math.min(0, ...itens.map((i) => i.margem)), maxM = Math.max(1, ...itens.map((i) => i.margem));
  const x = (q: number) => m.l + (q / maxQ) * iw;
  const y = (mg: number) => m.t + ih - ((mg - minM) / (maxM - minM)) * ih;
  // rótulos seletivos: os que mais lucram, pulando os que encostariam num rótulo já colocado
  const rotular = new Set<number>(); const postos: { x: number; y: number }[] = [];
  for (const i of [...itens].sort((a, b) => b.lucro - a.lucro)) {
    if (rotular.size >= (w < 480 ? 3 : 6)) break;
    const px = x(i.qtd), py = y(i.margem);
    if (postos.some((q) => Math.abs(q.y - py) < 14 && Math.abs(q.x - px) < 110)) continue;
    rotular.add(i.id); postos.push({ x: px, y: py });
  }
  return (
    <div ref={t.ref} style={{ position: 'relative' }} onPointerLeave={t.esconder}>
      <svg width={w} height={H} role="img" aria-label="Matriz de engenharia de cardápio: popularidade por margem">
        {[0, 0.25, 0.5, 0.75, 1].filter((v) => v >= minM && v <= maxM).map((v) => <g key={v}><line x1={m.l} x2={m.l + iw} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth={0.6} /><text x={m.l - 6} y={y(v) + 4} textAnchor="end" className="an-eixo">{pct(v)}</text></g>)}
        <line x1={x(corte)} x2={x(corte)} y1={m.t} y2={m.t + ih} stroke="var(--muted)" strokeDasharray="4 4" />
        <line x1={m.l} x2={m.l + iw} y1={y(meta)} y2={y(meta)} stroke="var(--muted)" strokeDasharray="4 4" />
        <text x={m.l + iw - 4} y={y(meta) - 5} textAnchor="end" className="an-eixo">meta {pct(meta)}</text>
        <text x={x(corte) + 4} y={m.t + 10} className="an-eixo">popular →</text>
        <text x={m.l + iw / 2} y={H - 6} textAnchor="middle" className="an-eixo">unidades vendidas no mês</text>
        {itens.map((i) => {
          const linhas = [i.name, `${QUAD[i.quadrante].nome}: ${QUAD[i.quadrante].dica}`, `${i.qtd} un. · margem ${pct(i.margem)} · lucro ${brl(i.lucro)}`];
          return (
            <g key={i.id} onPointerDown={(e) => t.mostrar(e, linhas)} onPointerMove={(e) => e.pointerType === 'mouse' && t.mostrar(e, linhas)}>
              <circle cx={x(i.qtd)} cy={y(i.margem)} r={14} fill="transparent" />
              <circle cx={x(i.qtd)} cy={y(i.margem)} r={6} fill={QUAD[i.quadrante].cor} stroke="var(--surface)" strokeWidth={2} />
              {rotular.has(i.id) && <text x={x(i.qtd) + 9} y={y(i.margem) + 4} className="an-rotulo">{i.name.length > 18 ? i.name.slice(0, 17) + '…' : i.name}</text>}
            </g>
          );
        })}
      </svg>
      <div className="an-legenda">{(Object.keys(QUAD) as Quadrante[]).map((q) => <span key={q}><i style={{ background: QUAD[q].cor, borderRadius: '50%' }} />{QUAD[q].nome}</span>)}</div>
      {t.el}
    </div>
  );
}

/** Barras do "dinheiro na mesa" (uma série; valor considerado após o desconto pela confiança). */
export function BarrasMesa({ itens }: { itens: Pacote['dinheiroNaMesa']['itens'] }) {
  const t = useTip();
  const max = Math.max(1, ...itens.map((i) => i.centsMes));
  return (
    <div ref={t.ref} className="an-mesa-barras" style={{ position: 'relative' }} onPointerLeave={t.esconder}>
      {itens.map((i) => {
        const linhas = [i.titulo, `Estimado: ${brl0(i.centsMes)}/mês`, `Considerado (confiança ${nivelTxt(i.confianca)}): ${brl0(i.considerado)}/mês`, `Premissa: ${i.premissa}`];
        return (
          <div key={i.id + i.codigo} className="an-mesa-linha" onPointerDown={(e) => t.mostrar(e, linhas)} onPointerMove={(e) => e.pointerType === 'mouse' && t.mostrar(e, linhas)}>
            <div className="an-mesa-nome small">{i.titulo}</div>
            <div className="an-mesa-trilho">
              <div className="an-mesa-cheia" style={{ width: `${(i.centsMes / max) * 100}%` }} />
              <div className="an-mesa-conta" style={{ width: `${(i.considerado / max) * 100}%` }} />
            </div>
            <div className="num small an-mesa-val">{brl0(i.considerado)}</div>
          </div>
        );
      })}
      <div className="an-legenda"><span><i style={{ background: 'var(--cat-4)' }} />Considerado na soma</span><span><i style={{ background: 'color-mix(in srgb, var(--cat-4) 30%, transparent)' }} />Estimado antes do desconto pela confiança</span></div>
      {t.el}
    </div>
  );
}

export function Destravas({ d }: { d: Pacote['destravas'] }) {
  return (
    <div className="an-horizontes">
      {(['CURTO', 'MEDIO', 'LONGO'] as const).map((h) => (
        <div key={h} className="card an-horizonte">
          <b>{HORIZ[h]}</b>
          {d[h].length === 0 ? <div className="small muted mt">Nenhuma destrava com dados suficientes neste horizonte.</div> : (
            <ol className="an-lista">{d[h].map((x: Destrava) => (
              <li key={x.codigo}>
                <div>{x.acao}</div>
                <div className="small muted">{x.porque}</div>
                {x.impacto && <div className="small"><Estimativa /> <b className="num">≈ {brl0(x.impacto.centsMes)}{x.impacto.tipo === 'LUCRO' ? '/mês' : ' (uma vez)'}</b></div>}
              </li>
            ))}</ol>
          )}
        </div>
      ))}
    </div>
  );
}

export function Tecnicas({ t }: { t: Pacote['tecnicas'] }) {
  if (!t.length) return <div className="card muted small">Nenhuma técnica indicada: não há achado negativo com amostra suficiente.</div>;
  return (
    <div className="an-grade">{t.map((x) => (
      <div key={x.id} className="card an-tecnica">
        <b>{x.nome}</b>
        <div className="small muted">Para {x.para}.</div>
        <div className="small mt">Por causa de: {x.achados.map((a) => a.titulo).join(' · ')}</div>
        <ol className="an-lista small">{x.passos.map((p) => <li key={p}>{p}</li>)}</ol>
      </div>
    ))}</div>
  );
}

export function Plano({ plano }: { plano: AcaoPlano[] }) {
  if (!plano.length) return <div className="card muted small">Sem ações: nenhum achado com amostra suficiente pede ação neste mês.</div>;
  return (
    <div className="table-wrap card tight">
      <table className="table">
        <thead><tr><th>Semana</th><th>Ação</th><th>Meta mensurável</th><th className="right">Esperado</th></tr></thead>
        <tbody>{plano.map((a) => (
          <tr key={a.id}>
            <td className="num">{a.semana}</td>
            <td>{a.texto}{a.dono && <div className="small faint">quem: {a.dono}</div>}</td>
            <td className="small">{a.meta}</td>
            <td className="right small">{a.esperadoCents ? <><b className="num">+{brl0(a.esperadoCents)}/mês</b><div className="faint">estimativa</div></> : '—'}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export function PlanoAnterior({ r }: { r: Pacote['resultadoPlanoAnterior'] }) {
  if (!r.existe) return <div className="card muted small">{r.texto}</div>;
  const ST: Record<string, string> = { FEITO: '✔ feito', NAO_FEITO: '✘ não feito', PENDENTE: '… sem resposta' };
  return (
    <div className="card col">
      <div className="small muted">{r.texto}</div>
      {r.itens.map((i) => (
        <div key={i.id} className="an-plano-ant">
          <span className={`badge ${i.status === 'FEITO' ? 'ok' : i.status === 'NAO_FEITO' ? 'danger' : ''}`}>{ST[i.status] ?? i.status}</span>
          <div className="grow"><div>{i.texto}</div><div className="small muted">Efeito medido: {i.efeito}</div></div>
        </div>
      ))}
    </div>
  );
}

export function VendeLucra({ p }: { p: Pacote }) {
  const tag = (q: Quadrante | null) => (q ? <span className="an-quad" style={{ borderColor: QUAD[q].cor }}><i style={{ background: QUAD[q].cor }} />{QUAD[q].nome}</span> : <span className="small faint">sem custo</span>);
  const linha = (k: string, nome: string, valor: ReactNode, q: Quadrante | null, leitura: string) => (
    <div key={k} className="an-vl">
      <div className="row between" style={{ gap: 8 }}><b>{nome}</b><span className="num">{valor}</span></div>
      <div className="row wrap small" style={{ gap: 6 }}>{tag(q)}<span className="muted">{leitura}</span></div>
    </div>
  );
  return (
    <div className="grid-2">
      <div className="card tight col"><b>O que mais VENDE</b>{p.maisVende.map((x) => linha(x.name, x.name, `${x.qtd} un.`, x.quadrante, x.leitura))}</div>
      <div className="card tight col"><b>O que mais LUCRA</b>
        {p.maisLucra.length ? p.maisLucra.map((x) => linha(x.name, x.name, <>{brl(x.lucro)} <span className="faint small">{pct(x.margem)}</span></>, x.quadrante, x.leitura)) : <div className="small muted mt">Sem produtos com custo cadastrado.</div>}
      </div>
    </div>
  );
}

export function Cardapio({ p }: { p: Pacote }) {
  const c = p.cardapio;
  return (
    <div className="col gap-lg">
      {c.itens.length && c.corteQtd != null ? <div className="card"><MatrizCardapio itens={c.itens} corte={c.corteQtd} meta={c.metaMargem} /></div> : null}
      <div className="small muted">{c.regra}</div>
      {c.itens.length > 0 && (
        <div className="table-wrap card tight">
          <table className="table small">
            <thead><tr><th>Produto</th><th>Quadrante</th><th className="right">Vendidos</th><th className="right">Margem</th><th className="right hide-mobile">Lucro</th><th className="hide-mobile">Decisão</th></tr></thead>
            <tbody>{c.itens.map((i) => <tr key={i.id}><td>{i.name}</td><td><span className="an-quad" style={{ borderColor: QUAD[i.quadrante].cor }}><i style={{ background: QUAD[i.quadrante].cor }} />{QUAD[i.quadrante].nome}</span></td><td className="right num">{i.qtd}</td><td className="right num">{pct(i.margem)}</td><td className="right num hide-mobile">{brl(i.lucro)}</td><td className="hide-mobile">{i.acao}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {c.semCusto.length > 0 && <div className="card small"><b>Fora da matriz (sem custo cadastrado):</b> {c.semCusto.map((s) => `${s.name} (${s.qtd} un.)`).join(', ')}</div>}
    </div>
  );
}

export function Estoque({ e }: { e: Pacote['estoque'] }) {
  if (!e.controlados) return <div className="card muted small">Nenhum produto com estoque controlado. Ligue o controle nos itens comprados prontos (bebidas, por exemplo) para ver cobertura, ruptura e capital parado.</div>;
  return (
    <div className="col gap-lg">
      <div className="table-wrap card tight">
        <b>Cobertura em dias (meta: {e.cobertura[0]?.meta ?? 7} dias)</b>
        <table className="table small"><thead><tr><th>Produto</th><th className="right">Em estoque</th><th className="right">Venda/dia</th><th className="right">Dura</th><th>Situação</th></tr></thead>
          <tbody>{e.cobertura.map((c) => <tr key={c.name}><td>{c.name}</td><td className="right num">{c.qtd}</td><td className="right num">{String(c.porDia).replace('.', ',')}</td><td className="right num">{c.dias == null ? '—' : `${c.dias} dias`}</td><td><span className={`badge ${SITU[c.situacao]?.tom ?? ''}`}>{SITU[c.situacao]?.txt ?? c.situacao}</span></td></tr>)}</tbody>
        </table>
      </div>
      <div className="grid-2">
        <div className="card small"><b>Ruptura (dias zerado sem vender)</b>
          {e.rupturas.length ? <ul className="an-lista">{e.rupturas.map((r) => <li key={r.id}>{r.name}: {r.diasZero} dia(s)</li>)}</ul> : <div className="muted mt">Nenhum dia de ruptura.</div>}
        </div>
        <div className="card small"><b>Perdas por motivo ({brl(e.perdasCents)})</b>
          {e.perdasPorMotivo.length ? <ul className="an-lista">{e.perdasPorMotivo.map((p) => <li key={p.motivo}>{p.motivo}: {brl(p.cents)} ({p.qtd} un.)</li>)}</ul> : <div className="muted mt">Nenhuma perda registrada.</div>}
        </div>
        <div className="card small"><b>Variação de custo por fornecedor (90 dias)</b>
          {e.custoFornecedor.length ? <ul className="an-lista">{e.custoFornecedor.map((f) => <li key={f.produto + f.fornecedor}>{f.produto} · {f.fornecedor}: {brl(f.primeiro)} → {brl(f.ultimo)} ({f.variacao >= 0 ? '+' : '−'}{pct(Math.abs(f.variacao))})</li>)}</ul> : <div className="muted mt">Sem entradas com fornecedor e custo repetidas.</div>}
        </div>
        <div className="card small"><b>Compra sugerida</b>
          {e.compraSugerida.length ? <ul className="an-lista">{e.compraSugerida.map((c) => <li key={c.name}>{c.name}: <b>{c.comprar} un.</b> <span className="faint">({c.conta})</span></li>)}</ul> : <div className="muted mt">Nada a comprar pela meta de dias.</div>}
          {e.divergencias.length > 0 && <div className="mt"><b>Vendido sem estoque:</b> {e.divergencias.map((d) => `${d.name} (${d.vezes}×)`).join(', ')}</div>}
        </div>
      </div>
    </div>
  );
}

export function ClientesFiado({ c }: { c: Pacote['clientesFiado'] }) {
  const f = c.fiado;
  return (
    <div className="col gap-lg">
      <div className="tiles">
        <div className="tile"><div className="label">Clientes identificados</div><div className="value">{c.clientes.identificados}</div><div className="sub">{c.clientes.recorrentes} recorrentes · {c.clientes.novos} novos</div></div>
        <div className="tile"><div className="label">Aceitaram ofertas</div><div className="value">{c.clientes.comConsentimento}</div><div className="sub">base para reativação</div></div>
        <div className="tile"><div className="label">Fiado em aberto</div><div className="value">{brl0(f.totalCents)}</div><div className="sub">{f.contas} contas</div></div>
        <div className="tile"><div className="label">Vencido</div><div className="value">{brl0(f.vencidoCents)}</div><div className="sub">{f.vencidas} contas · {f.promessasVencidas} promessas vencidas</div></div>
        <div className="tile"><div className="label">Prazo médio de recebimento</div><div className="value">{f.prazoMedioDias == null ? '—' : `${f.prazoMedioDias.toFixed(1).replace('.', ',')} dias`}</div><div className="sub">contas pagas em 90 dias</div></div>
        <div className="tile"><div className="label">Inadimplência (30+ dias)</div><div className="value">{f.inadimplenciaPct == null ? '—' : pct(f.inadimplenciaPct)}</div><div className="sub">{f.concentracao80 != null ? `${f.concentracao80} de ${f.clientesComFiado} clientes = 80% do fiado` : 'sem fiado'}</div></div>
      </div>
      {f.contas > 0 && (
        <div className="card tight table-wrap"><b>Idade do fiado</b>
          <table className="table small"><tbody>{f.aging.map((a) => <tr key={a.faixa}><td>{a.faixa}</td><td className="right num">{a.contas} conta(s)</td><td className="right num">{brl(a.cents)}</td></tr>)}</tbody></table>
        </div>
      )}
      <div className="card"><b>Recuperação de vendas: por onde começar</b><ul className="an-lista">{c.recuperacao.map((r) => <li key={r}>{r}</li>)}</ul><div className="small faint">{c.aviso}</div></div>
    </div>
  );
}

export function Numeros({ p }: { p: Pacote }) {
  const f = (v: number | null, t: string) => (v == null ? 'sem dados' : t === 'BRL' ? brl(v) : t === 'PCT' ? pct(v, 1) : String(v));
  return (
    <div className="table-wrap card tight">
      <table className="table small">
        <thead><tr><th>Indicador</th><th className="right">{p.emCurso ? `Até o dia ${p.diaCorte}` : 'No mês'}</th><th className="right">{p.emCurso ? 'Mês anterior (mesmo período)' : 'Mês anterior'}</th></tr></thead>
        <tbody>{p.numeros.map((x) => <tr key={x.nome}><td>{x.nome}</td><td className="right num">{f(x.atual, x.tipo)}</td><td className="right num muted">{f(x.anterior, x.tipo)}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

export function Previsao({ p }: { p: Pacote['previsao'] }) {
  if (!p.ok) return <div className="card muted small">{p.motivo}</div>;
  return (
    <div className="card">
      <div className="label small muted">Previsão de {p.nome}</div>
      <div className="an-grande num">{brl0(p.faixa[0])} a {brl0(p.faixa[1])}</div>
      <div className="small">Ponto central {brl0(p.vendasCents)}{p.lucroCents != null ? ` · resultado ≈ ${brl0(p.lucroCents)}` : ''} <ConfBadge c={p.confianca} /></div>
      <div className="small muted mt">Conta: {p.conta}</div>
      <div className="small faint">{p.aviso}</div>
    </div>
  );
}

export function ConfiancaMetodo({ p, detalhes }: { p: Pacote; detalhes?: boolean }) {
  const c = p.confianca;
  const ST: Record<string, string> = { DISPAROU: 'disparou', NAO_DISPAROU: 'olhou, nada fora do limiar', AMOSTRA: 'abaixo da amostra mínima', SEM_DADOS: 'sem dados' };
  return (
    <div className="col gap-lg">
      <div className="card">
        <div className="row wrap" style={{ gap: 8 }}><b>Confiança dos dados:</b> <ConfBadge c={c.nivel} /> <span className="small muted">tempos da cozinha: {nivelTxt(c.nivelTempos)}</span></div>
        <div className="small mt">{c.motivos.join('; ')}.</div>
        {c.aviso && <div className="small an-alerta mt">{c.aviso}</div>}
        {c.comoMelhorar.length > 0 && <><div className="small mt"><b>O que melhora a confiança:</b></div><ul className="an-lista small">{c.comoMelhorar.map((x) => <li key={x}>{x}</li>)}</ul></>}
      </div>
      <div className="card small"><b>Metodologia</b><ul className="an-lista">{p.metodologia.map((m) => <li key={m}>{m}</li>)}</ul></div>
      {detalhes && (
        <div className="card tight table-wrap"><b>Detectores ({p.detectores.filter((d) => d.status === 'DISPAROU').length} dispararam de {p.detectores.length})</b>
          <table className="table small"><thead><tr><th>Detector</th><th>Limiar</th><th>Amostra mínima</th><th>Situação</th></tr></thead>
            <tbody>{p.detectores.map((d) => <tr key={d.id}><td><b>{d.id}</b> {d.nome}</td><td>{d.limiar}</td><td>{d.amostraMin}</td><td><span className={`badge ${d.status === 'DISPAROU' ? 'brand' : d.status === 'AMOSTRA' ? 'warn' : ''}`}>{ST[d.status]}</span></td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function NotaHero({ p }: { p: Pacote }) {
  const v = p.nota.valor;
  return (
    <div className="an-nota-hero">
      <div className="an-nota-num num">{v == null ? '—' : v}<span>/100</span></div>
      <div className="small">
        {v == null ? 'Sem dados suficientes para a nota.' : `Nota do restaurante (${p.nota.pilaresComNota} de 6 pilares com dados)`}
        {p.nota.variacao != null && <div className={p.nota.variacao >= 0 ? 'an-up' : 'an-down'}>{p.nota.variacao >= 0 ? '▲' : '▼'} {Math.abs(p.nota.variacao)} vs mês anterior ({p.nota.anterior})</div>}
      </div>
    </div>
  );
}

export function MesaHero({ p }: { p: Pacote }) {
  const d = p.dinheiroNaMesa;
  return (
    <div className="an-mesa-hero">
      <div className="small muted">Dinheiro na mesa</div>
      <div className="an-nota-num num">{d.lucroMesCents > 0 ? `≈ ${brl0(d.lucroMesCents)}` : '—'}<span>/mês</span></div>
      <div className="small"><Estimativa /> lucro extra possível por mês{d.caixaCents > 0 ? ` · + ${brl0(d.caixaCents)} a recuperar/liberar (uma vez)` : ''}</div>
    </div>
  );
}

/** Copia texto (com alternativa para navegador sem permissão de área de transferência). */
export async function copiar(texto: string) {
  try { await navigator.clipboard.writeText(texto); return true; } catch {
    const ta = document.createElement('textarea'); ta.value = texto; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}
