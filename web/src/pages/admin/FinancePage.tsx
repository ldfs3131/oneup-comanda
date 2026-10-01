import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../../api';
import { addDaysISO, brl, dateOnly, fmtDay, pct, todayISO } from '../../format';
import { Badge, Modal, MoneyInput, ReasonModal, Spinner, useAction } from '../../components/ui';
import RitmoMes from './RitmoMes';

type Fin = {
  from: string; to: string; grossSalesCents: number; discountsCents: number; revenueCents: number; receivedCents: number;
  receivedByMethod: { name: string; cents: number; feesCents: number; taxaBp: number }[]; feesCents: number; netReceivedCents: number; pendingCents: number; openBalanceCents: number;
  costCents: number; costCoverage: number; grossProfitCents: number; grossMargin: number | null;
  expensesCents: number; expensesByCategory: { name: string; cents: number; count: number }[]; operatingResultCents: number;
  products: { id: number | null; name: string; priceCents: number | null; currentCostCents: number | null; unitMarginCents: number | null; qty: number; revenueCents: number; costCents: number | null; marginCents: number | null; qtyWithoutCost: number }[];
};
type Expense = { id: number; description: string; amountCents: number; date: string; note: string | null; paidFromRegister: boolean; cancelledAt: string | null; cancelReason: string | null; categoryName: string; userName: string };
type Cat = { id: number; name: string; active: boolean };

const monthStart = () => todayISO().slice(0, 8) + '01';

export default function FinancePage() {
  const [range, setRange] = useState({ from: monthStart(), to: todayISO() });
  const [tab, setTab] = useState<'dre' | 'products' | 'expenses' | 'ritmo'>('dre');
  const [newExp, setNewExp] = useState(false);
  const [cancel, setCancel] = useState<Expense | null>(null);
  const [sort, setSort] = useState<'revenue' | 'margin' | 'qty'>('revenue');
  const { data: f, isLoading } = useQuery({ queryKey: ['finance', range], queryFn: () => api.get<Fin>(`/api/finance${qs(range)}`) });
  const { data: exps = [] } = useQuery({ queryKey: ['expenses', range], queryFn: () => api.get<Expense[]>(`/api/expenses${qs(range)}`) });
  const { run } = useAction();
  const qc = useQueryClient();
  const refresh = () => { qc.invalidateQueries({ queryKey: ['finance'] }); qc.invalidateQueries({ queryKey: ['expenses'] }); };

  const quick = (from: string, to: string) => setRange({ from, to });
  const products = [...(f?.products ?? [])].sort((a, b) => sort === 'qty' ? b.qty - a.qty : sort === 'margin' ? (b.marginCents ?? -1e12) - (a.marginCents ?? -1e12) : b.revenueCents - a.revenueCents);

  return (
    <div className="col gap-lg">
      <div className="row between wrap">
        <div>
          <h1>Financeiro</h1>
          <div className="muted small">{tab === 'ritmo' ? 'Receita acumulada do mês comparada com os meses anteriores, no mesmo dia' : `${fmtDay(range.from)} a ${fmtDay(range.to)} · valores em regime de venda (data do pedido)`}</div>
        </div>
        {tab !== 'ritmo' && <div className="row wrap">
          <div className="seg">
            <button onClick={() => quick(todayISO(), todayISO())}>Hoje</button>
            <button onClick={() => quick(addDaysISO(todayISO(), -6), todayISO())}>7 dias</button>
            <button onClick={() => quick(monthStart(), todayISO())}>Mês</button>
            <button onClick={() => { const t = todayISO(); const d = new Date(t.slice(0, 8) + '01T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1); const s = d.toISOString().slice(0, 10); quick(s, addDaysISO(t.slice(0, 8) + '01', -1)); }}>Mês passado</button>
          </div>
          <input type="date" className="input" style={{ width: 160 }} value={range.from} max={range.to} onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))} />
          <input type="date" className="input" style={{ width: 160 }} value={range.to} min={range.from} max={todayISO()} onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))} />
        </div>}
      </div>
      <div className="seg">
        <button className={tab === 'dre' ? 'on' : ''} onClick={() => setTab('dre')}>Resultado</button>
        <button className={tab === 'products' ? 'on' : ''} onClick={() => setTab('products')}>Por produto</button>
        <button className={tab === 'expenses' ? 'on' : ''} onClick={() => setTab('expenses')}>Despesas</button>
        <button className={tab === 'ritmo' ? 'on' : ''} onClick={() => setTab('ritmo')}>Ritmo do mês</button>
      </div>

      {tab === 'ritmo' && <RitmoMes />}

      {tab !== 'ritmo' && (isLoading || !f ? <Spinner /> : <>
        {tab === 'dre' && <>
          {f.costCoverage < 0.999 && f.grossSalesCents > 0 && (
            <div className="info-box small">⚠ Só {pct(f.costCoverage)} das vendas do período têm custo cadastrado. O CMV e o lucro bruto consideram apenas esses itens — cadastre os custos em <b>Cardápio</b> para o resultado ficar completo.</div>
          )}
          <div className="grid-2">
            <div className="card dre">
              <div className="panel-title">Resultado do período</div>
              <div className="kv"><span>Vendas brutas</span><span className="v">{brl(f.grossSalesCents)}</span></div>
              <div className="kv"><span>− Descontos</span><span className="v">{brl(f.discountsCents)}</span></div>
              <div className="kv total"><span>= Faturamento</span><span className="v">{brl(f.revenueCents)}</span></div>
              <div className="kv"><span>− CMV (custo dos produtos vendidos)</span><span className="v">{brl(f.costCents)}</span></div>
              <div className="kv total"><span>= Lucro bruto <span className="small muted">{f.grossMargin != null ? `margem ${pct(f.grossMargin, 1)}` : ''}</span></span><span className="v">{brl(f.grossProfitCents)}</span></div>
              <div className="kv"><span>− Despesas</span><span className="v">{brl(f.expensesCents)}</span></div>
              <div className="kv"><span>− Taxas da maquininha <span className="small muted">(estimado)</span></span><span className="v">{brl(f.feesCents)}</span></div>
              <div className="kv total"><span>= Resultado operacional</span><span className="v" style={{ color: f.operatingResultCents >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{brl(f.operatingResultCents)}</span></div>
              <div className="small faint mt">Resultado operacional não inclui impostos, pró-labore e outros itens fora do sistema — não é “lucro líquido”.</div>
            </div>
            <div className="col gap-lg">
              <div className="card">
                <div className="panel-title">Recebido no período</div>
                {f.receivedByMethod.map((m) => (
                  <div key={m.name} className="kv">
                    <span>{m.name}{m.feesCents > 0 && <span className="small faint"> · taxa {brl(m.feesCents)}</span>}</span>
                    <span className="v">{brl(m.cents)}</span>
                  </div>
                ))}
                <div className="kv total"><span>Total recebido</span><span className="v">{brl(f.receivedCents)}</span></div>
                {f.feesCents > 0 && <>
                  <div className="kv"><span>− Taxas da maquininha</span><span className="v">{brl(f.feesCents)}</span></div>
                  <div className="kv total"><span>= Cai na conta</span><span className="v" style={{ color: 'var(--ok)' }}>{brl(f.netReceivedCents)}</span></div>
                </>}
                {f.feesCents === 0 && f.receivedCents > 0 && <div className="small faint mt">Cadastre a taxa da maquininha em Configurações → Formas de pagamento para ver quanto cai na conta.</div>}
              </div>
              <div className="card">
                <div className="panel-title">A receber (agora)</div>
                <div className="kv"><span>Contas pendentes (fiado)</span><span className="v" style={{ color: 'var(--danger)' }}>{brl(f.pendingCents)}</span></div>
                <div className="kv"><span>Saldo de contas abertas</span><span className="v">{brl(f.openBalanceCents)}</span></div>
              </div>
              <div className="card">
                <div className="panel-title">Despesas por categoria</div>
                {!f.expensesByCategory.length && <div className="muted small">Nenhuma despesa no período.</div>}
                {f.expensesByCategory.map((e) => <div key={e.name} className="kv"><span>{e.name} <span className="faint small">({e.count})</span></span><span className="v">{brl(e.cents)}</span></div>)}
              </div>
            </div>
          </div>
        </>}

        {tab === 'products' && (
          <div className="card" style={{ padding: 0 }}>
            <div className="row between wrap" style={{ padding: 12 }}>
              <div className="small muted">Custo congelado no momento da venda. Margem unitária usa preço e custo atuais.</div>
              <div className="seg">
                <button className={sort === 'revenue' ? 'on' : ''} onClick={() => setSort('revenue')}>Faturamento</button>
                <button className={sort === 'margin' ? 'on' : ''} onClick={() => setSort('margin')}>Margem</button>
                <button className={sort === 'qty' ? 'on' : ''} onClick={() => setSort('qty')}>Quantidade</button>
              </div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Produto</th><th className="right">Qtd.</th><th className="right">Faturamento</th><th className="right">Custo</th><th className="right">Margem</th><th className="right hide-mobile">Preço / custo atual</th><th className="right hide-mobile">Margem unit.</th></tr></thead>
                <tbody>
                  {products.map((p) => (
                    <tr key={`${p.id}-${p.name}`}>
                      <td>{p.name}{p.qtyWithoutCost > 0 && <div className="small faint">{p.qtyWithoutCost} un. sem custo</div>}</td>
                      <td className="right num">{p.qty}</td>
                      <td className="right num">{brl(p.revenueCents)}</td>
                      <td className="right num">{p.costCents == null ? <span className="faint">—</span> : brl(p.costCents)}</td>
                      <td className="right num">{p.marginCents == null ? <span className="faint">—</span> : <>{brl(p.marginCents)} <span className="faint small">{pct(p.revenueCents ? p.marginCents / p.revenueCents : null)}</span></>}</td>
                      <td className="right num small hide-mobile">{p.priceCents != null ? brl(p.priceCents) : '—'} / {p.currentCostCents != null ? brl(p.currentCostCents) : <Badge tone="warn">sem custo</Badge>}</td>
                      <td className="right num hide-mobile">{p.unitMarginCents != null ? brl(p.unitMarginCents) : '—'}</td>
                    </tr>
                  ))}
                  {!products.length && <tr><td colSpan={7} className="empty">Sem vendas no período.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'expenses' && (
          <div className="col gap-lg">
            <div className="row between wrap">
              <div className="small muted">Despesas do caixa (pagas com a gaveta) entram aqui automaticamente.</div>
              <button className="btn primary" onClick={() => setNewExp(true)}>＋ Nova despesa</button>
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
      {cancel && (
        <ReasonModal title={`Cancelar despesa "${cancel.description}"`} confirmLabel="Cancelar despesa" danger
          description={cancel.paidFromRegister ? 'Se o caixa do dia ainda estiver aberto, o valor volta para a gaveta (suprimento).' : undefined}
          onClose={() => setCancel(null)}
          onConfirm={(reason) => run(async () => { await api.post(`/api/expenses/${cancel.id}/cancel`, { reason }); refresh(); }, 'Despesa cancelada.')} />
      )}
    </div>
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
  const [newCat, setNewCat] = useState('');
  const { busy, run } = useAction();
  const qc = useQueryClient();
  const ok = !!cat && desc.trim().length >= 2 && !!amount;
  return (
    <Modal title="Nova despesa" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary" disabled={!ok || busy} onClick={async () => {
        if (await run(() => api.post('/api/expenses', { description: desc.trim(), categoryId: cat, amountCents: amount, date, note: note.trim() || null, paidFromRegister: drawer }, true), 'Despesa lançada.')) { onDone(); onClose(); }
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
