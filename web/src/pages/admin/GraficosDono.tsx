import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { brl, pct } from '../../format';
import { brlMil } from './RitmoMes';

/*
 * Gráficos do Financeiro do Dono — só números (sem projeção, média de meses, ranking nem interpretação).
 * Dados prontos de GET /api/finance/graficos (centavos inteiros).
 */
export type Graficos = {
  mes: { mes: string; mesPassado: string; diaHoje: number; diasNoMes: number; diasNoMesPassado: number; atual: number[]; passado: number[]; diasComVenda: number[] };
  semanas: { dia: string; vendido: number; contas: number }[];
  periodo: { dias: { dia: string; vendido: number; contas: number }[]; contas: number; vendido: number; gastoMedio: number | null };
  categorias: { nome: string; vendido: number; itens: number }[];
};

const nomeDoMes = (k: string) => new Intl.DateTimeFormat('pt-BR', { month: 'long', timeZone: 'UTC' }).format(new Date(k + '-15T12:00:00Z'));
const DS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const DS_LONGO = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const diaSemana = (iso: string) => new Date(iso + 'T12:00:00Z').getUTCDay();
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
// cor fixa por dia da semana (a cor segue o dia, nunca a posição)
const COR_DIA: Record<number, string> = { 5: 'var(--cat-1)', 6: 'var(--cat-2)', 0: 'var(--cat-4)' };
const corDia = (wd: number) => COR_DIA[wd] ?? 'var(--chart-passado)';

/** Escala "bonita" para o eixo: 4 linhas em valores redondos. */
function escalaRedonda(max: number) {
  if (max <= 0) return { topo: 100_00, passos: [0, 25_00, 50_00, 75_00, 100_00] };
  const bruto = max / 4;
  const mag = 10 ** Math.floor(Math.log10(bruto));
  const passo = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => k >= bruto) ?? 10 * mag;
  const topo = passo * Math.ceil(max / passo);
  const passos: number[] = [];
  for (let v = 0; v <= topo + 1; v += passo) passos.push(v);
  return { topo, passos };
}

/* ------------------------------------------------------------------------------------------------ */
/* 1. Acompanhamento do mês: vendido acumulado dia a dia, este mês × mês passado no mesmo dia         */
/* ------------------------------------------------------------------------------------------------ */
export function AcompanhamentoMes({ g }: { g: Graficos['mes'] }) {
  const svg = useRef<SVGSVGElement>(null);
  const caixa = useRef<HTMLDivElement>(null);
  const [foco, setFoco] = useState<number | null>(null);
  // desenha na largura real (texto sempre legível no celular)
  const [largura, setLargura] = useState(760);
  useEffect(() => {
    const el = caixa.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => setLargura(Math.max(300, Math.round(e.contentRect.width))));
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const estreito = largura < 560;
  const W = largura, H = estreito ? 230 : 260, L = estreito ? 50 : 64, R = estreito ? 74 : 128, T = 16, B = 30;
  const nX = Math.max(g.diasNoMes, g.diasNoMesPassado);
  const atualHoje = g.atual[g.diaHoje - 1] ?? 0;
  const passadoMesmoDia = g.passado[Math.min(g.diaHoje, g.passado.length) - 1] ?? 0;
  const passadoFechou = g.passado[g.passado.length - 1] ?? 0;
  const { topo, passos } = escalaRedonda(Math.max(atualHoje, passadoFechou, 1));
  const x = (d: number) => L + ((d - 1) / Math.max(1, nX - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - v / topo) * (H - T - B);
  const caminho = (pts: number[]) => pts.map((v, i) => `${i ? 'L' : 'M'}${x(i + 1).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = g.atual.length ? `${caminho(g.atual)} L${x(g.atual.length).toFixed(1)},${y(0)} L${x(1)},${y(0)} Z` : '';
  const varPct = passadoMesmoDia > 0 ? (atualHoje - passadoMesmoDia) / passadoMesmoDia : null;
  const mover = (e: RPointerEvent) => {
    const el = svg.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const d = Math.round(((px - L) / (W - L - R)) * (nX - 1)) + 1;
    setFoco(Math.max(1, Math.min(nX, d)));
  };
  const fA = foco != null ? g.atual[foco - 1] : undefined;
  const fP = foco != null ? g.passado[foco - 1] : undefined;
  const mesNome = nomeDoMes(g.mes), passNome = nomeDoMes(g.mesPassado);
  // rótulos da ponta direita sem encostar um no outro
  let yHoje = y(atualHoje), yFim = y(passadoFechou);
  if (Math.abs(yHoje - yFim) < 18) { if (yHoje <= yFim) yFim = yHoje + 18; else yHoje = yFim + 18; }
  return (
    <div className="card graf-mes">
      <div className="graf-topo">
        <div>
          <div className="panel-title" style={{ margin: 0 }}>Acompanhamento do mês · {mesNome}</div>
          <div className="graf-mes-num">
            Até o dia {g.diaHoje}: <b>{brl(atualHoje)}</b>
            {varPct != null
              ? <span className={`lucro-selo ${varPct >= 0 ? 'sobe' : 'desce'}`}>{varPct >= 0 ? '▲' : '▼'} {pct(Math.abs(varPct), 0)} <span className="lucro-selo-vs">vs {passNome} no mesmo dia ({brl(passadoMesmoDia)})</span></span>
              : <span className="small faint"> · sem vendas em {passNome} para comparar</span>}
          </div>
        </div>
        <div className="graf-legenda" aria-hidden="true">
          <span><i className="lg-linha atual" />{mesNome}</span>
          <span><i className="lg-linha passado" />{passNome}</span>
        </div>
      </div>
      <div className="graf-dica small" aria-live="polite">
        {foco != null
          ? <>Dia {foco}: <b>{fA != null ? brl(fA) : '—'}</b> em {mesNome} · {fP != null ? brl(fP) : '—'} em {passNome}</>
          : <span className="faint">Toque ou passe o mouse no gráfico para ver cada dia.</span>}
      </div>
      <div ref={caixa}>
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className="graf-svg" role="img"
        aria-label={`Vendido acumulado até o dia ${g.diaHoje}: ${brl(atualHoje)}; ${passNome} no mesmo dia: ${brl(passadoMesmoDia)}`}
        onPointerMove={mover} onPointerDown={mover} onPointerLeave={() => setFoco(null)}>
        {passos.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="graf-grade" />
            <text x={L - 8} y={y(v) + 4} textAnchor="end" className="graf-eixo">{brlMil(v)}</text>
          </g>
        ))}
        {(estreito ? [1, 10, 20, nX] : [1, 5, 10, 15, 20, 25, nX]).map((d) => <text key={d} x={x(d)} y={H - 8} textAnchor="middle" className="graf-eixo">{d}</text>)}
        <path d={caminho(g.passado)} className="graf-linha passado" />
        {area && <path d={area} className="graf-area" />}
        {g.atual.length > 0 && <path d={caminho(g.atual)} className="graf-linha atual" />}
        <line x1={x(g.diaHoje)} x2={x(g.diaHoje)} y1={T} y2={H - B} className="graf-hoje" />
        {g.passado.length >= g.diaHoje && <circle cx={x(g.diaHoje)} cy={y(passadoMesmoDia)} r={4} className="graf-ponto passado" />}
        <circle cx={x(g.diaHoje)} cy={y(atualHoje)} r={6} className="graf-ponto atual" />
        <text x={W - R + 8} y={yHoje + 4} className="graf-rot atual">{estreito ? brlMil(atualHoje).replace('R$ ', '') : `${brlMil(atualHoje)} hoje`}</text>
        <text x={W - R + 8} y={yFim + 4} className="graf-rot passado">{estreito ? brlMil(passadoFechou).replace('R$ ', '') : `${passNome.slice(0, 3)}: ${brlMil(passadoFechou)}`}</text>
        {foco != null && <line x1={x(foco)} x2={x(foco)} y1={T} y2={H - B} className="graf-cursor" />}
      </svg>
      </div>
      <div className="small faint">Vendido somado dia a dia (pela data do pedido). {passNome[0].toUpperCase() + passNome.slice(1)} fechou em {brl(passadoFechou)}.</div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* 2. Fim de semana a fim de semana: barras de cada dia aberto, agrupadas por semana (últimas 8)      */
/* ------------------------------------------------------------------------------------------------ */
export function FinsDeSemana({ dias }: { dias: Graficos['semanas'] }) {
  const [foco, setFoco] = useState<string | null>(null);
  if (!dias.length) return <div className="card"><div className="panel-title">Semana a semana</div><div className="muted small">Ainda não há vendas nas últimas semanas.</div></div>;
  // agrupa por semana (segunda a domingo)
  const semanaDe = (iso: string) => { const d = new Date(iso + 'T12:00:00Z'); return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400_000).toISOString().slice(0, 10); };
  const grupos = new Map<string, Graficos['semanas']>();
  for (const d of dias) { const k = semanaDe(d.dia); grupos.set(k, [...(grupos.get(k) ?? []), d]); }
  const semanas = [...grupos.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const dPresentes = [...new Set(dias.map((d) => diaSemana(d.dia)))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  const max = Math.max(...dias.map((d) => d.vendido), 1);
  const { topo } = escalaRedonda(max);
  const f = foco ? dias.find((d) => d.dia === foco) : null;
  return (
    <div className="card">
      <div className="graf-topo">
        <div className="panel-title" style={{ margin: 0 }}>Semana a semana</div>
        <div className="graf-legenda">{dPresentes.map((wd) => <span key={wd}><i className="legenda-cor" style={{ background: corDia(wd) }} />{DS_LONGO[wd]}</span>)}</div>
      </div>
      <div className="graf-dica small" aria-live="polite">
        {f ? <>{DS_LONGO[diaSemana(f.dia)]}, {ddmm(f.dia)}: <b>{brl(f.vendido)}</b> · {f.contas} {f.contas === 1 ? 'conta' : 'contas'}</>
          : <span className="faint">Cada grupo é uma semana; cada barra, um dia aberto. Toque numa barra.</span>}
      </div>
      <div className="semanas" role="table" aria-label="Vendido por dia nas últimas semanas">
        {semanas.map(([ini, ds]) => {
          const total = ds.reduce((s, d) => s + d.vendido, 0);
          return (
            <div key={ini} className="semana" role="row">
              <div className="semana-total num" role="cell" title={brl(total)}>{brlMil(total).replace('R$ ', '')}</div>
              <div className="semana-barras">
                {dPresentes.map((wd) => {
                  const d = ds.find((x) => diaSemana(x.dia) === wd);
                  return d
                    ? <button key={wd} type="button" className={`semana-barra${foco === d.dia ? ' on' : ''}`} style={{ height: `${Math.max(3, (d.vendido / topo) * 100)}%`, background: corDia(wd) }}
                        title={`${DS_LONGO[wd]} ${ddmm(d.dia)}: ${brl(d.vendido)}`} aria-label={`${DS_LONGO[wd]} ${ddmm(d.dia)}: ${brl(d.vendido)}`}
                        onClick={() => setFoco(foco === d.dia ? null : d.dia)} onPointerEnter={() => setFoco(d.dia)} />
                    : <span key={wd} className="semana-vazia" title={`${DS_LONGO[wd]}: sem venda`} />;
                })}
              </div>
              <div className="semana-rot" role="cell">{ddmm(ds[0].dia)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* 3. O que o cliente compra: vendido por categoria, na ordem do cardápio                             */
/* ------------------------------------------------------------------------------------------------ */
export function Categorias({ cats, vendido }: { cats: Graficos['categorias']; vendido: number }) {
  const lista = cats.filter((c) => c.vendido > 0);
  const max = Math.max(...lista.map((c) => c.vendido), 1);
  return (
    <div className="card">
      <div className="panel-title">O que o cliente compra · por categoria</div>
      {!lista.length ? <div className="muted small">Sem vendas no período.</div> : (
        <div className="cats">
          {lista.map((c) => (
            <div key={c.nome} className="cat-linha">
              <span className="cat-nome">{c.nome}<small>{c.itens} {c.itens === 1 ? 'item' : 'itens'}</small></span>
              <span className="cat-trilho" aria-hidden="true"><span style={{ width: `${(c.vendido / max) * 100}%` }} /></span>
              <span className="cat-val num">{brl(c.vendido)}<small>{pct(vendido > 0 ? c.vendido / vendido : 0, 0)}</small></span>
            </div>
          ))}
        </div>
      )}
      <div className="small faint mt">Na ordem do cardápio.</div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* 4. Cartão com mini gráfico (um ponto por dia com venda no período)                                 */
/* ------------------------------------------------------------------------------------------------ */
export function CartaoMini({ rotulo, valor, serie, dica }: { rotulo: string; valor: string; serie: number[]; dica?: string }) {
  const W = 120, H = 34;
  const max = Math.max(...serie, 1), min = Math.min(...serie, 0);
  const pts = serie.map((v, i) => `${serie.length === 1 ? W / 2 : (i / (serie.length - 1)) * W},${H - 3 - ((v - min) / Math.max(1, max - min)) * (H - 6)}`);
  return (
    <div className="tile cartao-mini">
      <div className="label">{rotulo}</div>
      <div className="value">{valor}</div>
      {serie.length > 1 && (
        <svg viewBox={`0 0 ${W} ${H}`} className="mini-svg" aria-hidden="true" preserveAspectRatio="none">
          <polyline points={pts.join(' ')} className="mini-linha" />
        </svg>
      )}
      {dica && <div className="small faint">{dica}</div>}
    </div>
  );
}
export { DS };
