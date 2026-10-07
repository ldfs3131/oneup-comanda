import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs, chaveDoEnvio, type ChaveEnvio } from '../../api';
import { addDaysISO, brl, dateOnly, fmtDay, pct, todayISO } from '../../format';
import { Badge, Modal, MoneyInput, ReasonModal, Spinner, useAction } from '../../components/ui';
import RitmoMes from './RitmoMes';
import { AcompanhamentoMes, CartaoMini, Categorias, FinsDeSemana, type Graficos } from './GraficosDono';

type Fin = {
  from: string; to: string; grossSalesCents: number; discountsCents: number; revenueCents: number; receivedCents: number;
  receivedByMethod: { name: string; code: string; cents: number; feesCents: number; taxaBp: number }[]; feesCents: number; netReceivedCents: number; pendingCents: number; openBalanceCents: number;
  costCents: number; costCoverage: number; grossProfitCents: number; grossMargin: number | null;
  expensesCents: number; expensesByCategory: { name: string; cents: number; count: number }[];
  lucroCents: number; margemLucro: number | null;
  semCusto: { name: string; qtd: number }[];
  tabela: { id: number | null; name: string; priceCents: number | null; costCents: number | null; margemPct: number | null; vendidos: number; semCustoVendidos: number; lucroCents: number | null }[];
  anterior: { from: string; to: string; lucroCents: number; vendidoCents: number; temDados: boolean };
  meses: { mes: string; vendidoCents: number | null; lucroCents: number | null }[] | null;
};
type Expense = { id: number; description: string; amountCents: number; date: string; note: string | null; paidFromRegister: boolean; cancelledAt: string | null; cancelReason: string | null; categoryName: string; userName: string };
type Cat = { id: number; name: string; active: boolean };
type Periodo = 'hoje' | '7d' | 'mes' | 'ano';

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const nomeMes = (m: string) => `${MESES[Number(m.slice(5, 7)) - 1]}/${m.slice(2, 4)}`;
const CORES = ['var(--cat-1)', 'var(--cat-2)', 'var(--cat-3)', 'var(--cat-4)'];

function rangeDe(p: Periodo) {
  const t = todayISO();
  if (p === 'hoje') return { from: t, to: t };
  if (p === '7d') return { from: addDaysISO(t, -6), to: t };
  if (p === 'mes') return { from: t.slice(0, 8) + '01', to: t };
  const d = new Date(t.slice(0, 8) + '01T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 11);
  return { from: d.toISOString().slice(0, 10), to: t, ano: '1' };
}

export default function FinancePage() {
  const [periodo, setPeriodo] = useState<Periodo>('mes');
  const oneup = !!useAuth().user?.oneup; // projeção e médias (Ritmo do mês) são leitura da ONE UP
  const range = rangeDe(periodo);
  const [tab, setTab] = useState<'resumo' | 'despesas' | 'produtos' | 'ritmo'>('resumo');
  const [newExp, setNewExp] = useState(false);
  const [cancel, setCancel] = useState<Expense | null>(null);
  const [custo, setCusto] = useState<Fin['tabela'][number] | null>(null);
  const { data: f, isLoading } = useQuery({ queryKey: ['finance', range], queryFn: () => api.get<Fin>(`/api/finance${qs(range)}`) });
  const { data: g } = useQuery({ queryKey: ['finance-graficos', range.from, range.to], queryFn: () => api.get<Graficos>(`/api/finance/graficos${qs({ from: range.from, to: range.to })}`) });
  const { data: exps = [] } = useQuery({ queryKey: ['expenses', range], queryFn: () => api.get<Expense[]>(`/api/expenses${qs({ from: range.from, to: range.to })}`) });
  const { run } = useAction();
  const qc = useQueryClient();
  const refresh = () => { qc.invalidateQueries({ queryKey: ['finance'] }); qc.invalidateQueries({ queryKey: ['expenses'] }); };
  const rotulo = { hoje: 'Hoje', '7d': 'Últimos 7 dias', mes: 'Este mês', ano: 'Últimos 12 meses' }[periodo];

  return (
    <div className="col gap-lg">
      <div className="row between wrap">
        <div>
          <h1>Financeiro</h1>
          <div className="muted small">{tab === 'ritmo' ? 'Vendas acumuladas do mês comparadas com os meses anteriores, no mesmo dia' : `${rotulo} · ${fmtDay(range.from)} a ${fmtDay(range.to)}`}</div>
        </div>
        {tab !== 'ritmo' && <div className="seg">
          {(['hoje', '7d', 'mes', 'ano'] as const).map((p) => <button key={p} className={periodo === p ? 'on' : ''} onClick={() => setPeriodo(p)}>{{ hoje: 'Hoje', '7d': '7 dias', mes: 'Mês', ano: 'Ano' }[p]}</button>)}
        </div>}
      </div>
      <div className="seg">
        <button className={tab === 'resumo' ? 'on' : ''} onClick={() => setTab('resumo')}>Resumo</button>
        <button className={tab === 'despesas' ? 'on' : ''} onClick={() => setTab('despesas')}>Despesas</button>
        <button className={tab === 'produtos' ? 'on' : ''} onClick={() => setTab('produtos')}>Produtos</button>
        {oneup && <button className={tab === 'ritmo' ? 'on' : ''} onClick={() => setTab('ritmo')}>Ritmo do mês</button>}
      </div>

      {tab === 'ritmo' && <RitmoMes />}

      {tab !== 'ritmo' && (isLoading || !f ? <Spinner /> : <>
        {f.semCusto.length > 0 && (tab === 'resumo' || tab === 'produtos') && (
          <div className="info-box small">⚠ {f.semCusto.length} produto(s) vendidos sem custo cadastrado ({f.semCusto.slice(0, 3).map((x) => x.name).join(', ')}{f.semCusto.length > 3 ? '…' : ''}): <b>o lucro pode estar maior que o real</b>. <Link to="/admin/pendencias">Preencher os custos</Link></div>
        )}
        {tab === 'resumo' && <Resumo f={f} periodo={periodo} g={g} />}
        {tab === 'produtos' && (
          <div className="card" style={{ padding: 0 }}>
            <div className="small muted" style={{ padding: 12 }}>Todos os produtos ativos, em ordem alfabética. Margem = (preço − custo) ÷ preço. Lucro total = vendas com custo − custo.</div>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Produto</th><th className="right">Preço</th><th className="right">Custo</th><th className="right">Margem</th><th className="right">Vendidos</th><th className="right">Lucro total</th></tr></thead>
                <tbody>
                  {f.tabela.map((p) => (
                    <tr key={`${p.id}-${p.name}`}>
                      <td>{p.name}{p.semCustoVendidos > 0 && p.costCents != null && <div className="small faint">{p.semCustoVendidos} vendido(s) antes do custo</div>}</td>
                      <td className="right num">{p.priceCents != null ? brl(p.priceCents) : '—'}</td>
                      <td className="right num">{p.costCents != null ? brl(p.costCents) : <button className="linkish" onClick={() => p.id && setCusto(p)} disabled={!p.id}><Badge tone="warn">sem custo</Badge></button>}</td>
                      <td className="right num">{p.margemPct != null ? pct(p.margemPct, 0) : <span className="faint">—</span>}</td>
                      <td className="right num">{p.vendidos || <span className="faint">0</span>}</td>
                      <td className="right num">{p.lucroCents != null ? brl(p.lucroCents) : <span className="faint">—</span>}</td>
                    </tr>
                  ))}
                  {!f.tabela.length && <tr><td colSpan={6} className="empty">Nenhum produto.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'despesas' && (
          <div className="col gap-lg">
            <div className="row between wrap">
              <div className="small muted">Despesas pagas com o dinheiro da gaveta entram aqui automaticamente.</div>
              <button className="btn primary" onClick={() => setNewExp(true)}>＋ Lançar despesa</button>
            </div>
            <div className="card">
              <div className="panel-title">Despesas por categoria · {brl(f.expensesCents)}</div>
              {!f.expensesByCategory.length && <div className="muted small">Nenhuma despesa no período.</div>}
              {f.expensesByCategory.map((e) => {
                const p = f.expensesCents ? e.cents / f.expensesCents : 0;
                return (
                  <div key={e.name} className="barra-linha">
                    <div className="row between"><span>{e.name} <span className="faint small">({e.count})</span></span><span className="num">{brl(e.cents)} <span className="faint small">{pct(p, 0)}</span></span></div>
                    <div className="barra-trilho"><span style={{ width: `${Math.max(2, p * 100)}%`, background: 'var(--cat-1)' }} /></div>
                  </div>
                );
              })}
            </div>
            <div className="card" style={{ padding: 0 }}>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th className="right">Valor</th><th className="hide-mobile">Lançado por</th><th></th></tr></thead>
                  <tbody>
                    {exps.map((e) => (
                      <tr key={e.id} className={e.cancelledAt ? 'strike' : ''}>
                        <td className="small">{dateOnly(e.date + 'T12:00:00Z')}</td>
                        <td>{e.description}{e.paidFromRegister && <Badge tone="info">gaveta</Badge>}{e.cancelledAt && <div className="small cancel-text">Cancelada: {e.cancelReason}</div>}</td>
                        <td className="small">{e.categoryName}</td>
                        <td className="right num">{brl(e.amountCents)}</td>
                        <td className="small muted hide-mobile">{e.userName}</td>
                        <td className="right">{!e.cancelledAt && <button className="btn sm ghost" onClick={() => setCancel(e)}>Cancelar</button>}</td>
                      </tr>
                    ))}
                    {!exps.length && <tr><td colSpan={6} className="empty">Nenhuma despesa no período.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </>)}
      {newExp && <ExpenseModal onClose={() => setNewExp(false)} onDone={refresh} />}
      {custo && <CustoModal p={custo} onClose={() => setCusto(null)} onDone={refresh} />}
      {cancel && (
        <ReasonModal title={`Cancelar despesa "${cancel.description}"`} confirmLabel="Cancelar despesa" danger
          description={cancel.paidFromRegister ? 'Se o caixa do dia ainda estiver aberto, o valor volta para a gaveta (suprimento).' : undefined}
          onClose={() => setCancel(null)}
          onConfirm={(reason) => run(async () => { await api.post(`/api/expenses/${cancel.id}/cancel`, { reason }); refresh(); }, 'Despesa cancelada.')} />
      )}
    </div>
  );
}

/** Resumo do Dono: só números. Lucro com ▲▼ vs período anterior, 4 cartões, cascata exata, formas de pagamento e (no Ano) 12 meses. */
function Resumo({ f, periodo, g }: { f: Fin; periodo: Periodo; g?: Graficos }) {
  const varPct = f.anterior.temDados && f.anterior.lucroCents !== 0 ? (f.lucroCents - f.anterior.lucroCents) / Math.abs(f.anterior.lucroCents) : null;
  const anteriorTxt = { hoje: 'ontem', '7d': '7 dias anteriores', mes: 'mesmo nº de dias antes', ano: '12 meses anteriores' }[periodo];
  const formas = f.receivedByMethod.filter((m) => m.cents > 0);
  const positivo = f.lucroCents >= 0;
  return (
    <div className="col gap-lg">
      <div className="card lucro-hero">
        <div className="lucro-topo">
          <span className="small muted">Lucro do período</span>
          {varPct != null
            ? <span className={`lucro-selo ${varPct >= 0 ? 'sobe' : 'desce'}`}>{varPct >= 0 ? '▲' : '▼'} {pct(Math.abs(varPct), 0)} <span className="lucro-selo-vs">vs {anteriorTxt}</span></span>
            : <span className="small faint">sem dados do período anterior para comparar</span>}
        </div>
        <div className="lucro-valor" style={{ color: positivo ? 'var(--ok)' : 'var(--danger)' }}>{brl(f.lucroCents)}</div>
        <div className="row wrap lucro-sub">
          <span>Margem <b>{f.margemLucro != null ? pct(f.margemLucro, 1) : '—'}</b></span>
          {varPct != null && <span className="faint">{anteriorTxt}: {brl(f.anterior.lucroCents)}</span>}
        </div>
        <div className="small faint" style={{ marginTop: 6 }}>ⓘ Lucro = Vendido − Descontos − Custo dos produtos − Despesas lançadas{f.feesCents > 0 ? ' − Taxas da maquininha' : ''}. Não inclui impostos, pró-labore nem taxas que não foram lançadas.</div>
      </div>
      {g && <AcompanhamentoMes g={g.mes} />}
      <div className="fin-cartoes">
        <div className="tile"><div className="label">Vendido</div><div className="value">{brl(f.grossSalesCents)}</div></div>
        <div className="tile"><div className="label">Custo dos produtos</div><div className="value">{brl(f.costCents)}</div></div>
        <div className="tile"><div className="label">Despesas</div><div className="value">{brl(f.expensesCents)}</div></div>
        <div className="tile"><div className="label">A receber (agora)</div><div className="value">{brl(f.pendingCents)}</div></div>
        {g && <CartaoMini rotulo="Contas atendidas" valor={String(g.periodo.contas)} serie={g.periodo.dias.map((d) => d.contas)} />}
        {g && <CartaoMini rotulo="Gasto médio por conta" valor={g.periodo.gastoMedio != null ? brl(g.periodo.gastoMedio) : '—'} serie={g.periodo.dias.map((d) => (d.contas ? Math.round(d.vendido / d.contas) : 0))} />}
      </div>
      <div className="grid-2">
        <EscadaLucro f={f} />
        <div className="card">
          <div className="panel-title">Como os clientes pagaram · {brl(f.receivedCents)}</div>
          {!formas.length ? <div className="muted small">Nenhum recebimento no período.</div> : <>
            <div className="barra-formas" role="img" aria-label={formas.map((m) => `${m.name} ${brl(m.cents)}`).join(', ')}>
              {formas.map((m, i) => {
                const parte = m.cents / f.receivedCents;
                return <span key={m.code} title={`${m.name}: ${brl(m.cents)} (${pct(parte, 0)})`} style={{ flexGrow: m.cents, background: CORES[i % CORES.length] }}>{parte >= 0.12 ? pct(parte, 0) : ''}</span>;
              })}
            </div>
            {formas.map((m, i) => (
              <div key={m.code} className="kv">
                <span className="row" style={{ gap: 8 }}><span className="legenda-cor" style={{ background: CORES[i % CORES.length] }} />{m.name}</span>
                <span className="v">{brl(m.cents)} <span className="faint small">{pct(m.cents / f.receivedCents, 0)}</span></span>
              </div>
            ))}
            {f.feesCents > 0 && <div className="small faint mt">Taxas da maquininha {brl(f.feesCents)} · cai na conta {brl(f.netReceivedCents)}</div>}
          </>}
        </div>
      </div>
      {g && <div className="grid-2"><FinsDeSemana dias={g.semanas} /><Categorias cats={g.categorias} vendido={g.periodo.vendido} /></div>}
      {periodo === 'ano' && f.meses && <AnoGrafico meses={f.meses} />}
    </div>
  );
}

/**
 * "Do vendido ao lucro" em escada: cada saída começa onde a anterior terminou, os subtotais são barras cheias.
 * Uma escala só (do menor valor, que pode ser prejuízo, até o vendido). Só números: nada de interpretação.
 */
function EscadaLucro({ f }: { f: Fin }) {
  if (f.grossSalesCents <= 0) return (
    <div className="card">
      <div className="panel-title">Do vendido ao lucro</div>
      <div className="muted small">Sem vendas no período.</div>
    </div>
  );
  const bruto = f.grossSalesCents - f.discountsCents - f.costCents;
  type Passo = { r: string; de: number; ate: number; tipo: 'entrada' | 'saida' | 'subtotal' | 'final'; v: number };
  const passos: Passo[] = [];
  let corrente = f.grossSalesCents;
  passos.push({ r: 'Vendido', de: 0, ate: corrente, tipo: 'entrada', v: corrente });
  const saida = (r: string, v: number) => { if (v <= 0) return; passos.push({ r, de: corrente - v, ate: corrente, tipo: 'saida', v }); corrente -= v; };
  saida('Descontos', f.discountsCents);
  saida('Custo dos produtos', f.costCents);
  passos.push({ r: 'Lucro bruto', de: Math.min(0, bruto), ate: Math.max(0, bruto), tipo: 'subtotal', v: bruto });
  saida('Despesas', f.expensesCents);
  saida('Taxas da maquininha', f.feesCents);
  passos.push({ r: 'Lucro', de: Math.min(0, f.lucroCents), ate: Math.max(0, f.lucroCents), tipo: 'final', v: f.lucroCents });
  const min = Math.min(0, ...passos.map((p) => p.de));
  const max = Math.max(...passos.map((p) => p.ate));
  const pos = (v: number) => ((v - min) / Math.max(1, max - min)) * 100;
  const zero = pos(0);
  return (
    <div className="card">
      <div className="panel-title">Do vendido ao lucro</div>
      <div className="escada" role="table" aria-label="Do vendido ao lucro">
        {passos.map((p) => {
          const esq = pos(p.de), larg = Math.max(0.6, pos(p.ate) - pos(p.de));
          const negativo = (p.tipo === 'subtotal' || p.tipo === 'final') && p.v < 0;
          return (
            <div key={p.r} className={`escada-linha ${p.tipo}${negativo ? ' negativo' : ''}`} role="row">
              <span className="escada-rot" role="cell">
                {p.tipo === 'saida' ? '− ' : p.tipo === 'subtotal' || p.tipo === 'final' ? '= ' : ''}{p.r}
                {p.tipo === 'saida' && <small>{pct(p.v / f.grossSalesCents, 0)} do vendido</small>}
              </span>
              <span className="escada-trilho" aria-hidden="true">
                {min < 0 && <i className="escada-zero" style={{ left: `${zero}%` }} />}
                <span className="escada-barra" style={{ left: `${esq}%`, width: `${larg}%` }} />
              </span>
              <span className="escada-val num" role="cell">{p.tipo === 'saida' ? `−${brl(p.v)}` : brl(p.v)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 12 barras de vendido e lucro (uma escala, legenda; mês sem dados aparece cinza "sem dados", nunca zero). */
function AnoGrafico({ meses }: { meses: NonNullable<Fin['meses']> }) {
  const [foco, setFoco] = useState<number | null>(null);
  const max = Math.max(1, ...meses.map((m) => Math.max(m.vendidoCents ?? 0, m.lucroCents ?? 0)));
  const min = Math.min(0, ...meses.map((m) => m.lucroCents ?? 0));
  const H = 180, W = 720, padB = 24, top = 8;
  const escala = (v: number) => top + ((max - v) / (max - min)) * (H - top - padB);
  const zero = escala(0);
  const col = W / 12, bw = Math.min(22, col / 3);
  const m = foco != null ? meses[foco] : null;
  return (
    <div className="card">
      <div className="row between wrap">
        <div className="panel-title" style={{ margin: 0 }}>Vendido e lucro · 12 meses</div>
        <div className="row small" style={{ gap: 12 }}>
          <span className="row" style={{ gap: 6 }}><span className="legenda-cor" style={{ background: 'var(--cat-1)' }} />Vendido</span>
          <span className="row" style={{ gap: 6 }}><span className="legenda-cor" style={{ background: 'var(--cat-2)' }} />Lucro</span>
        </div>
      </div>
      <div className="small" style={{ minHeight: 20, marginTop: 4 }}>
        {m ? (m.vendidoCents == null ? <span className="faint">{nomeMes(m.mes)}: sem dados</span>
          : <span><b>{nomeMes(m.mes)}</b> · vendido {brl(m.vendidoCents)} · lucro {brl(m.lucroCents ?? 0)}</span>) : <span className="faint">Toque numa barra para ver os valores.</span>}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="ano-svg" role="img" aria-label="Vendido e lucro por mês nos últimos 12 meses">
        <line x1={0} x2={W} y1={zero} y2={zero} stroke="var(--border)" />
        {meses.map((mm, i) => {
          const x = i * col + col / 2;
          const on = foco === i;
          return (
            <g key={mm.mes} onMouseEnter={() => setFoco(i)} onMouseLeave={() => setFoco(null)} onClick={() => setFoco(on ? null : i)} style={{ cursor: 'pointer' }}>
              <rect x={i * col} y={0} width={col} height={H} fill={on ? 'var(--surface-2)' : 'transparent'} />
              {mm.vendidoCents == null
                ? <rect x={x - bw - 1} y={zero - 4} width={bw * 2 + 2} height={4} rx={2} fill="var(--faint)" opacity={0.5} />
                : <>
                  <rect x={x - bw - 1} y={escala(mm.vendidoCents)} width={bw} height={Math.max(1, zero - escala(mm.vendidoCents))} rx={4} fill="var(--cat-1)" />
                  {(() => { const l = mm.lucroCents ?? 0; const y = l >= 0 ? escala(l) : zero; return <rect x={x + 1} y={y} width={bw} height={Math.max(1, Math.abs(escala(l) - zero))} rx={4} fill="var(--cat-2)" />; })()}
                </>}
              <text x={x} y={H - 6} textAnchor="middle" className="ano-mes">{nomeMes(mm.mes)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function CustoModal({ p, onClose, onDone }: { p: Fin['tabela'][number]; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState<number | null>(null);
  const [passado, setPassado] = useState(true);
  const { busy, run } = useAction();
  return (
    <Modal title={`Custo · ${p.name}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary" disabled={busy || v == null} onClick={async () => {
        if (await run(() => api.post(`/api/products/${p.id}/custo`, { costCents: v, applyCostToPast: passado }), 'Custo salvo.')) { onDone(); onClose(); }
      }}>Salvar</button>
    </>}>
      <div className="col gap-lg">
        <label className="field"><span>Quanto custa para você cada unidade?</span><MoneyInput value={v} onChange={setV} autoFocus /></label>
        <label className="check small"><input type="checkbox" checked={passado} onChange={(e) => setPassado(e.target.checked)} />Usar também nas vendas que ficaram sem custo</label>
      </div>
    </Modal>
  );
}

function ExpenseModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { data: cats = [] } = useQuery({ queryKey: ['expenseCats'], queryFn: () => api.get<Cat[]>('/api/expense-categories') });
  const [cat, setCat] = useState<number | null>(null);
  const [desc, setDesc] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState('');
  const [drawer, setDrawer] = useState(false);
  const envio: ChaveEnvio = useRef(null); // a mesma chave num novo toque: rede lenta não lança a despesa duas vezes
  const [newCat, setNewCat] = useState('');
  const { busy, run } = useAction();
  const qc = useQueryClient();
  const ok = !!cat && desc.trim().length >= 2 && !!amount;
  return (
    <Modal title="Nova despesa" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary" disabled={!ok || busy} onClick={async () => {
        const corpo = { description: desc.trim(), categoryId: cat, amountCents: amount, date, note: note.trim() || null, paidFromRegister: drawer };
        if (await run(() => api.post('/api/expenses', corpo, chaveDoEnvio(envio, corpo)), 'Despesa lançada.')) { onDone(); onClose(); }
      }}>Lançar {amount ? brl(amount) : ''}</button>
    </>}>
      <div className="col gap-lg">
        <label className="field"><span>Categoria</span>
          <select className="input" value={cat ?? ''} onChange={(e) => setCat(Number(e.target.value) || null)}>
            <option value="">Escolha…</option>
            {cats.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <div className="row">
          <input className="input" placeholder="Nova categoria" value={newCat} onChange={(e) => setNewCat(e.target.value)} maxLength={40} />
          <button className="btn sm" disabled={newCat.trim().length < 2 || busy} onClick={async () => {
            let c: Cat | undefined;
            if (await run(async () => { c = await api.post<Cat>('/api/expense-categories', { name: newCat.trim() }); }, 'Categoria criada.')) { qc.invalidateQueries({ queryKey: ['expenseCats'] }); setCat(c!.id); setNewCat(''); }
          }}>Criar</button>
        </div>
        <label className="field"><span>Descrição</span><input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={120} placeholder="Ex.: conta de energia de setembro" /></label>
        <div className="grid-2">
          <label className="field"><span>Valor</span><MoneyInput value={amount} onChange={setAmount} /></label>
          <label className="field"><span>Data</span><input type="date" className="input" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} /></label>
        </div>
        <label className="field"><span>Observação</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></label>
        <label className="check"><input type="checkbox" checked={drawer} onChange={(e) => setDrawer(e.target.checked)} />Paga com o dinheiro da gaveta do caixa aberto (vira sangria)</label>
      </div>
    </Modal>
  );
}
