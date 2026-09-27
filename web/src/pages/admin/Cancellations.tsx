import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { brl, dateTime } from '../../format';
import { Badge, Spinner } from '../../components/ui';

type C = { id: number; createdAt: string; target: string; description: string; amountCents: number; reason: string; wasInPreparation: boolean; userName: string; accountNumber: number; accountId: number };

export default function Cancellations() {
  const [date, setDate] = useState('');
  const { data, isLoading } = useQuery({ queryKey: ['cancellations', date], queryFn: () => api.get<C[]>(`/api/cancellations${date ? `?date=${date}` : ''}`) });
  const total = (data ?? []).reduce((s, c) => s + c.amountCents, 0);
  const loss = (data ?? []).filter((c) => c.wasInPreparation).reduce((s, c) => s + c.amountCents, 0);
  return (
    <div className="col gap-lg">
      <div className="row between wrap">
        <h1>Cancelamentos</h1>
        <div className="row">
          <input type="date" className="input" style={{ width: 170 }} value={date} onChange={(e) => setDate(e.target.value)} />
          {date && <button className="btn ghost" onClick={() => setDate('')}>Todos</button>}
        </div>
      </div>
      {data && <div className="tiles">
        <div className="tile"><div className="label">Cancelamentos</div><div className="value num">{data.length}</div></div>
        <div className="tile"><div className="label">Valor cancelado</div><div className="value num">{brl(total)}</div></div>
        <div className="tile"><div className="label">Perdas (já preparado/entregue)</div><div className="value num" style={{ color: loss ? 'var(--danger)' : undefined }}>{brl(loss)}</div></div>
      </div>}
      {isLoading || !data ? <Spinner /> : !data.length ? <div className="card empty">Nenhum cancelamento.</div> : (
        <div className="card table-wrap" style={{ padding: 0 }}>
          <table className="table">
            <thead><tr><th>Quando</th><th>Conta</th><th>O quê</th><th>Motivo</th><th>Quem</th><th className="right">Valor</th></tr></thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.id}>
                  <td className="small">{dateTime(c.createdAt)}</td>
                  <td><Link to={`/admin/conta/${c.accountId}`} className="num">#{c.accountNumber}</Link></td>
                  <td>{c.description} {c.wasInPreparation && <Badge tone="danger">perda</Badge>} {c.target !== 'ITEM' && <Badge>{c.target === 'ORDER' ? 'pedido' : 'conta'}</Badge>}</td>
                  <td className="small">{c.reason}</td>
                  <td className="small muted">{c.userName}</td>
                  <td className="right num">{brl(c.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
