import { useNavigate, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { brl, dateOnly, minutesSince } from '../../format';
import type { AccountListItem } from '../../types';
import { Spinner } from '../../components/ui';

export function useBase() {
  return useLocation().pathname.startsWith('/admin') ? '/admin' : '/caixa';
}

export default function Receivables() {
  const nav = useNavigate();
  const base = useBase();
  const { data, isLoading } = useQuery({ queryKey: ['receivable'], queryFn: () => api.get<AccountListItem[]>('/api/accounts/receivable') });
  if (isLoading || !data) return <Spinner />;
  const total = data.reduce((s, a) => s + a.balance, 0);
  return (
    <div className="col gap-lg">
      <div className="row between wrap">
        <h1>Contas a receber</h1>
        <div className="tile" style={{ minWidth: 220 }}>
          <div className="label">Total pendente · {data.length} conta(s)</div>
          <div className="value" style={{ color: 'var(--danger)' }}>{brl(total)}</div>
        </div>
      </div>
      {!data.length ? <div className="card empty">Nenhuma conta pendente. 🎉</div> : (
        <div className="card table-wrap" style={{ padding: 0 }}>
          <table className="table">
            <thead><tr><th>Conta</th><th>Cliente</th><th>Contato</th><th>Data</th><th className="right">Total</th><th className="right">Pago</th><th className="right">Pendente</th><th className="hide-mobile">Responsável</th></tr></thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id} className="click" onClick={() => nav(`${base}/conta/${a.id}`)}>
                  <td className="num"><b>#{a.number}</b></td>
                  <td><b>{a.customerName}</b>{a.note && <div className="small muted">{a.note}</div>}</td>
                  <td>{a.contact}</td>
                  <td className="small">{dateOnly(a.pendingAt ?? a.openedAt)}<div className="faint">{Math.floor(minutesSince(a.pendingAt ?? a.openedAt) / 1440)} dia(s)</div></td>
                  <td className="right num">{brl(a.total)}</td>
                  <td className="right num">{brl(a.paid)}</td>
                  <td className="right num" style={{ color: 'var(--danger)', fontWeight: 800 }}>{brl(a.balance)}</td>
                  <td className="small muted hide-mobile">{a.pendingByName ?? a.openedByName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="small muted">Toque em uma conta para receber o saldo. O recebimento entra no caixa do dia em que for pago.</div>
    </div>
  );
}
