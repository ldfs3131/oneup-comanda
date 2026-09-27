import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { brl } from '../../format';
import type { AccountDetail, PaymentMethod } from '../../types';
import { Modal, MoneyInput, useAction } from '../../components/ui';

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
    const ok = await run(() => api.post(`/api/accounts/${account.id}/payments`, { payments: all, close }),
      close && full ? `Conta #${account.number} paga e encerrada.` : 'Pagamento registrado.');
    if (ok) { onDone(); onClose(); }
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
        <div className="muted small">Saldo atual: <b>{brl(account.totals.balance)}</b>. O desconto fica registrado com seu nome, horário e motivo.</div>
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
  const { busy, run } = useAction();
  const ok = name.trim().length >= 2 && contact.trim().length >= 2;
  return (
    <Modal title="Cliente saiu sem pagar" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn danger solid" disabled={!ok || busy} onClick={async () => {
        if (await run(() => api.post(`/api/accounts/${account.id}/pending`, { customerName: name.trim(), contact: contact.trim(), note: note.trim() || null }), 'Conta marcada como pendente.')) { onDone(); onClose(); }
      }}>Marcar como pendente ({brl(account.totals.balance)})</button>
    </>}>
      <div className="col gap-lg">
        <div className="muted small">Para cobrar depois, o nome e a casa/telefone são obrigatórios.</div>
        <label className="field"><span>Nome do cliente *</span><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
        <label className="field"><span>Casa ou telefone *</span><input className="input" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Ex.: casa 123 · (61) 9…" maxLength={120} /></label>
        <label className="field"><span>Observação</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} /></label>
      </div>
    </Modal>
  );
}

export function EditAccountModal({ account, onClose, onDone }: { account: AccountDetail; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(account.customerName ?? '');
  const [note, setNote] = useState(account.note ?? '');
  const [contact, setContact] = useState(account.contact ?? '');
  const { busy, run } = useAction();
  return (
    <Modal title={`Identificação · Conta #${account.number}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary" disabled={busy} onClick={async () => {
        if (await run(() => api.patch(`/api/accounts/${account.id}`, { customerName: name, note, contact }), 'Conta atualizada.')) { onDone(); onClose(); }
      }}>Salvar</button>
    </>}>
      <div className="col gap-lg">
        <label className="field"><span>Cliente</span><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
        <label className="field"><span>Observação</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} /></label>
        <label className="field"><span>Casa / telefone</span><input className="input" value={contact} onChange={(e) => setContact(e.target.value)} maxLength={120} /></label>
      </div>
    </Modal>
  );
}
