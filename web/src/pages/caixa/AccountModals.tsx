import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, chaveDoEnvio, type ChaveEnvio } from '../../api';
import { addDaysISO, brl, todayISO } from '../../format';
import type { AccountDetail, Board, OrderItem, PaymentMethod } from '../../types';
import { Modal, MoneyInput, useAction } from '../../components/ui';
import { useMesaLabel } from '../../components/brand';

const chavesPagamento = new Map<number, ChaveEnvio>();

type Part = { methodId: number; amountCents: number; tenderedCents: number | null };

export function PaymentModal({ account, onClose, onDone }: { account: AccountDetail; onClose: () => void; onDone: () => void }) {
  const { data: methods = [] } = useQuery({ queryKey: ['methods'], queryFn: () => api.get<PaymentMethod[]>('/api/payment-methods'), staleTime: 300_000 });
  const balance = account.totals.balance;
  const [parts, setParts] = useState<Part[]>([]);
  const used = parts.reduce((s, p) => s + p.amountCents, 0);
  const remaining = balance - used;
  const [methodId, setMethodId] = useState<number | null>(null);
  const [amount, setAmount] = useState<number | null>(balance);
  const [tendered, setTendered] = useState<number | null>(null);
  const [split, setSplit] = useState(1);
  const { busy, run } = useAction();

  const method = methods.find((m) => m.id === methodId);
  const curAmount = amount ?? 0;
  const change = method?.isCash && tendered != null ? tendered - curAmount : null;
  const currentValid = !!method && curAmount > 0 && curAmount <= remaining && (!method.isCash || tendered == null || tendered >= curAmount);
  const all: Part[] = useMemo(
    () => (currentValid ? [...parts, { methodId: methodId!, amountCents: curAmount, tenderedCents: method?.isCash ? tendered : null }] : parts),
    [parts, currentValid, methodId, curAmount, tendered, method],
  );
  const total = all.reduce((s, p) => s + p.amountCents, 0);
  const full = total === balance;

  const pushPart = () => {
    if (!currentValid) return;
    setParts([...parts, { methodId: methodId!, amountCents: curAmount, tenderedCents: method?.isCash ? tendered : null }]);
    setMethodId(null); setAmount(remaining - curAmount); setTendered(null);
  };

  const submit = async (close: boolean) => {
    // a chave fica guardada por conta: fechar e reabrir a janela depois de uma falha de internet não paga duas vezes
    const ref = chavesPagamento.get(account.id) ?? chavesPagamento.set(account.id, { current: null }).get(account.id)!;
    const corpo = { payments: all, close };
    const ok = await run(() => api.post(`/api/accounts/${account.id}/payments`, corpo, chaveDoEnvio(ref, { conta: account.id, saldo: balance, ...corpo })),
      close && full ? `Conta #${account.number} paga e encerrada.` : 'Pagamento registrado.');
    if (ok) { ref.current = null; onDone(); onClose(); }
  };

  const name = (id: number) => methods.find((m) => m.id === id)?.name ?? '';

  return (
    <Modal title={`Receber · Conta #${account.number}`} onClose={onClose} footer={<>
      {full ? <>
        <button className="btn" disabled={busy} onClick={() => submit(false)}>Só receber</button>
        <button className="btn go lg" disabled={busy} onClick={() => submit(true)}>Receber {brl(total)} e encerrar</button>
      </> : (
        <button className="btn primary lg" disabled={busy || total <= 0} onClick={() => submit(false)}>
          {total > 0 ? `Registrar ${brl(total)} (parcial)` : 'Escolha a forma de pagamento'}
        </button>
      )}
    </>}>
      <div className="pay-due">
        <span className="muted">Saldo da conta</span>
        <span className="num">{brl(balance)}</span>
      </div>
      <div className="split-row">
        <span className="small muted">Dividir em</span>
        <div className="stepper">
          <button onClick={() => setSplit((n) => Math.max(1, n - 1))} aria-label="Menos pessoas">−</button>
          <span className="num">{split}</span>
          <button onClick={() => setSplit((n) => Math.min(20, n + 1))} aria-label="Mais pessoas">+</button>
        </div>
        <span className="small muted">{split === 1 ? 'pessoa' : 'pessoas'}</span>
        {split > 1 && <>
          <b className="num">{brl(Math.ceil(balance / split))}</b><span className="small muted">cada</span>
          <button className="btn sm" onClick={() => setAmount(Math.min(remaining, Math.ceil(balance / split)))}>Usar 1 parte</button>
        </>}
      </div>
      {split > 1 && balance % split !== 0 && <div className="small faint" style={{ marginTop: -6, marginBottom: 8 }}>Valor arredondado para cima; a última parte fica um pouco menor ({brl(balance - Math.ceil(balance / split) * (split - 1))}).</div>}

      {parts.length > 0 && (
        <div className="card tight" style={{ marginBottom: 12 }}>
          {parts.map((p, i) => (
            <div key={i} className="kv">
              <span>{name(p.methodId)}{p.tenderedCents ? <span className="faint small"> · troco {brl(p.tenderedCents - p.amountCents)}</span> : null}</span>
              <span className="row"><span className="v">{brl(p.amountCents)}</span>
                <button className="btn sm ghost icon" onClick={() => { setParts(parts.filter((_, j) => j !== i)); setAmount(remaining + p.amountCents); }}>✕</button></span>
            </div>
          ))}
          <div className="kv"><span className="muted">Falta</span><span className="v">{brl(remaining)}</span></div>
        </div>
      )}

      {remaining > 0 && (
        <div className="col gap-lg">
          <div className="method-grid">
            {methods.map((m) => (
              <button key={m.id} className={`method-btn${methodId === m.id ? ' on' : ''}`} onClick={() => { setMethodId(m.id); if (!m.isCash) setTendered(null); }}>
                <span className="method-ico">{m.code === 'PIX' ? '⚡' : m.code === 'DINHEIRO' ? '💵' : m.code === 'CARTAO' ? '💳' : '•'}</span>
                {m.name}
              </button>
            ))}
          </div>
          {method && <>
            <label className="field">
              <span>Valor em {method.name}</span>
              <MoneyInput value={amount} onChange={setAmount} autoFocus />
            </label>
            {curAmount > remaining && <div className="cancel-text small">O valor passa do saldo ({brl(remaining)}). Para dinheiro, use “valor recebido” para calcular o troco.</div>}
            {method.isCash && (
              <label className="field">
                <span>Valor recebido do cliente (para calcular o troco)</span>
                <MoneyInput value={tendered} onChange={setTendered} placeholder="opcional" />
              </label>
            )}
            {change != null && change >= 0 && <div className="change-box">Troco: <b className="num">{brl(change)}</b></div>}
            {change != null && change < 0 && <div className="cancel-text small">Valor recebido menor que o valor a pagar.</div>}
            {currentValid && curAmount < remaining && (
              <button className="btn block" onClick={pushPart}>＋ Somar outra forma de pagamento (falta {brl(remaining - curAmount)})</button>
            )}
          </>}
        </div>
      )}
    </Modal>
  );
}

export function DiscountModal({ account, onClose, onDone }: { account: AccountDetail; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const { busy, run } = useAction();
  const ok = amount != null && amount > 0 && amount <= account.totals.balance && reason.trim().length >= 3;
  return (
    <Modal title={`Desconto / ajuste · Conta #${account.number}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary" disabled={!ok || busy} onClick={async () => {
        if (await run(() => api.post(`/api/accounts/${account.id}/discounts`, { amountCents: amount, reason: reason.trim() }), 'Desconto registrado.')) { onDone(); onClose(); }
      }}>Aplicar {amount ? brl(amount) : ''}</button>
    </>}>
      <div className="col gap-lg">
        <div className="muted small">Saldo atual: <b>{brl(account.totals.balance)}</b>. Sem limite de valor, mas o motivo é obrigatório. Fica registrado com seu nome, horário, total antes e depois.</div>
        {amount != null && amount > 0 && <div className="kv"><span>Total da conta</span><span className="v">{brl(account.totals.total)} → {brl(account.totals.total - amount)}</span></div>}
        <label className="field"><span>Valor do desconto</span><MoneyInput value={amount} onChange={setAmount} autoFocus /></label>
        <label className="field"><span>Motivo (obrigatório)</span>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: item lançado em duplicidade" maxLength={300} />
        </label>
        <div className="row wrap">
          {['Item lançado em duplicidade', 'Cortesia da casa', 'Cliente frequente', 'Demora no pedido'].map((s) => <button key={s} className="btn sm" onClick={() => setReason(s)}>{s}</button>)}
        </div>
      </div>
    </Modal>
  );
}

export function PendingModal({ account, onClose, onDone }: { account: AccountDetail; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(account.customerName ?? '');
  const [contact, setContact] = useState(account.contact ?? '');
  const [note, setNote] = useState(account.note ?? '');
  const [data, setData] = useState('');
  const { busy, run } = useAction();
  const ok = name.trim().length >= 2 && contact.trim().length >= 2 && (!data || data >= todayISO());
  return (
    <Modal title="Cliente saiu sem pagar" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn danger solid" disabled={!ok || busy} onClick={async () => {
        if (await run(() => api.post(`/api/accounts/${account.id}/pending`, { customerName: name.trim(), contact: contact.trim(), note: note.trim() || null, promisedDate: data || null }), 'Conta marcada como pendente.')) { onDone(); onClose(); }
      }}>Marcar como pendente ({brl(account.totals.balance)})</button>
    </>}>
      <div className="col gap-lg">
        <div className="muted small">Para cobrar depois, o nome e a casa/telefone são obrigatórios.</div>
        <label className="field"><span>Nome do cliente *</span><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
        <label className="field"><span>Casa ou telefone *</span><input className="input" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Ex.: casa 123 · (61) 9…" maxLength={120} /></label>
        <label className="field"><span>Data combinada para pagar (opcional)</span>
          <input className="input" type="date" value={data} min={todayISO()} onChange={(e) => setData(e.target.value)} />
          <div className="row wrap" style={{ gap: 6 }}>
            {[['Amanhã', 1], ['Em 7 dias', 7], ['Em 15 dias', 15], ['Em 30 dias', 30]].map(([r, d]) => <button key={r} type="button" className="btn sm" onClick={() => setData(addDaysISO(todayISO(), d as number))}>{r}</button>)}
          </div>
        </label>
        <label className="field"><span>Observação</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} /></label>
      </div>
    </Modal>
  );
}

export function EditAccountModal({ account, onClose, onDone }: { account: AccountDetail; onClose: () => void; onDone: () => void }) {
  const mesa = useMesaLabel();
  const [name, setName] = useState(account.customerName ?? '');
  const [note, setNote] = useState(account.note ?? '');
  const [contact, setContact] = useState(account.contact ?? '');
  const [phone, setPhone] = useState(account.phone ?? '');
  const [table, setTable] = useState(account.tableLabel ?? '');
  const { busy, run } = useAction();
  return (
    <Modal title={`Identificação · Conta #${account.number}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary" disabled={busy} onClick={async () => {
        if (await run(() => api.patch(`/api/accounts/${account.id}`, { customerName: name, note, contact, phone, tableLabel: table }), 'Conta atualizada.')) { onDone(); onClose(); }
      }}>Salvar</button>
    </>}>
      <div className="col gap-lg">
        <label className="field"><span>Cliente</span><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
        <label className="field"><span>Observação</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} /></label>
        <div className="grid-2">
          <label className="field"><span>{mesa}</span><input className="input" value={table} onChange={(e) => setTable(e.target.value)} maxLength={20} /></label>
          <label className="field"><span>Telefone</span><input className="input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} /></label>
        </div>
        <label className="field"><span>Casa / contato</span><input className="input" value={contact} onChange={(e) => setContact(e.target.value)} maxLength={120} /></label>
      </div>
    </Modal>
  );
}

/** Cancelar item (com quantidade parcial e devolução ao estoque). */
export function CancelItemModal({ item, delivered, onClose, onDone }: { item: OrderItem; delivered: boolean; onClose: () => void; onDone: () => void }) {
  const [qty, setQty] = useState(item.quantity);
  const [reason, setReason] = useState('');
  const { data: st } = useQuery({ queryKey: ['itemStock', item.id], queryFn: () => api.get<{ hasStock: boolean }>(`/api/order-items/${item.id}/stock`) });
  const [ret, setRet] = useState(!delivered);
  const { busy, run } = useAction();
  const ok = reason.trim().length >= 3 && qty >= 1 && qty <= item.quantity;
  return (
    <Modal title={`Cancelar ${item.productName}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn danger solid" disabled={!ok || busy} onClick={async () => {
        if (await run(() => api.post(`/api/order-items/${item.id}/cancel`, { reason: reason.trim(), quantity: qty, returnStock: !!st?.hasStock && ret }), qty < item.quantity ? `Quantidade reduzida para ${item.quantity - qty}.` : 'Item cancelado.')) { onDone(); onClose(); }
      }}>Cancelar {qty}× · {brl(item.unitPriceCents * qty)}</button>
    </>}>
      <div className="col gap-lg">
        {item.quantity > 1 && (
          <div className="row between">
            <span>Quantas unidades cancelar?</span>
            <div className="stepper lg">
              <button onClick={() => setQty((q) => Math.max(1, q - 1))}>−</button>
              <span className="num">{qty}</span>
              <button onClick={() => setQty((q) => Math.min(item.quantity, q + 1))}>+</button>
            </div>
          </div>
        )}
        {item.quantity > 1 && qty < item.quantity && <div className="small muted">Ficam {item.quantity - qty} na conta.</div>}
        <label className="field"><span>Motivo (obrigatório)</span>
          <input className="input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: cliente desistiu" maxLength={300} /></label>
        <div className="row wrap">{['Cliente desistiu', 'Lançado errado', 'Produto em falta', 'Demorou demais'].map((s) => <button key={s} className="btn sm" onClick={() => setReason(s)}>{s}</button>)}</div>
        {st?.hasStock && (
          <label className="check"><input type="checkbox" checked={ret} onChange={(e) => setRet(e.target.checked)} />
            <span>Devolver ao estoque <span className="small muted">{delivered ? '(já foi entregue — marque só se o produto voltou intacto)' : '(produto não foi aberto/entregue)'}</span></span></label>
        )}
      </div>
    </Modal>
  );
}

/** Escolher outra conta aberta (juntar contas / transferir pedido). */
export function PickAccountModal({ title, description, excludeId, confirmLabel, onClose, onPick }: {
  title: string; description: string; excludeId: number; confirmLabel: string; onClose: () => void; onPick: (id: number) => Promise<boolean>;
}) {
  const mesa = useMesaLabel();
  const { data } = useQuery({ queryKey: ['board'], queryFn: () => api.get<Board>('/api/cashier/board') });
  const [sel, setSel] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const list = (data?.accounts ?? []).filter((a) => a.id !== excludeId && a.status !== 'PENDING')
    .filter((a) => !q || String(a.number) === q.replace('#', '') || (a.customerName ?? '').toLowerCase().includes(q.toLowerCase()) || a.tableLabel === q);
  return (
    <Modal title={title} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary" disabled={!sel || busy} onClick={async () => { setBusy(true); const ok = await onPick(sel!); setBusy(false); if (ok) onClose(); }}>{confirmLabel}</button>
    </>}>
      <p className="muted" style={{ marginTop: 0 }}>{description}</p>
      <input className="input" placeholder="Buscar nº, nome ou mesa" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div className="col mt" style={{ gap: 6, maxHeight: 340, overflowY: 'auto' }}>
        {!list.length && <div className="empty small">Nenhuma outra conta aberta.</div>}
        {list.map((a) => (
          <button key={a.id} className={`pick-row${sel === a.id ? ' on' : ''}`} onClick={() => setSel(a.id)}>
            <b className="num">#{a.number}</b>
            <span className="grow ellipsis">{a.customerName || 'Cliente não informado'}{a.tableLabel ? ` · ${mesa} ${a.tableLabel}` : ''}{a.note ? ` · ${a.note}` : ''}</span>
            <span className="num">{brl(a.balance)}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
