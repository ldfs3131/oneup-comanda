import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { CONSUMPTION_LABEL, SITUATION, brl, dateTime, time } from '../format';
import type { Order } from '../types';
import { AccountBadge, Badge, Modal, OrderBadge, Spinner } from './ui';
import { useMesaLabel } from './brand';

type Detail = {
  order: Order;
  account: { id: number; number: number; customerName: string | null; note: string | null; contact: string | null; phone: string | null; tableLabel: string | null; status: string; totals: { subtotal: number; discounts: number; total: number; paid: number; balance: number } };
  payments: { id: number; amountCents: number; method: string; createdAt: string; userName: string; reversedAt: string | null }[];
  discounts: { id: number; amountCents: number; reason: string; userName: string; createdAt: string }[];
  timeline: { step: string; at: string | null; by: string | null }[];
  audit: { createdAt: string; message: string; userRole: string | null }[];
  corrections: { id: number; field: string; before: string | null; after: string; reason: string; createdAt: string }[];
};

const FIELD_PT: Record<string, string> = { startedAt: 'Início do preparo', readyAt: 'Pronto', deliveredAt: 'Entregue', confirmedAt: 'Envio à cozinha' };

/** Detalhe completo de um pedido sem sair da tela. */
export function OrderDetailModal({ orderId, onClose, onOpenAccount }: { orderId: number; onClose: () => void; onOpenAccount?: (accountId: number) => void }) {
  const mesa = useMesaLabel();
  const { user } = useAuth();
  const { data, isLoading, error } = useQuery({ queryKey: ['order', orderId], queryFn: () => api.get<Detail>(`/api/orders/${orderId}`) });
  const o = data?.order;
  return (
    <Modal wide title={o ? <>Pedido #{o.number} <span className="muted small">· conta #{data!.account.number}</span></> : 'Pedido'} onClose={onClose}
      footer={<>{data && onOpenAccount && <button className="btn" onClick={() => onOpenAccount(data.account.id)}>Abrir a conta</button>}<button className="btn primary" onClick={onClose}>Fechar</button></>}>
      {isLoading && <Spinner />}
      {error && <div className="empty">{(error as Error).message}</div>}
      {data && o && (
        <div className="col gap-lg">
          <div className="row wrap" style={{ gap: 8 }}>
            <OrderBadge status={o.status} />
            <Badge tone={SITUATION[o.situation]?.tone}>{SITUATION[o.situation]?.label}</Badge>
            <Badge tone={o.consumptionType === 'VIAGEM' ? 'warn' : 'muted'}>{CONSUMPTION_LABEL[o.consumptionType]}</Badge>
            {o.sequence > 1 && <Badge>complemento</Badge>}
            <AccountBadge status={data.account.status} />
          </div>
          <div className="grid-2">
            <div className="card tight">
              <div className="panel-title">Cliente</div>
              <div style={{ fontWeight: 800 }}>{data.account.customerName || <span className="faint">Cliente não informado</span>}</div>
              {data.account.tableLabel && <div className="muted">{mesa} {data.account.tableLabel}</div>}
              {data.account.note && <div className="muted">{data.account.note}</div>}
              {(data.account.contact || data.account.phone) && <div className="muted">📞 {[data.account.contact, data.account.phone].filter(Boolean).join(' · ')}</div>}
            </div>
            <div className="card tight">
              <div className="panel-title">Conta #{data.account.number}</div>
              <div className="kv"><span>Total da conta</span><span className="v">{brl(data.account.totals.total)}</span></div>
              <div className="kv"><span>Pago</span><span className="v">{brl(data.account.totals.paid)}</span></div>
              <div className="kv"><span>Saldo</span><span className="v">{brl(data.account.totals.balance)}</span></div>
            </div>
          </div>
          <div className="card tight">
            <div className="panel-title">Itens deste pedido · {brl(o.totalCents)}</div>
            {o.note && <div className="note-text small">Obs.: “{o.note}”</div>}
            {o.items.map((i) => (
              <div key={i.id} className={`item-row${i.status === 'CANCELLED' ? ' cancelled' : ''}`}>
                <span className="num qty">{i.quantity}×</span>
                <div className="grow">
                  <div>{i.productName}{i.isCustom && <span className="badge brand" style={{ marginLeft: 6 }}>outro</span>}</div>
                  {i.optionsSnapshot.length > 0 && <div className="small muted">{i.optionsSnapshot.map((x) => x.name).join(' · ')}</div>}
                  {i.note && <div className="small note-text">“{i.note}”</div>}
                  {i.cancellation && <div className="small cancel-text">Cancelado por {i.cancellation.userName} — {i.cancellation.reason}</div>}
                </div>
                <span className="num">{brl(i.unitPriceCents * i.quantity)}</span>
              </div>
            ))}
          </div>
          <div className="card tight">
            <div className="panel-title">Linha do tempo</div>
            <div className="timeline">
              {data.timeline.map((t, k) => (
                <div key={k} className={`tl-step${t.at ? ' done' : ''}`}>
                  <span className="tl-dot" />
                  <span className="grow">{t.step}</span>
                  <span className="small muted">{t.at ? `${time(t.at)}${t.by ? ` · ${t.by}` : ''}` : '—'}</span>
                </div>
              ))}
              {o.expectedReadyAt && !o.readyAt && o.status !== 'CANCELLED' && <div className="small muted">Previsão de pronto: <b>{time(o.expectedReadyAt)}</b></div>}
            </div>
          </div>
          {(data.payments.length > 0 || data.discounts.length > 0) && (
            <div className="card tight">
              <div className="panel-title">Pagamentos e descontos da conta</div>
              {data.payments.map((p) => <div key={p.id} className={`kv small${p.reversedAt ? ' strike' : ''}`}><span>💰 {p.method} · {dateTime(p.createdAt)} · {p.userName}</span><span className="v">{brl(p.amountCents)}</span></div>)}
              {data.discounts.map((d) => <div key={d.id} className="kv small"><span>🏷 {d.reason} · {d.userName}</span><span className="v">−{brl(d.amountCents)}</span></div>)}
            </div>
          )}
          {user?.role === 'ADMIN' && (data.audit.length > 0 || data.corrections.length > 0) && (
            <div className="card tight">
              <div className="panel-title">Auditoria (admin)</div>
              {data.corrections.map((c) => <div key={c.id} className="small kv"><span>✎ {FIELD_PT[c.field] ?? c.field}: {c.before ? time(c.before) : '—'} → {time(c.after)} · {c.reason}</span><span className="faint">{dateTime(c.createdAt)}</span></div>)}
              {data.audit.map((a, k) => <div key={k} className="small kv"><span>{a.message}</span><span className="faint">{time(a.createdAt)}</span></div>)}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
