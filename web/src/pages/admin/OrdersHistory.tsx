import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../../api';
import { CONSUMPTION_LABEL, ORDER_STATUS, ORIGIN_LABEL, addDaysISO, brl, dateTime, todayISO } from '../../format';
import type { PaymentMethod } from '../../types';
import { Badge, OrderBadge, Spinner } from '../../components/ui';
import { OrderDetailModal } from '../../components/OrderDetail';
import { useMenu } from '../caixa/OrderComposer';

type Row = { id: number; number: number; status: string; origin: string; consumptionType: string; createdAt: string; accountId: number; accountNumber: number; customerName: string | null; accountStatus: string; createdByName: string | null; totalCents: number; itemsText: string | null };
type Filters = { from: string; to: string; search: string; status: string; method: string; userId: string; productId: string; origin: string; consumption: string };
const KEY = 'ha:historyFilters';
const initial = (): Filters => {
  const def = { from: addDaysISO(todayISO(), -6), to: todayISO(), search: '', status: '', method: '', userId: '', productId: '', origin: '', consumption: '' };
  try { return { ...def, ...JSON.parse(sessionStorage.getItem(KEY) ?? '{}') }; } catch { return def; }
};

export default function OrdersHistory() {
  const nav = useNavigate();
  const [f, setF] = useState<Filters>(initial);
  const [search, setSearch] = useState(f.search);
  const [detail, setDetail] = useState<number | null>(null);
  useEffect(() => { try { sessionStorage.setItem(KEY, JSON.stringify(f)); } catch { /* ok */ } }, [f]);
  useEffect(() => { const t = setTimeout(() => setF((x) => ({ ...x, search })), 300); return () => clearTimeout(t); }, [search]);
  const { data, isLoading } = useQuery({ queryKey: ['history', f], queryFn: () => api.get<Row[]>(`/api/orders/history${qs(f)}`) });
  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ id: number; name: string }[]>('/api/users') });
  const { data: methods = [] } = useQuery({ queryKey: ['methods'], queryFn: () => api.get<PaymentMethod[]>('/api/payment-methods') });
  const { data: menu = [] } = useMenu();
  const set = (k: keyof Filters, v: string) => setF((x) => ({ ...x, [k]: v }));
  const active = ['status', 'method', 'userId', 'productId', 'origin', 'consumption'].filter((k) => f[k as keyof Filters]).length + (f.search ? 1 : 0);
  const valid = (data ?? []).filter((r) => r.status !== 'CANCELLED');

  return (
    <div className="col gap-lg">
      <div className="row between wrap">
        <div>
          <h1>Histórico de pedidos</h1>
          <div className="muted small">{data ? `${data.length} pedido(s) · ${brl(valid.reduce((s, r) => s + r.totalCents, 0))} (sem cancelados)` : ''}{data?.length === 500 ? ' · mostrando os 500 mais recentes' : ''}</div>
        </div>
        {active > 0 && <button className="btn sm" onClick={() => { setSearch(''); setF((x) => ({ ...x, search: '', status: '', method: '', userId: '', productId: '', origin: '', consumption: '' })); }}>Limpar filtros ({active})</button>}
      </div>
      <div className="card filters">
        <input className="input" placeholder="Nº do pedido/conta ou cliente" value={search} onChange={(e) => setSearch(e.target.value)} />
        <input type="date" className="input" value={f.from} max={f.to} onChange={(e) => e.target.value && set('from', e.target.value)} />
        <input type="date" className="input" value={f.to} min={f.from} max={todayISO()} onChange={(e) => e.target.value && set('to', e.target.value)} />
        <select className="input" value={f.status} onChange={(e) => set('status', e.target.value)}>
          <option value="">Todos os status</option>
          {['CONFIRMED', 'IN_PREPARATION', 'READY', 'DELIVERED', 'CANCELLED', 'AWAITING_CONFIRMATION'].map((s) => <option key={s} value={s}>{ORDER_STATUS[s].label}</option>)}
        </select>
        <select className="input" value={f.method} onChange={(e) => set('method', e.target.value)}>
          <option value="">Qualquer pagamento</option>
          {methods.map((m) => <option key={m.code} value={m.code}>{m.name}</option>)}
        </select>
        <select className="input" value={f.userId} onChange={(e) => set('userId', e.target.value)}>
          <option value="">Qualquer usuário</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <select className="input" value={f.productId} onChange={(e) => set('productId', e.target.value)}>
          <option value="">Qualquer produto</option>
          {menu.map((c) => <optgroup key={c.id} label={c.name}>{c.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>)}
        </select>
        <select className="input" value={f.origin} onChange={(e) => set('origin', e.target.value)}>
          <option value="">Qualquer origem</option>
          {Object.entries(ORIGIN_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="input" value={f.consumption} onChange={(e) => set('consumption', e.target.value)}>
          <option value="">Local e viagem</option>
          {Object.entries(CONSUMPTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      {isLoading || !data ? <Spinner /> : !data.length ? <div className="card empty">Nenhum pedido com esses filtros.</div> : (
        <div className="card table-wrap" style={{ padding: 0 }}>
          <table className="table">
            <thead><tr><th>Pedido</th><th>Quando</th><th>Cliente</th><th className="hide-mobile">Itens</th><th className="right">Valor</th><th>Status</th><th className="hide-mobile">Lançado por</th></tr></thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id} className={`click${r.status === 'CANCELLED' ? ' strike' : ''}`} onClick={() => setDetail(r.id)}>
                  <td className="num"><b>#{r.number}</b><div className="small faint">conta #{r.accountNumber}</div></td>
                  <td className="small">{dateTime(r.createdAt)}</td>
                  <td>{r.customerName || <span className="faint">não informado</span>}<div className="row" style={{ gap: 4 }}>{r.consumptionType === 'VIAGEM' && <span className="viagem-tag">VIAGEM</span>}{r.origin !== 'CAIXA' && <Badge tone="brand">{ORIGIN_LABEL[r.origin] ?? r.origin}</Badge>}</div></td>
                  <td className="small muted hide-mobile" style={{ maxWidth: 320 }}>{r.itemsText}</td>
                  <td className="right num">{brl(r.totalCents)}</td>
                  <td><OrderBadge status={r.status} /></td>
                  <td className="small muted hide-mobile">{r.createdByName ?? (r.origin === 'QR_CODE' ? 'Cliente (QR)' : '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {detail && <OrderDetailModal orderId={detail} onClose={() => setDetail(null)} onOpenAccount={(id) => nav(`/admin/conta/${id}`)} />}
    </div>
  );
}
