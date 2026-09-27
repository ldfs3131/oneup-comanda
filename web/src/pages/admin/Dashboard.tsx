import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { brl, todayISO } from '../../format';
import { Spinner } from '../../components/ui';

type Dash = {
  date: string; revenueCents: number; grossSalesCents: number; ordersCount: number; accountsCount: number; averageTicketCents: number;
  accountsOpenNow: number; accountsClosedToday: number; accountsPendingNow: number; pendingCents: number;
  ordersNew: number; ordersPreparing: number; ordersReady: number; ordersAwaiting: number;
  discountsCents: number; discountsCount: number; discountsByUser: { name: string; cents: number; count: number }[];
  cancellationsCents: number; cancellationsCount: number; lossCents: number;
  payments: { code: string; name: string; cents: number; count: number }[]; receivedCents: number;
  yearRevenueCents: number; topProducts: { name: string; qty: number; cents: number }[];
};

const MEI_LIMIT = 8_100_000; // R$ 81.000,00 — teto anual do MEI (referência; confirme com o contador)

export default function Dashboard() {
  const [date, setDate] = useState(todayISO());
  const { data: d, isLoading } = useQuery({ queryKey: ['dashboard', date], queryFn: () => api.get<Dash>(`/api/dashboard?date=${date}`), refetchInterval: 60_000 });
  const isToday = date === todayISO();

  return (
    <div className="col gap-lg">
      <div className="row between wrap">
        <h1>{isToday ? 'Hoje' : 'Dia selecionado'}</h1>
        <div className="row">
          <input type="date" className="input" value={date} max={todayISO()} onChange={(e) => e.target.value && setDate(e.target.value)} style={{ width: 180 }} />
          {!isToday && <button className="btn" onClick={() => setDate(todayISO())}>Hoje</button>}
        </div>
      </div>
      {isLoading || !d ? <Spinner /> : <>
        <div className="tiles">
          <div className="tile hero"><div className="label">Faturamento</div><div className="value num">{brl(d.revenueCents)}</div><div className="sub">vendas − descontos</div></div>
          <div className="tile"><div className="label">Contas</div><div className="value num">{d.accountsCount}</div></div>
          <div className="tile"><div className="label">Pedidos</div><div className="value num">{d.ordersCount}</div></div>
          <div className="tile"><div className="label">Ticket médio</div><div className="value num">{brl(d.averageTicketCents)}</div></div>
          <div className="tile"><div className="label">Recebido no dia</div><div className="value num">{brl(d.receivedCents)}</div></div>
        </div>

        <div className="tiles">
          <Link to="/caixa" className="tile" style={{ textDecoration: 'none', color: 'inherit' }}><div className="label">Contas abertas agora</div><div className="value num">{d.accountsOpenNow}</div></Link>
          <div className="tile"><div className="label">Contas encerradas {isToday ? 'hoje' : 'no dia'}</div><div className="value num">{d.accountsClosedToday}</div></div>
          <Link to="/admin/receber" className="tile" style={{ textDecoration: 'none', color: 'inherit' }}><div className="label">Pendentes (a receber)</div><div className="value num" style={{ color: d.accountsPendingNow ? 'var(--danger)' : undefined }}>{d.accountsPendingNow}</div><div className="sub">{brl(d.pendingCents)}</div></Link>
          <div className="tile"><div className="label">Cozinha agora</div><div className="value num">{d.ordersNew + d.ordersPreparing}</div><div className="sub">{d.ordersNew} novos · {d.ordersPreparing} em preparo · {d.ordersReady} prontos</div></div>
          {d.ordersAwaiting > 0 && <div className="tile"><div className="label">Aguardando confirmação (QR)</div><div className="value num">{d.ordersAwaiting}</div></div>}
        </div>

        <div className="grid-3">
          <div className="card">
            <div className="panel-title">Pagamentos recebidos</div>
            {d.payments.map((p) => <div key={p.code} className="kv"><span>{p.name} <span className="faint small">({p.count})</span></span><span className="v">{brl(p.cents)}</span></div>)}
            <div className="kv total"><span>Total</span><span className="v">{brl(d.receivedCents)}</span></div>
          </div>
          <div className="card">
            <div className="panel-title">Descontos e cancelamentos</div>
            <div className="kv"><span>Descontos/ajustes ({d.discountsCount})</span><span className="v">{brl(d.discountsCents)}</span></div>
            {d.discountsByUser.map((u) => <div key={u.name} className="kv small"><span className="muted">· {u.name}</span><span className="v">{brl(u.cents)} ({u.count})</span></div>)}
            <div className="kv"><span>Cancelamentos ({d.cancellationsCount})</span><span className="v">{brl(d.cancellationsCents)}</span></div>
            <div className="kv small"><span className="muted">· perdas (já preparado/entregue)</span><span className="v">{brl(d.lossCents)}</span></div>
            <Link to="/admin/cancelamentos" className="small">Ver cancelamentos →</Link>
          </div>
          <div className="card">
            <div className="panel-title">Mais vendidos</div>
            {!d.topProducts.length && <div className="muted small">Sem vendas.</div>}
            {d.topProducts.map((p) => <div key={p.name} className="kv"><span className="ellipsis">{p.name}</span><span className="v">{p.qty}×</span></div>)}
          </div>
        </div>

        <div className="card">
          <div className="panel-title">Faturamento no ano (acompanhamento do MEI)</div>
          <div className="row between wrap">
            <div className="big num" style={{ fontWeight: 800 }}>{brl(d.yearRevenueCents)}</div>
            <div className="small muted">{Math.round((d.yearRevenueCents / MEI_LIMIT) * 100)}% do teto de referência de {brl(MEI_LIMIT)}</div>
          </div>
          <div className="meter"><div style={{ width: `${Math.min(100, (d.yearRevenueCents / MEI_LIMIT) * 100)}%` }} /></div>
          <div className="small faint mt">Valor lançado no sistema. Confirme o teto vigente e as regras com o contador.</div>
        </div>
      </>}
    </div>
  );
}
