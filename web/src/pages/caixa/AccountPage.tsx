import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { CONSUMPTION_LABEL, ORIGIN_LABEL, SITUATION, brl, dateTime, minutesUntil, time } from '../../format';
import type { AccountDetail, Consumption, Order, OrderItem, StockDecision } from '../../types';
import { AccountBadge, Badge, OrderBadge, ReasonModal, Spinner, useAction } from '../../components/ui';
import { useStockGuard } from '../../components/stock';
import { OrderDetailModal } from '../../components/OrderDetail';
import OrderComposer, { linesToItems, useMenu } from './OrderComposer';
import { CancelItemModal, DiscountModal, EditAccountModal, PaymentModal, PendingModal, PickAccountModal } from './AccountModals';
import { useBase } from './Receivables';

const LIVE = ['OPEN', 'PARTIALLY_PAID', 'PAID'];
const LOSS = ['IN_PREPARATION', 'READY', 'DELIVERED'];

export default function AccountPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const base = useBase();
  const { user } = useAuth();
  const qc = useQueryClient();
  const { data: menu } = useMenu();
  const { data: acc, isLoading, error } = useQuery({
    queryKey: ['account', Number(id)],
    queryFn: () => api.get<AccountDetail>(`/api/accounts/${id}`),
    refetchInterval: 30_000,
  });
  const { busy, run } = useAction();
  const { guard, modal: stockModal, busy: sending } = useStockGuard();
  const [modal, setModal] = useState<null | 'add' | 'pay' | 'discount' | 'pending' | 'edit' | 'cancel' | 'reopen' | 'merge'>(null);
  const [cancelItem, setCancelItem] = useState<{ item: OrderItem; delivered: boolean } | null>(null);
  const [cancelOrder, setCancelOrder] = useState<Order | null>(null);
  const [transfer, setTransfer] = useState<Order | null>(null);
  const [detail, setDetail] = useState<number | null>(null);
  const [reverse, setReverse] = useState<number | null>(null);
  const [returnStock, setReturnStock] = useState(true);

  if (isLoading) return <Spinner />;
  if (error || !acc) return <div className="empty">{(error as Error)?.message ?? 'Conta não encontrada.'} <button className="btn" onClick={() => nav(-1)}>Voltar</button></div>;

  const t = acc.totals;
  const isAdmin = user?.role === 'ADMIN';
  const live = LIVE.includes(acc.status);
  const editable = !['CLOSED', 'CANCELLED', 'MERGED'].includes(acc.status);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['account', acc.id] }); qc.invalidateQueries({ queryKey: ['board'] }); qc.invalidateQueries({ queryKey: ['menu'] }); };
  const act = async (fn: () => Promise<unknown>, msg?: string) => { const ok = await run(fn, msg); if (ok) refresh(); return ok; };
  const orders = [...acc.orders].reverse(); // mais recente primeiro

  const sendOrder = async (items: unknown[], note: string, consumptionType: Consumption, okMsg = 'Pedido enviado.') => {
    const key = api.newKey();
    let n = 0;
    const r = await guard((stockDecisions?: StockDecision[]) =>
      api.post(`/api/accounts/${acc.id}/orders`, { items, note, consumptionType, stockDecisions }, `${key}-${n++}`), okMsg);
    if (r) refresh();
    return !!r;
  };

  /** "+1 / repetir": cria um novo lote SÓ com a diferença (a cozinha recebe só isso). */
  const repeat = (i: OrderItem, o: Order) => {
    if (i.isCustom) {
      return sendOrder([{ custom: { description: i.productName, priceCents: i.unitPriceCents, goesToKitchen: i.goesToKitchen }, quantity: 1 }], '', o.consumptionType, `+1 ${i.productName} lançado.`);
    }
    const p = menu?.flatMap((c) => c.products).find((x) => x.id === i.productId);
    if (!p || !p.available) { run(async () => { throw new Error(`${i.productName} não está disponível agora.`); }); return; }
    const optionIds = i.optionsSnapshot.map((s) => p.groups.find((g) => g.name === s.group)?.options.find((op) => op.name === s.name)?.id).filter((x): x is number => !!x);
    return sendOrder([{ productId: p.id, quantity: 1, optionIds, note: i.note }], '', o.consumptionType, `+1 ${i.productName} lançado${i.goesToKitchen ? ' (cozinha recebe só este)' : ''}.`);
  };

  return (
    <div className="col gap-lg">
      <div className="row wrap" style={{ gap: 12 }}>
        <button className="btn ghost" onClick={() => nav(-1)}>← Voltar</button>
        <h1 className="num">Conta #{acc.number}</h1>
        <AccountBadge status={acc.status} />
        {acc.tableLabel && <Badge tone="info">Mesa {acc.tableLabel}</Badge>}
        {acc.origin !== 'CAIXA' && <Badge tone="brand">{ORIGIN_LABEL[acc.origin] ?? acc.origin}</Badge>}
      </div>
      {acc.status === 'MERGED' && acc.mergedInto && (
        <div className="info-box">Esta conta foi <b>juntada</b> na conta #{acc.mergedIntoNumber}. <button className="btn sm" onClick={() => nav(`${base}/conta/${acc.mergedInto}`)}>Abrir conta #{acc.mergedIntoNumber}</button></div>
      )}
      <div className="acc-page">
        <div className="acc-main col gap-lg">

          <div className="card acc-ident">
            <div className="grow">
              <div className="big" style={{ fontWeight: 800 }}>{acc.customerName || <span className="faint">Cliente não informado</span>}</div>
              {acc.note && <div className="muted">{acc.note}</div>}
              {(acc.contact || acc.phone) && <div className="muted">📞 {[acc.contact, acc.phone].filter(Boolean).join(' · ')}</div>}
              <div className="small faint mt">Aberta {dateTime(acc.openedAt)}{acc.closedAt ? ` · encerrada ${dateTime(acc.closedAt)}` : ''}</div>
            </div>
            {editable && <button className="btn sm" onClick={() => setModal('edit')}>Editar</button>}
          </div>

          {live && (
            <button className="btn primary xl block" onClick={() => setModal('add')}>＋ Adicionar itens (novo pedido)</button>
          )}

          <div className="col" style={{ gap: 12 }}>
            {!orders.length && <div className="card empty">Nenhum pedido ainda.</div>}
            {orders.map((o) => {
              const eta = minutesUntil(o.expectedReadyAt);
              const inKitchen = ['CONFIRMED', 'IN_PREPARATION'].includes(o.status);
              return (
                <div key={o.id} className={`card order-card${o.status === 'CANCELLED' ? ' cancelled' : ''}`}>
                  <div className="row between wrap">
                    <div className="row wrap" style={{ gap: 8 }}>
                      <button className="linkish" onClick={() => setDetail(o.id)}><b className="num">Pedido #{o.number}</b></button>
                      {o.sequence > 1 && <span className="faint small">complemento</span>}
                      <span className="faint small">{time(o.createdAt)}</span>
                      {o.consumptionType === 'VIAGEM' && <span className="viagem-tag">VIAGEM</span>}
                      {!o.goesToKitchen && o.status === 'DELIVERED' && <span className="faint small">balcão</span>}
                      {inKitchen && eta != null && <span className={`small ${eta < 0 ? 'cancel-text' : 'muted'}`}>{eta >= 0 ? `previsão ${time(o.expectedReadyAt)}` : `atrasado ${-eta} min`}</span>}
                    </div>
                    <div className="row wrap" style={{ gap: 6 }}>
                      {o.status !== 'CANCELLED' && o.status !== 'AWAITING_CONFIRMATION' && <Badge tone={SITUATION[o.situation]?.tone}>{SITUATION[o.situation]?.label}</Badge>}
                      <OrderBadge status={o.status} />
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
                          <div>{i.productName}{i.isCustom && <span className="badge brand" style={{ marginLeft: 6 }}>outro</span>}</div>
                          {i.optionsSnapshot.length > 0 && <div className="small muted">{i.optionsSnapshot.map((x) => x.name).join(' · ')}</div>}
                          {i.note && <div className="small note-text">“{i.note}”</div>}
                          {i.cancellation && (
                            <div className="small cancel-text">
                              Cancelado por {i.cancellation.userName} às {time(i.cancellation.createdAt)} — {i.cancellation.reason}
                              {i.cancellation.wasInPreparation && ' · perda'}{i.cancellation.stockReturned && ' · voltou ao estoque'}
                            </div>
                          )}
                        </div>
                        <span className="num">{brl(i.unitPriceCents * i.quantity)}</span>
                        {live && i.status === 'ACTIVE' && o.status !== 'CANCELLED' && o.status !== 'AWAITING_CONFIRMATION' && (
                          <button className="btn sm ghost" title="Lançar mais 1 (novo lote)" disabled={sending} onClick={() => repeat(i, o)}>+1</button>
                        )}
                        {editable && i.status === 'ACTIVE' && (
                          <button className="btn sm ghost icon" title="Cancelar / reduzir quantidade" onClick={() => setCancelItem({ item: i, delivered: o.status === 'DELIVERED' })}>✕</button>
                        )}
                      </div>
                    ))}
                  </div>
                  {o.status !== 'CANCELLED' && (
                    <div className="order-actions">
                      <button className="btn sm ghost" onClick={() => setDetail(o.id)}>Detalhes</button>
                      {editable && ['CONFIRMED', 'IN_PREPARATION', 'NEW', 'AWAITING_CONFIRMATION'].includes(o.status) && (
                        <button className="btn sm ghost" disabled={busy} onClick={() => act(() => api.patch(`/api/orders/${o.id}/consumption`, { consumptionType: o.consumptionType === 'VIAGEM' ? 'LOCAL' : 'VIAGEM' }), 'Tipo de consumo alterado.')}>
                          Mudar → {o.consumptionType === 'VIAGEM' ? CONSUMPTION_LABEL.LOCAL : CONSUMPTION_LABEL.VIAGEM}
                        </button>
                      )}
                      {live && <button className="btn sm ghost" onClick={() => setTransfer(o)}>Transferir</button>}
                      {editable && <button className="btn sm danger" onClick={() => { setReturnStock(o.status !== 'DELIVERED'); setCancelOrder(o); }}>Cancelar pedido</button>}
                      {o.status === 'READY' && <button className="btn sm go" disabled={busy} onClick={() => act(() => api.post(`/api/orders/${o.id}/deliver`))}>✓ Entregue</button>}
                    </div>
                  )}
                </div>
              );
            })}
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
                  <span>🏷 {d.kind === 'DISCOUNT' ? 'Desconto' : 'Ajuste'} <span className="faint small">· {dateTime(d.createdAt)} · {d.userName} · {d.reason}{d.totalBeforeCents != null ? ` · total ${brl(d.totalBeforeCents)} → ${brl(d.totalAfterCents)}` : ''}</span></span>
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
            {live && <button className="btn block" onClick={() => setModal('merge')}>Juntar com outra conta</button>}
            {editable && t.paid === 0 && <button className="btn danger block" onClick={() => { setReturnStock(true); setModal('cancel'); }}>Cancelar conta</button>}
            {isAdmin && ['CLOSED', 'PENDING'].includes(acc.status) && <button className="btn block" onClick={() => setModal('reopen')}>Reabrir conta</button>}
            {!isAdmin && acc.status === 'CLOSED' && <div className="small muted center">Conta encerrada. Para lançar mais itens, abra uma nova conta. Só o administrador reabre.</div>}
          </div>
        </aside>

        {modal === 'add' && (
          <div className="sheet">
            <div className="sheet-head">
              <button className="btn ghost" onClick={() => setModal(null)}>← Voltar à conta</button>
              <h2 className="num ellipsis">Novo pedido · Conta #{acc.number}{acc.customerName ? ` · ${acc.customerName}` : ''}</h2>
            </div>
            <div className="sheet-body">
              <div className="info-box small" style={{ marginBottom: 10 }}>A cozinha recebe <b>somente os itens deste novo pedido</b>. O que já foi feito aparece para ela só como referência.</div>
              <OrderComposer busy={sending} submitLabel="Enviar pedido" onSubmit={async (lines, note, consumption) => {
                const ok = await sendOrder(linesToItems(lines), note, consumption);
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
        {modal === 'merge' && (
          <PickAccountModal title={`Juntar a conta #${acc.number} em outra`} excludeId={acc.id} confirmLabel="Juntar contas"
            description={`Todos os pedidos, pagamentos e descontos da conta #${acc.number} passam para a conta escolhida. Esta conta fica como “Juntada” (nada é apagado).`}
            onClose={() => setModal(null)}
            onPick={async (target) => { const ok = await run(() => api.post(`/api/accounts/${acc.id}/merge`, { targetId: target }), 'Contas juntadas.'); if (ok) { refresh(); nav(`${base}/conta/${target}`, { replace: true }); } return ok; }} />
        )}
        {transfer && (
          <PickAccountModal title={`Transferir pedido #${transfer.number}`} excludeId={acc.id} confirmLabel="Transferir"
            description="O pedido inteiro (itens e valor) vai para a conta escolhida. Pagamentos continuam onde foram feitos."
            onClose={() => setTransfer(null)}
            onPick={(target) => act(() => api.post(`/api/orders/${transfer.id}/transfer`, { targetAccountId: target }), 'Pedido transferido.')} />
        )}
        {modal === 'cancel' && (
          <ReasonModal title={`Cancelar conta #${acc.number}`} confirmLabel="Cancelar conta" danger
            description={<>
              Todos os pedidos da conta serão cancelados. O registro fica no histórico.
              <label className="check mt"><input type="checkbox" checked={returnStock} onChange={(e) => setReturnStock(e.target.checked)} />Devolver ao estoque os produtos não entregues</label>
            </>}
            suggestions={['Cliente desistiu', 'Conta aberta por engano', 'Conta duplicada']}
            onClose={() => setModal(null)}
            onConfirm={(reason) => act(() => api.post(`/api/accounts/${acc.id}/cancel`, { reason, returnStock }), 'Conta cancelada.')} />
        )}
        {modal === 'reopen' && (
          <ReasonModal title={`Reabrir conta #${acc.number}`} confirmLabel="Reabrir"
            suggestions={['Cliente esqueceu de pagar um item', 'Pagamento lançado errado']}
            onClose={() => setModal(null)}
            onConfirm={(reason) => act(() => api.post(`/api/accounts/${acc.id}/reopen`, { reason }), 'Conta reaberta.')} />
        )}
        {cancelItem && <CancelItemModal item={cancelItem.item} delivered={cancelItem.delivered} onClose={() => setCancelItem(null)} onDone={refresh} />}
        {cancelOrder && (
          <ReasonModal title={`Cancelar pedido #${cancelOrder.number}`} confirmLabel="Cancelar pedido" danger
            description={<>
              {LOSS.includes(cancelOrder.status) ? 'Este pedido já foi preparado/entregue: será registrado como perda.' : 'A cozinha será avisada.'}
              <label className="check mt"><input type="checkbox" checked={returnStock} onChange={(e) => setReturnStock(e.target.checked)} />Devolver ao estoque (produtos com estoque, intactos)</label>
            </>}
            suggestions={['Cliente desistiu', 'Lançado errado', 'Produto em falta']}
            onClose={() => setCancelOrder(null)}
            onConfirm={(reason) => act(() => api.post(`/api/orders/${cancelOrder.id}/cancel`, { reason, returnStock }), 'Pedido cancelado.')} />
        )}
        {reverse && (
          <ReasonModal title="Estornar pagamento" confirmLabel="Estornar" danger
            onClose={() => setReverse(null)}
            onConfirm={(reason) => act(() => api.post(`/api/payments/${reverse}/reverse`, { reason }), 'Pagamento estornado.')} />
        )}
        {detail && <OrderDetailModal orderId={detail} onClose={() => setDetail(null)} />}
        {stockModal}
      </div>
    </div>
  );
}
