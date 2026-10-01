import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../../api';
import { Spinner } from '../../components/ui';

/*
 * RITMO DO MÊS — receita acumulada dia a dia do mês, comparada com os meses anteriores no MESMO dia.
 * Todos os números vêm prontos do servidor (centavos inteiros); aqui só desenha.
 */

type Linha = { pontos: number[] };
type Resp = {
  mes: string; nome: string; modo: 'liquido' | 'bruto'; emCurso: boolean; diaHoje: number; diasNoMes: number;
  linhas: {
    atual: Linha;
    passado: (Linha & { mes: string; nome: string }) | null;
    media3: (Linha & { meses: string[] }) | null;
    media6: (Linha & { meses: string[]; min: number[]; max: number[] }) | null;
    anoAnterior: (Linha & { mes: string; nome: string }) | null;
  };
  resumo: { dia: number; valor: number; vsPassado: number | null; vsMedia3: number | null; mesesMedia3: number };
  projecao: { ok: true; centro: number; min: number; max: number; fracao: number; meses: number } | { ok: false; motivo: string };
  avisos: string[]; faltam: { linha: string; texto: string }[];
  fechados: { dia: number; motivo: string }[]; diaSemanaFechado: number[];
};

type Chave = 'atual' | 'passado' | 'media3' | 'media6' | 'anoAnterior';
const ORDEM: Chave[] = ['atual', 'passado', 'media3', 'media6', 'anoAnterior'];
// cor + traço: nenhuma linha depende só da cor
const ESTILO: Record<Chave, { cor: string; largura: number; traco?: string; rotulo: string }> = {
  atual: { cor: 'var(--chart-atual)', largura: 3, rotulo: 'Mês atual' },
  passado: { cor: 'var(--chart-passado)', largura: 1.75, rotulo: 'Mês passado' },
  media3: { cor: 'var(--chart-media)', largura: 2.25, rotulo: 'Média 3 meses' },
  media6: { cor: 'var(--chart-media)', largura: 1.5, traco: '5 4', rotulo: 'Média 6 meses' },
  anoAnterior: { cor: 'var(--chart-ano)', largura: 1.75, traco: '9 4 2 4', rotulo: 'Mesmo mês do ano anterior' },
};
const DIAS_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/** "R$ 9,7 mil" · "R$ 850" · "R$ 120 mil" (cents inteiros → texto). */
export function brlMil(cents: number) {
  const reais = cents / 100;
  if (Math.abs(reais) < 1000) return `R$ ${Math.round(reais).toLocaleString('pt-BR')}`;
  const mil = reais / 1000;
  return `R$ ${mil.toLocaleString('pt-BR', { maximumFractionDigits: Math.abs(mil) < 100 ? 1 : 0 })} mil`;
}
const brlCheio = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const pctTxt = (v: number | null) => (v == null ? null : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`);

/** Passo "redondo" do eixo Y (1, 2, 2,5, 5 × 10^n reais). */
function passoBonito(maxCents: number, alvo = 4) {
  const bruto = maxCents / alvo;
  const pot = 10 ** Math.floor(Math.log10(Math.max(bruto, 100)));
  for (const f of [1, 2, 2.5, 5, 10]) if (f * pot >= bruto) return f * pot;
  return 10 * pot;
}

function useLargura() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return { ref, w };
}

export default function RitmoMes() {
  const [modo, setModo] = useState<'liquido' | 'bruto'>('liquido');
  const { data, isLoading, error } = useQuery({
    queryKey: ['finance', 'ritmo', modo],
    queryFn: () => api.get<Resp>(`/api/finance/ritmo${qs({ modo })}`),
  });
  const celular = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 720px)').matches;
  const [ligadas, setLigadas] = useState<Record<Chave, boolean>>(() =>
    Object.fromEntries(ORDEM.map((k, i) => [k, !celular || i < 3])) as Record<Chave, boolean>);

  if (isLoading) return <Spinner />;
  if (error || !data) return <div className="card muted">Não foi possível carregar o ritmo do mês.</div>;
  const disponivel = (k: Chave) => (k === 'atual' ? true : !!data.linhas[k]);
  const temAlgo = data.resumo.valor > 0 || ORDEM.some((k) => k !== 'atual' && disponivel(k));

  return (
    <div className="col gap-lg ritmo">
      <div className="row between wrap" style={{ gap: 12 }}>
        <div>
          <div className="small muted">Ritmo de {data.nome}</div>
          <div className="ritmo-resumo">
            <b>Dia {data.resumo.dia}: {brlMil(data.resumo.valor)}</b>
            {pctTxt(data.resumo.vsPassado) && <span> · <Delta v={data.resumo.vsPassado!} /> vs mês passado</span>}
            {pctTxt(data.resumo.vsMedia3) && <span> · <Delta v={data.resumo.vsMedia3!} /> vs média {data.resumo.mesesMedia3 < 3 ? `de ${data.resumo.mesesMedia3} meses` : '3 meses'}</span>}
          </div>
        </div>
        <div className="seg" role="radiogroup" aria-label="Bruto ou líquido">
          <button role="radio" aria-checked={modo === 'liquido'} className={modo === 'liquido' ? 'on' : ''} onClick={() => setModo('liquido')}>Líquido</button>
          <button role="radio" aria-checked={modo === 'bruto'} className={modo === 'bruto' ? 'on' : ''} onClick={() => setModo('bruto')}>Bruto</button>
        </div>
      </div>

      <div className="grid-ritmo">
        <div className="card ritmo-proj">
          <div className="label">Projeção de fechamento</div>
          {data.projecao.ok ? <>
            <div className="value num">{brlMil(data.projecao.min)} a {brlMil(data.projecao.max)}</div>
            <div className="small muted">
              Projeção, não promessa: até o dia {data.diaHoje} você costuma ter vendido {Math.round(data.projecao.fracao * 100)}% do mês
              (média de {data.projecao.meses} {data.projecao.meses === 1 ? 'mês' : 'meses'}). Ponto central: {brlMil(data.projecao.centro)}.
            </div>
          </> : <div className="small muted" style={{ marginTop: 6 }}>{data.projecao.motivo}</div>}
        </div>
        <div className="card ritmo-nota small muted">
          Conta o dinheiro <b>recebido</b>, pelo <b>dia do pagamento</b> (horário de Brasília). {modo === 'liquido'
            ? 'Líquido: o que entrou de fato — desconto, cancelamento e estorno nunca entram.'
            : 'Bruto: recebido + descontos dados no dia (cancelados e estornados ficam fora).'} Por isso pode diferir do
          Resultado, que conta pela data do pedido.
        </div>
      </div>

      {data.avisos.map((a) => <div key={a} className="info-box small">📅 {a}</div>)}

      {!temAlgo ? (
        <div className="card">
          <b>Ainda não há vendas recebidas para comparar.</b>
          <div className="small muted mt">Assim que o caixa receber o primeiro pagamento do mês, a linha do mês atual aparece aqui.</div>
        </div>
      ) : (
        <div className="card ritmo-card">
          <Grafico data={data} ligadas={ligadas} celular={!!celular} />
          <div className="ritmo-legenda" role="group" aria-label="Linhas do gráfico">
            {ORDEM.map((k) => (
              <button key={k} className={`ritmo-chave${ligadas[k] && disponivel(k) ? ' on' : ''}`} disabled={!disponivel(k)} aria-pressed={ligadas[k] && disponivel(k)}
                title={disponivel(k) ? (ligadas[k] ? 'Toque para esconder' : 'Toque para mostrar') : 'Ainda sem dados'}
                onClick={() => setLigadas((l) => ({ ...l, [k]: !l[k] }))}>
                <svg width="26" height="10" aria-hidden="true">
                  {k === 'media6' && <rect x="0" y="1" width="26" height="8" rx="2" fill="var(--chart-media)" opacity="0.14" />}
                  <line x1="1" x2="25" y1="5" y2="5" stroke={ESTILO[k].cor} strokeWidth={Math.min(ESTILO[k].largura, 3)} strokeDasharray={ESTILO[k].traco} strokeLinecap="round" />
                </svg>
                {k === 'media3' && data.linhas.media3 && data.linhas.media3.meses.length < 3 ? `Média ${data.linhas.media3.meses.length} meses` : ESTILO[k].rotulo}
              </button>
            ))}
          </div>
          {data.diaSemanaFechado.length > 0 && (
            <div className="small faint">Fecha {data.diaSemanaFechado.map((d) => `às ${DIAS_SEMANA[d]}s`).join(' e ')}: dia sem venda nesses dias não é ritmo ruim.</div>
          )}
        </div>
      )}

      {data.faltam.length > 0 && (
        <div className="card small">
          <b>O que falta para as outras linhas aparecerem</b>
          <ul className="ritmo-faltam">{data.faltam.map((f) => <li key={f.linha}>{f.texto}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
/** Nome curto para a dica do gráfico: "Outubro (atual)", "Setembro", "Média 3 meses", "Out/2025". */
function nomeCurto(k: Chave, d: Resp) {
  if (k === 'atual') return cap(d.nome.split(' ')[0]);
  if (k === 'passado') return cap(d.linhas.passado!.nome.split(' ')[0]);
  if (k === 'anoAnterior') { const [mes, , ano] = d.linhas.anoAnterior!.nome.split(' '); return `${cap(mes.slice(0, 3))}/${ano}`; }
  if (k === 'media3' && d.linhas.media3 && d.linhas.media3.meses.length < 3) return `Média ${d.linhas.media3.meses.length} meses`;
  return ESTILO[k].rotulo;
}

function Delta({ v }: { v: number }) {
  const cor = Math.abs(v) < 1 ? 'var(--muted)' : v > 0 ? 'var(--ok)' : 'var(--danger)';
  return <span className="num" style={{ color: cor, fontWeight: 800 }}>{v > 0 ? '▲ ' : v < 0 ? '▼ ' : ''}{pctTxt(v)}</span>;
}

function Grafico({ data, ligadas, celular }: { data: Resp; ligadas: Record<Chave, boolean>; celular: boolean }) {
  const { ref, w } = useLargura();
  const [foco, setFoco] = useState<number | null>(null);
  const H = celular ? 260 : 330;
  const m = { t: 14, r: celular ? 84 : 118, b: 30, l: celular ? 58 : 62 };
  const iw = Math.max(120, w - m.l - m.r), ih = H - m.t - m.b;
  const visiveis = ORDEM.filter((k) => ligadas[k] && (k === 'atual' || data.linhas[k]));
  const serie = (k: Chave) => (k === 'atual' ? data.linhas.atual.pontos : data.linhas[k]!.pontos);

  const maxY = useMemo(() => {
    let mx = 0;
    for (const k of visiveis) mx = Math.max(mx, ...serie(k));
    if (ligadas.media6 && data.linhas.media6) mx = Math.max(mx, ...data.linhas.media6.max);
    return Math.max(mx, 100_00);
  }, [visiveis.join(), data]);
  const passo = passoBonito(maxY);
  const topo = Math.ceil((maxY * 1.06) / passo) * passo;
  const x = (dia: number) => m.l + ((dia - 1) / 30) * iw;
  const y = (v: number) => m.t + ih - (v / topo) * ih;
  const caminho = (pts: number[]) => pts.map((v, i) => `${i ? 'L' : 'M'}${x(i + 1).toFixed(1)},${y(v).toFixed(1)}`).join('');

  // rótulos na ponta (mês atual na ponta da linha; os outros na margem direita, sem se sobrepor)
  const rotulos: { k: Chave; v: number; yy: number }[] = [];
  const naMargem = visiveis.filter((k) => k !== 'atual' && (!celular || k === 'media3'));
  for (const k of naMargem) rotulos.push({ k, v: serie(k)[30], yy: y(serie(k)[30]) });
  rotulos.sort((a, b) => a.yy - b.yy);
  for (let i = 1; i < rotulos.length; i++) if (rotulos[i].yy - rotulos[i - 1].yy < 16) rotulos[i].yy = rotulos[i - 1].yy + 16;
  const atualPts = data.linhas.atual.pontos;
  const ultimo = atualPts.length;

  const aoMover = (e: RPointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const dia = Math.round(((e.clientX - r.left) / r.width) * 30) + 1;
    setFoco(Math.min(31, Math.max(1, dia)));
  };
  const fechado = new Map(data.fechados.map((f) => [f.dia, f.motivo]));
  const ticksX = celular ? [1, 8, 15, 22, 29] : [1, 5, 10, 15, 20, 25, 31];

  return (
    <div ref={ref} className="ritmo-grafico" style={{ position: 'relative' }}>
      <svg width={w} height={H} role="img" aria-label={`Receita acumulada de ${data.nome} comparada com os meses anteriores`}>
        {/* grade e eixo Y em R$ mil */}
        {Array.from({ length: Math.floor(topo / passo) + 1 }, (_, i) => i * passo).map((v) => (
          <g key={v}>
            <line x1={m.l} x2={m.l + iw} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth={v === 0 ? 1.2 : 0.6} />
            <text x={m.l - 8} y={y(v) + 4} textAnchor="end" className="ritmo-eixo">{v === 0 ? 'R$ 0' : brlMil(v)}</text>
          </g>
        ))}
        {ticksX.map((d) => <text key={d} x={x(d)} y={H - 8} textAnchor="middle" className="ritmo-eixo">{d}</text>)}
        {/* dias fechados: marca discreta na base */}
        {[...fechado.keys()].map((d) => <rect key={d} x={x(d) - 3} y={m.t + ih - 4} width={6} height={4} rx={1} fill="var(--faint)"><title>Dia {d}: fechado ({fechado.get(d)})</title></rect>)}
        {/* faixa pior–melhor dos 6 meses */}
        {ligadas.media6 && data.linhas.media6 && (
          <path d={`${caminho(data.linhas.media6.max)}${data.linhas.media6.min.map((v, i) => `L${x(31 - i).toFixed(1)},${y(data.linhas.media6!.min[30 - i]).toFixed(1)}`).join('')}Z`}
            fill="var(--chart-media)" opacity="0.10" />
        )}
        {/* linhas de comparação (o mês atual por cima) */}
        {visiveis.filter((k) => k !== 'atual').map((k) => (
          <path key={k} d={caminho(serie(k))} fill="none" stroke={ESTILO[k].cor} strokeWidth={ESTILO[k].largura} strokeDasharray={ESTILO[k].traco}
            strokeLinejoin="round" strokeLinecap="round" opacity={k === 'media6' ? 0.75 : 1} />
        ))}
        {visiveis.includes('atual') && ultimo > 0 && <>
          <path d={`${caminho(atualPts)}L${x(ultimo).toFixed(1)},${y(0)}L${x(1)},${y(0)}Z`} fill="var(--chart-atual)" opacity="0.12" />
          <path d={caminho(atualPts)} fill="none" stroke="var(--chart-atual)" strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={x(ultimo)} cy={y(atualPts[ultimo - 1])} r={5} fill="var(--chart-atual)" stroke="var(--surface)" strokeWidth={2} />
          <g transform={`translate(${Math.min(x(ultimo) + 10, m.l + iw - 70)},${Math.max(y(atualPts[ultimo - 1]) - 12, m.t + 4)})`}>
            <rect x={-4} y={-13} width={celular ? 74 : 86} height={20} rx={6} fill="var(--surface)" opacity="0.92" />
            <text className="ritmo-ponta-atual">{brlMil(atualPts[ultimo - 1])}</text>
          </g>
        </>}
        {rotulos.map((r) => (
          <g key={r.k}>
            <line x1={m.l + iw + 2} x2={m.l + iw + 8} y1={y(r.v)} y2={r.yy} stroke={ESTILO[r.k].cor} strokeWidth={1} />
            {!celular && <line x1={m.l + iw + 11} x2={m.l + iw + 23} y1={r.yy} y2={r.yy} stroke={ESTILO[r.k].cor} strokeWidth={2} strokeDasharray={ESTILO[r.k].traco ? '3 2' : undefined} />}
            <text x={m.l + iw + (celular ? 12 : 27)} y={r.yy + 4} className="ritmo-ponta" fill={ESTILO[r.k].cor}>{celular ? brlMil(r.v).replace('R$ ', '') : brlMil(r.v)}</text>
          </g>
        ))}
        {/* hoje */}
        {data.emCurso && <line x1={x(data.diaHoje)} x2={x(data.diaHoje)} y1={m.t} y2={m.t + ih} stroke="var(--faint)" strokeDasharray="2 4" />}
        {/* foco do toque/mouse */}
        {foco != null && <>
          <line x1={x(foco)} x2={x(foco)} y1={m.t} y2={m.t + ih} stroke="var(--muted)" strokeWidth={1} />
          {visiveis.map((k) => { const v = serie(k)[foco - 1]; return v == null ? null : <circle key={k} cx={x(foco)} cy={y(v)} r={4} fill={ESTILO[k].cor} stroke="var(--surface)" strokeWidth={1.5} />; })}
        </>}
        <rect x={m.l} y={m.t} width={iw} height={ih} fill="transparent" style={{ touchAction: 'pan-y', cursor: 'crosshair' }}
          onPointerMove={aoMover} onPointerDown={aoMover} onPointerLeave={(e) => { if (e.pointerType === 'mouse') setFoco(null); }} />
      </svg>
      {foco != null && (
        <div className="ritmo-tip" style={{ left: Math.max(4, Math.min(x(foco) - 128, w - 260)), top: 6 }}>
          <div className="ritmo-tip-dia">Dia {foco}{fechado.has(foco) ? ` · fechado (${fechado.get(foco)})` : ''}</div>
          {visiveis.map((k) => {
            const v = serie(k)[foco - 1];
            if (v == null) return null;
            return (
              <div key={k} className="ritmo-tip-linha">
                <svg width="16" height="8" aria-hidden="true"><line x1="1" x2="15" y1="4" y2="4" stroke={ESTILO[k].cor} strokeWidth={2.5} strokeDasharray={ESTILO[k].traco} /></svg>
                <span className="ritmo-tip-nome">{nomeCurto(k, data)}</span>
                <b className="num">{brlCheio(v)}</b>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
