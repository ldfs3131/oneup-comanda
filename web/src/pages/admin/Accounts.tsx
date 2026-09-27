import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { brl, dateTime } from '../../format';
import type { AccountListItem } from '../../types';
import { AccountBadge, Spinner } from '../../components/ui';

const FILTERS = [
  { v: '', label: 'Todas' },
  { v: 'OPEN,PARTIALLY_PAID,PAID', label: 'Abertas' },
  { v: 'PENDING', label: 'Pendentes' },
  { v: 'CLOSED', label: 'Encerradas' },
  { v: 'CANCELLED', label: 'Canceladas' },
];

export default function Accounts() {
  const nav = useNavigate();
  const [status, setStatus] = useState('');
  const [date, setDate] = useState('');
  const [search, setSearch] = useState('');
  const qs = new URLSearchParams({ ...(status && { status }), ...(date && { date }), ...(search.trim() && { search: search.trim() }) }).toString();
  const { data, isLoading } = useQuery({ queryKey: ['accounts', qs], queryFn: () => api.get<AccountListItem[]>(`/api/accounts?${qs}`) });

  return (
    <div className="col gap-lg">
      <h1>Contas</h1>
      <div className="row wrap">
        <div className="seg">{FILTERS.map((f) => <button key={f.v} className={status === f.v ? 'on' : ''} onClick={() => setStatus(f.v)}>{f.label}</button>)}</div>
        <input type="date" className="input" style={{ width: 170 }} value={date} onChange={(e) => setDate(e.target.value)} />
        <input className="input" style={{ maxWidth: 260 }} placeholder="Nº, nome, observação, contato" value={search} onChange={(e) => setSearch(e.target.value)} />
        {(date || search || status) && <button className="btn ghost" onClick={() => { setDate(''); setSearch(''); setStatus(''); }}>Limpar</button>}
      </div>
      {isLoading || !data ? <Spinner /> : !data.length ? <div className="card empty">Nenhuma conta encontrada.</div> : (
        <div className="card table-wrap" style={{ padding: 0 }}>
          <table className="table">
            <thead><tr><th>Conta</th><th>Cliente / obs.</th><th>Aberta</th><th>Status</th><th className="right">Total</th><th className="right">Pago</th><th className="right">Saldo</th></tr></thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id} className="click" onClick={() => nav(`/admin/conta/${a.id}`)}>
                  <td className="num"><b>#{a.number}</b></td>
                  <td>{a.customerName ?? <span className="faint">—</span>}{a.note && <div className="small muted">{a.note}</div>}</td>
                  <td className="small">{dateTime(a.openedAt)}<div className="faint">{a.openedByName ?? (a.origin !== 'CAIXA' ? 'QR Code' : '')}</div></td>
                  <td><AccountBadge status={a.status} /></td>
                  <td className="right num">{brl(a.total)}</td>
                  <td className="right num">{brl(a.paid)}</td>
                  <td className="right num" style={{ fontWeight: 700 }}>{brl(a.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
