import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { ORDER_STATUS, ORIGIN_LABEL, SITUATION, brl, norm, time } from '../../format';
import { Badge, OrderBadge, Spinner } from '../../components/ui';
import { OrderDetailModal } from '../../components/OrderDetail';

type Row = {
  id: number; number: number; sequence: number; status: string; origin: string; consumptionType: 'LOCAL' | 'VIAGEM'; createdAt: string;
  readyAt: string | null; expectedReadyAt: string | null; goesToKitchen: boolean; accountId: number; accountNumber: number;
  customerName: string | null; accountNote: string | null; tableLabel: string | null; accountStatus: string; createdByName: string | null;
  totalCents: number; itemsText: string | null; situation: string;
};

const FILTERS: { k: string; label: string; test: (r: Row) => boolean }[] = [
  { k: 'all', label: 'Todos', test: () => true },
  { k: 'kitchen', label: 'Na cozinha', test: (r) => ['CONFIRMED', 'IN_PREPARATION'].includes(r.status) },
  { k: 'ready', label: 'Prontos', test: (r) => r.status === 'READY' },
  { k: 'unpaid', label: 'A pagar', test: (r) => r.situation === 'PENDENTE' || r.situation === 'PARCIAL' },
  { k: 'viagem', label: 'Para viagem', test: (r) => r.consumptionType === 'VIAGEM' },
  { k: 'cancelled', label: 'Cancelados', test: (r) => r.status === 'CANCELLED' },
];

export default function OrdersToday() {
  const nav = useNavigate();
  const { data, isLoading } = useQuery({ queryKey: ['ordersToday'], queryFn: () => api.get<Row[]>('/api/orders/today'), refetchInterval: 20_000 });
  const [f, setF] = useState(() => { try { return sessionStorage.getItem('ha:ordersFilter') ?? 'all'; } catch { return 'all'; } });
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState<number | null>(null);
  const setFilter = (k: string) => { setF(k); try { sessionStorage.setItem('ha:ordersFilter', k); } catch { /* ok */ } };

  const rows = useMemo(() => {
    const flt = FILTERS.find((x) => x.k === f) ?? FILTERS[0];
    const s = norm(q).replace('#', '');
    return (data ?? []).filter(flt.test).filter((r) => !s || String(r.number) === s || String(r.accountNumber) === s
      || norm(r.customerName ?? '').includes(s) || norm(r.itemsText ?? '').includes(s) || norm(r.accountNote ?? '').includes(s) || r.tableLabel === s);
  }, [data, f, q]);

  if (isLoading || !data) return <Spinner />;
  const valid = data.filter((r) => r.status !== 'CANCELLED');
  const total = valid.reduce((s, r) => s + r.totalCents, 0);

  return (
    <div className="col gap-lg">
      <div className="row between wrap">
        <div>
          <h1>Pedidos do dia <span className="muted num">({valid.length})</span></h1>
          <div className="muted small">Desde a abertura do dia · vendido <b className="num">{brl(total)}</b></div>
        </div>
        <input className="input" style={{ maxWidth: 320 }} placeholder="Buscar nº, cliente, mesa ou item" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="seg">
        {FILTERS.map((x) => <button key={x.k} className={f === x.k ? 'on' : ''} onClick={() => setFilter(x.k)}>{x.label} <span className="faint">{data.filter(x.test).length}</span></button>)}
      </div>
      {!rows.length ? <div className="card empty">Nenhum pedido {q ? `para “${q}”` : 'neste filtro'}.</div> : (
        <div className="order-list">
          {rows.map((r) => (
            <button key={r.id} className={`order-line${r.status === 'CANCELLED' ? ' cancelled' : ''}`} onClick={() => setDetail(r.id)}>
              <div className="ol-main">
                <div className="row wrap" style={{ gap: 8 }}>
                  <b className="num">#{r.number}</b>
                  <span className="muted small">{time(r.createdAt)}</span>
                  <span className="ellipsis" style={{ fontWeight: 700 }}>{r.customerName || 'Cliente não informado'}</span>
                  <span className="faint small">conta #{r.accountNumber}{r.tableLabel ? ` · Mesa ${r.tableLabel}` : ''}</span>
                  {r.consumptionType === 'VIAGEM' && <span className="viagem-tag">VIAGEM</span>}
                  {r.origin !== 'CAIXA' && <Badge tone="brand">{ORIGIN_LABEL[r.origin] ?? r.origin}</Badge>}
                </div>
                <div className="small muted ellipsis">{r.itemsText ?? '—'}</div>
              </div>
              <div className="ol-side">
                <span className="num" style={{ fontWeight: 800 }}>{brl(r.totalCents)}</span>
                <div className="row" style={{ gap: 6 }}>
                  {r.status !== 'CANCELLED' && <Badge tone={SITUATION[r.situation]?.tone}>{SITUATION[r.situation]?.label ?? r.situation}</Badge>}
                  <OrderBadge status={r.status} />
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
      <div className="small faint">Toque em um pedido para ver os detalhes. Status: {Object.values(ORDER_STATUS).map((s) => s.label).slice(2, 6).join(' → ')}.</div>
      {detail && <OrderDetailModal orderId={detail} onClose={() => setDetail(null)} onOpenAccount={(id) => nav(`/caixa/conta/${id}`)} />}
    </div>
  );
}
