import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { brl, minutesSince, minutesUntil, norm, time } from '../../format';
import { AccountBadge, MoneyInput, Spinner, useAction } from '../../components/ui';
import { useSettings } from '../../components/layout';
import { useBoard } from './CashierLayout';
import { BrandLogo } from '../../components/brand';
import { useMesaLabel } from '../../components/brand';

export default function Board() {
  const mesa = useMesaLabel();
  const { data, isLoading } = useBoard();
  const nav = useNavigate();
  const [q, setQ] = useState('');

  const list = useMemo(() => {
    const all = data?.accounts ?? [];
    const s = norm(q).replace('#', '');
    if (!s) return all;
    return all.filter((a) => String(a.number) === s || a.tableLabel === s
      || norm(a.customerName ?? '').includes(s) || norm(a.note ?? '').includes(s) || norm(a.tableLabel ?? '') === s);
  }, [data, q]);

  if (isLoading || !data) return <Spinner />;
  if (!data.register) return <OpenDay />;

  const totalOpen = data.accounts.reduce((s, a) => s + a.balance, 0);

  return (
    <div className="col gap-lg">
      <div className="row between wrap" style={{ gap: 12 }}>
        <div>
          <h1>Contas abertas <span className="muted num">({data.accounts.length})</span></h1>
          <div className="muted small">Em aberto: <b className="num">{brl(totalOpen)}</b></div>
        </div>
        <input className="input" style={{ maxWidth: 320 }} placeholder="Buscar nº, nome, mesa ou observação" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="acc-grid">
        <button className="acc-card new" onClick={() => nav('/caixa/nova')}>
          <span className="plus">＋</span>
          <span>NOVA CONTA</span>
        </button>
        {list.map((a) => {
          const eta = minutesUntil(a.nextReadyAt);
          return (
            <Link key={a.id} to={`/caixa/conta/${a.id}`} className={`acc-card${a.ready ? ' has-ready' : ''}`}>
              <div className="row between">
                <span className="acc-num">#{a.number}{a.tableLabel && <span className="table-tag">{mesa} {a.tableLabel}</span>}</span>
                <AccountBadge status={a.status} />
              </div>
              <div className="acc-name ellipsis">{a.customerName || <span className="faint">Cliente não informado</span>}</div>
              <div className="acc-note ellipsis">{a.note || ' '}</div>
              <div className="row between" style={{ marginTop: 'auto' }}>
                <div className="row small wrap" style={{ gap: 8 }}>
                  {a.inKitchen > 0 && <span className={`pill ${eta != null && eta < 0 ? 'danger' : 'warn'}`}>🍳 {a.inKitchen}{eta != null ? (eta >= 0 ? ` · ~${time(a.nextReadyAt)}` : ` · atrasado ${-eta} min`) : ''}</span>}
                  {a.ready > 0 && <span className="pill ok">🔔 {a.ready} pronto</span>}
                  {!a.inKitchen && !a.ready && a.lastOrderAt && <span className="faint">{time(a.lastOrderAt)} · {minutesSince(a.lastOrderAt)} min</span>}
                </div>
                <div className="acc-total num">{brl(a.balance)}</div>
              </div>
            </Link>
          );
        })}
      </div>
      {!list.length && q && <div className="empty">Nenhuma conta encontrada para “{q}”.</div>}
    </div>
  );
}

/** "Abrir o dia": abre o caixa (dinheiro inicial) e deixa o estabelecimento ABERTO. */
export function OpenDay() {
  const [cash, setCash] = useState<number | null>(null);
  const { busy, run } = useAction();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { data: settings } = useSettings();
  // troco sugerido pelo Dono em Configurações (o caixa pode mudar)
  const sugerido = settings?.config?.abertura_sugerida as number | undefined;
  useEffect(() => { if (cash == null && sugerido) setCash(sugerido); }, [sugerido]); // eslint-disable-line react-hooks/exhaustive-deps
  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  return (
    <div className="page narrow" style={{ maxWidth: 520, paddingTop: 32 }}>
      <div className="card col gap-lg open-day">
        <div className="center">
          <BrandLogo height={64} />
          <h1 style={{ marginTop: 12 }}>{hello}{user ? `, ${user.name.split(' ')[0]}` : ''}!</h1>
          <p className="muted">Para começar a lançar pedidos, abra o dia informando o dinheiro que está na gaveta. O estabelecimento fica <b>ABERTO</b> automaticamente.</p>
        </div>
        <label className="field">
          <span>Dinheiro inicial na gaveta (troco)</span>
          <MoneyInput value={cash} onChange={setCash} autoFocus />
        </label>
        <button className="btn go xl block" disabled={busy || cash == null} onClick={async () => {
          if (await run(() => api.post('/api/day/open', { openingCashCents: cash }), 'Dia aberto. Bom trabalho!')) {
            qc.invalidateQueries({ queryKey: ['board'] }); qc.invalidateQueries({ queryKey: ['register'] }); qc.invalidateQueries({ queryKey: ['settings'] });
          }
        }}>☀ Abrir o dia</button>
        <div className="small muted center">
          Estabelecimento agora: <b>{settings?.restaurant.isOpen ? 'ABERTO' : 'FECHADO'}</b> · Contas pendentes de outros dias continuam em “A receber”.
        </div>
      </div>
    </div>
  );
}
