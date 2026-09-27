import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { brl, minutesSince, time } from '../../format';
import { AccountBadge, MoneyInput, Spinner, useAction } from '../../components/ui';
import { useBoard } from './CashierLayout';

export default function Board() {
  const { data, isLoading } = useBoard();
  const nav = useNavigate();
  const [q, setQ] = useState('');

  const list = useMemo(() => {
    const all = data?.accounts ?? [];
    const s = q.trim().toLowerCase().replace('#', '');
    if (!s) return all;
    return all.filter((a) => String(a.number) === s || (a.customerName ?? '').toLowerCase().includes(s) || (a.note ?? '').toLowerCase().includes(s));
  }, [data, q]);

  if (isLoading || !data) return <Spinner />;
  if (!data.register) return <OpenRegister />;

  const totalOpen = data.accounts.reduce((s, a) => s + a.balance, 0);

  return (
    <div className="col gap-lg">
      <div className="row between wrap" style={{ gap: 12 }}>
        <div>
          <h1>Contas abertas <span className="muted num">({data.accounts.length})</span></h1>
          <div className="muted small">Em aberto: <b className="num">{brl(totalOpen)}</b></div>
        </div>
        <input className="input" style={{ maxWidth: 320 }} placeholder="Buscar nº, nome ou observação" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="acc-grid">
        <button className="acc-card new" onClick={() => nav('/caixa/nova')}>
          <span className="plus">＋</span>
          <span>NOVA CONTA</span>
        </button>
        {list.map((a) => (
          <Link key={a.id} to={`/caixa/conta/${a.id}`} className={`acc-card${a.ready ? ' has-ready' : ''}`}>
            <div className="row between">
              <span className="acc-num">#{a.number}</span>
              <AccountBadge status={a.status} />
            </div>
            <div className="acc-name ellipsis">{a.customerName || <span className="faint">Sem nome</span>}</div>
            <div className="acc-note ellipsis">{a.note || ' '}</div>
            <div className="row between" style={{ marginTop: 'auto' }}>
              <div className="row small" style={{ gap: 10 }}>
                {a.inKitchen > 0 && <span className="pill warn">🍳 {a.inKitchen}</span>}
                {a.ready > 0 && <span className="pill ok">🔔 {a.ready} pronto</span>}
                {!a.inKitchen && !a.ready && a.lastOrderAt && <span className="faint">{time(a.lastOrderAt)} · {minutesSince(a.lastOrderAt)} min</span>}
              </div>
              <div className="acc-total num">{brl(a.balance)}</div>
            </div>
          </Link>
        ))}
      </div>
      {!list.length && q && <div className="empty">Nenhuma conta encontrada para “{q}”.</div>}
    </div>
  );
}

export function OpenRegister() {
  const [cash, setCash] = useState<number | null>(null);
  const { busy, run } = useAction();
  const qc = useQueryClient();
  return (
    <div className="page narrow" style={{ maxWidth: 480, paddingTop: 40 }}>
      <div className="card col gap-lg">
        <div>
          <h1>Caixa fechado</h1>
          <p className="muted">Para lançar contas e receber pagamentos, abra o caixa informando o dinheiro que está na gaveta.</p>
        </div>
        <label className="field">
          <span>Dinheiro inicial na gaveta</span>
          <MoneyInput value={cash} onChange={setCash} autoFocus />
        </label>
        <button className="btn go lg block" disabled={busy || cash == null} onClick={async () => {
          if (await run(() => api.post('/api/register/open', { openingCashCents: cash }), 'Caixa aberto.')) {
            qc.invalidateQueries({ queryKey: ['board'] }); qc.invalidateQueries({ queryKey: ['register'] });
          }
        }}>Abrir caixa</button>
      </div>
    </div>
  );
}
