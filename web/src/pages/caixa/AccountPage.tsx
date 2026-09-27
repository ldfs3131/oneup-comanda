import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { brl, dateTime, time } from '../../format';
import type { AccountDetail, Order, OrderItem } from '../../types';
import { AccountBadge, Badge, OrderBadge, ReasonModal, Spinner, useAction } from '../../components/ui';
import OrderComposer, { linesToItems } from './OrderComposer';
import { PaymentModal, DiscountModal, PendingModal, EditAccountModal } from './AccountModals';

const LIVE = ['OPEN', 'PARTIALLY_PAID', 'PAID'];

export default function AccountPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { user } = useAuth();
  const qc = useQueryClient();
  const { data: acc, isLoading, error } = useQuery({
    queryKey: ['account', Number(id)],
    queryFn: () => api.get<AccountDetail>(`/api/accounts/${id}`),
    refetchInterval: 30_000,
  });
  const { busy, run } = useAction();
  const [modal, setModal] = useState<null | 'add' | 'pay' | 'discount' | 'pending' | 'edit' | 'cancel' | 'reopen' | 'close'>(null);
  const [cancelItem, setCancelItem] = useState<OrderItem | null>(null);
  const [cancelOrder, setCancelOrder] = useState<Order | null>(null);
  const [reverse, setReverse] = useState<number | null>(null);

  if (isLoading) return <Spinner />;
  if (error || !acc) return <div className="empty">Conta não encontrada. <button className="btn" onClick={() => nav(-1)}>Voltar</button></div>;

  const t = acc.totals;
  const isAdmin = user?.role === 'ADMIN';
  const live = LIVE.includes(acc.status);
  const editable = acc.status !== 'CLOSED' && acc.status !== 'CANCELLED';
  const refresh = () => { qc.invalidateQueries({ queryKey: ['account', acc.id] }); qc.invalidateQueries({ queryKey: ['board'] }); };
  const act = async (fn: () => Promise<unknown>, msg?: string) => { const ok = await run(fn, msg); if (ok) refresh(); return ok; };
  const orders = [...acc.orders].reverse(); // mais recente primeiro

  return (
    <div className="col gap-lg">
    <div className="row wrap" style={{ gap: 12 }}>
      <button className="btn ghost" onClick={() => nav(-1)}>← Voltar</button>
      <h1 className="num">Conta #{acc.number}</h1>
      <AccountBadge status={acc.status} />
      {acc.origin !== 'CAIXA' && <Badge tone="brand">{acc.origin === 'QR_CODE' ? 'QR Code' : acc.origin}</Badge>}
    </div>
    <div className="acc-page">
      <div className="acc-main col gap-lg">

        <div className="card acc-ident">
          <div className="grow">
            <div className="big" style={{ fontWeight: 800 }}>{acc.customerName || <span className="faint">Cliente sem nome</span>}</div>
            {acc.note && <div className="muted">{acc.note}</div>}
            {acc.contact && <div className="muted">📞 {acc.contact}</div>}
            <div className="small faint mt">Aberta {dateTime(acc.openedAt)}{acc.closedAt ? ` · encerrada ${dateTime(acc.closedAt)}` : ''}</div>
          </div>
          {editable && <button className="btn sm" onClick={() => setModal('edit')}>Editar</button>}
        </div>

        {live && (
          <button className="btn primary xl block" onClick={() => setModal('add')}>＋ Adicionar itens (novo pedido)</button>
        )}

        <div className="col" style={{ gap: 12 }}>
          {!orders.length && <div className="card empty">Nenhum pedido ainda.</div>}
          {orders.map((o) => (
            <div key={o.id} className={`card order-card${o.status === 'CANCELLED' ? ' cancelled' : ''}`}>
              <div className="row between wrap">
                <div className="row" style={{ gap: 10 }}>
                  <b className="num">Pedido #{o.number}</b>
                  {o.sequence > 1 && <span className="faint small">complemento</span>}
                  <span className="faint small">{time(o.createdAt)}</span>
                  {!o.goesToKitchen && o.status === 'DELIVERED' && <span className="faint small">balcão</span>}
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <OrderBadge status={o.status} />
                  {o.status === 'READY' && <button className="btn sm go" disabled={busy} onClick={() => act(() => api.post(`/api/orders/${o.id}/deliver`))}>✓ Entregue</button>}
                  {editable && o.status !== 'CANCELLED' && <button className="btn sm danger" onClick={() => setCancelOrder(o)}>Cancelar pedido</button>}
                </div>
              </div>
              {o.problemNote && (
                <div className="problem-box">⚠ Cozinha: “{o.problemNote}” <button className="btn sm" onClick={() => act(() => api.post(`/api/orders/${o.id}/clear-problem`))}>Resolvido</button></div>
              )}
              {o.note && <div className="note-text small">Obs.: “{o.note}”</div>}
              <div className="item-list">
                {o.items.map((i) => (
                  <div key={i.id} className={`item-row${i.status === 'CANCELLED' ? ' cancelled' : ''}`}>
                    <span className="num qty">{i.quantity}×</span>
                    <div className="grow">
                      <div>{i.productName}</div>
                      {i.optionsSnapshot.length > 0 && <div className="small muted">{i.optionsSnapshot.map((x) => x.name).join(' · ')}</div>}
                      {i.note && <div className="small note-text">“{i.note}”</div>}
                      {i.cancellation && (
                        <div className="small cancel-text">
                          Cancelado por {i.cancellation.userName} às {time(i.cancellation.createdAt)} — {i.cancellation.reason}
                          {i.cancellation.wasInPreparation && ' · perda'}
                        </div>
                      )}
                    </div>
                    <span className="num">{brl(i.unitPriceCents * i.quantity)}</span>
                    {editable && i.status === 'ACTIVE' && (
                      <button className="btn sm ghost icon" title="Cancelar item" onClick={() => setCancelItem(i)}>✕</button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {(acc.payments.length > 0 || acc.discounts.length > 0 || acc.cancellations.length > 0) && (
          <div className="card">
            <div className="panel-title">Movimentações</div>
            {acc.payments.map((p) => (
              <div key={`p${p.id}`} className={`kv${p.reversedAt ? ' strike' : ''}`}>
                <span>
                  💰 {p.method} <span className="faint small">· {dateTime(p.createdAt)} · {p.userName}</span>
                  {p.tenderedCents ? <span className="faint small"> · recebido {brl(p.tenderedCents)}, troco {brl(p.tenderedCents - p.amountCents)}</span> : null}
                  {p.reversedAt && <span className="small cancel-text"> · estornado: {p.reversalReason}</span>}
                </span>
                <span className="row">
                  <span className="v">{brl(p.amountCents)}</span>
                  {isAdmin && !p.reversedAt && acc.status !== 'CLOSED' && <button className="btn sm ghost" onClick={() => setReverse(p.id)}>Estornar</button>}
                </span>
              </div>
            ))}
            {acc.discounts.map((d) => (
              <div key={`d${d.id}`} className="kv">
                <span>🏷 {d.kind === 'DISCOUNT' ? 'Desconto' : 'Ajuste'} <span className="faint small">· {dateTime(d.createdAt)} · {d.userName} · {d.reason}</span></span>
                <span className="v">−{brl(d.amountCents)}</span>
              </div>
            ))}
            {acc.cancellations.filter((c) => c.target !== 'ITEM').map((c) => (
              <div key={`c${c.id}`} className="kv">
                <span className="cancel-text">✕ {c.description} <span className="faint small">· {dateTime(c.createdAt)} · {c.userName} · {c.reason}</span></span>
                <span className="v strike">{brl(c.amountCents)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <aside className="acc-side">
        <div className="card col totals-card">
          <div className="kv"><span>Subtotal</span><span className="v">{brl(t.subtotal)}</span></div>
          {t.discounts > 0 && <div className="kv"><span>Descontos/ajustes</span><span className="v">−{brl(t.discounts)}</span></div>}
          <div className="kv"><span>Total</span><span className="v">{brl(t.total)}</span></div>
          <div className="kv"><span>Pago</span><span className="v">{brl(t.paid)}</span></div>
          <div className={`balance ${t.balance > 0 ? 'due' : 'zero'}`}>
            <span>Saldo</span><span className="num">{brl(t.balance)}</span>
          </div>

          {editable && t.balance > 0 && <button className="btn go xl block" onClick={() => setModal('pay')}>Receber pagamento</button>}
          {editable && t.balance === 0 && t.total > 0 && acc.status !== 'CLOSED' && (
            <button className="btn go xl block" disabled={busy} onClick={() => act(() => api.post(`/api/accounts/${acc.id}/close`), `Conta #${acc.number} encerrada.`)}>Encerrar conta</button>
          )}
          {editable && t.balance > 0 && <button className="btn block" onClick={() => setModal('discount')}>Desconto / ajuste</button>}
          {['OPEN', 'PARTIALLY_PAID'].includes(acc.status) && t.balance > 0 && (
            <button className="btn block" onClick={() => setModal('pending')}>Cliente saiu sem pagar → Pendente</button>
          )}
          {editable && t.paid === 0 && <button className="btn danger block" onClick={() => setModal('cancel')}>Cancelar conta</button>}
          {isAdmin && ['CLOSED', 'PENDING'].includes(acc.status) && <button className="btn block" onClick={() => setModal('reopen')}>Reabrir conta</button>}
          {!isAdmin && acc.status === 'CLOSED' && <div className="small muted center">Conta encerrada. Só o administrador pode reabrir.</div>}
        </div>
      </aside>

      {modal === 'add' && (
        <div className="sheet">
          <div className="sheet-head">
            <button className="btn ghost" onClick={() => setModal(null)}>← Voltar à conta</button>
            <h2 className="num">Novo pedido · Conta #{acc.number}{acc.customerName ? ` · ${acc.customerName}` : ''}</h2>
          </div>
          <div className="sheet-body">
            <OrderComposer busy={busy} submitLabel="Enviar pedido" onSubmit={async (lines, note) => {
              const ok = await act(() => api.post(`/api/accounts/${acc.id}/orders`, { items: linesToItems(lines), note }), 'Pedido enviado.');
              if (ok) setModal(null);
              return ok;
            }} />
          </div>
        </div>
      )}
      {modal === 'pay' && <PaymentModal account={acc} onClose={() => setModal(null)} onDone={refresh} />}
      {modal === 'discount' && <DiscountModal account={acc} onClose={() => setModal(null)} onDone={refresh} />}
      {modal === 'pending' && <PendingModal account={acc} onClose={() => setModal(null)} onDone={refresh} />}
      {modal === 'edit' && <EditAccountModal account={acc} onClose={() => setModal(null)} onDone={refresh} />}
      {modal === 'cancel' && (
        <ReasonModal title={`Cancelar conta #${acc.number}`} confirmLabel="Cancelar conta" danger
          description="Todos os pedidos da conta serão cancelados. O registro fica no histórico."
          suggestions={['Cliente desistiu', 'Conta aberta por engano', 'Conta duplicada']}
          onClose={() => setModal(null)}
          onConfirm={(reason) => act(() => api.post(`/api/accounts/${acc.id}/cancel`, { reason }), 'Conta cancelada.')} />
      )}
      {modal === 'reopen' && (
        <ReasonModal title={`Reabrir conta #${acc.number}`} confirmLabel="Reabrir"
          suggestions={['Cliente esqueceu de pagar um item', 'Pagamento lançado errado']}
          onClose={() => setModal(null)}
          onConfirm={(reason) => act(() => api.post(`/api/accounts/${acc.id}/reopen`, { reason }), 'Conta reaberta.')} />
      )}
      {cancelItem && (
        <ReasonModal title={`Cancelar ${cancelItem.quantity}× ${cancelItem.productName}`} confirmLabel="Cancelar item" danger
          description={<>Valor: <b>{brl(cancelItem.unitPriceCents * cancelItem.quantity)}</b>. O item fica registrado como cancelado.</>}
          suggestions={['Cliente desistiu', 'Lançado errado', 'Produto em falta', 'Demorou demais']}
          onClose={() => setCancelItem(null)}
          onConfirm={(reason) => act(() => api.post(`/api/order-items/${cancelItem.id}/cancel`, { reason }), 'Item cancelado.')} />
      )}
      {cancelOrder && (
        <ReasonModal title={`Cancelar pedido #${cancelOrder.number}`} confirmLabel="Cancelar pedido" danger
          description={['IN_PREPARATION', 'READY', 'DELIVERED'].includes(cancelOrder.status) ? 'Este pedido já foi preparado/entregue: será registrado como perda.' : 'A cozinha será avisada.'}
          suggestions={['Cliente desistiu', 'Lançado errado', 'Produto em falta']}
          onClose={() => setCancelOrder(null)}
          onConfirm={(reason) => act(() => api.post(`/api/orders/${cancelOrder.id}/cancel`, { reason }), 'Pedido cancelado.')} />
      )}
      {reverse && (
        <ReasonModal title="Estornar pagamento" confirmLabel="Estornar" danger
          onClose={() => setReverse(null)}
          onConfirm={(reason) => act(() => api.post(`/api/payments/${reverse}/reverse`, { reason }), 'Pagamento estornado.')} />
      )}
    </div>
    </div>
  );
}

