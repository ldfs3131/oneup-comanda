import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { brl, dateTime } from '../../format';
import type { RegisterSummary } from '../../types';
import { Modal, MoneyInput, Spinner, useAction } from '../../components/ui';
import { OpenRegister } from './Board';

type Current = { register: null } | { register: { id: number; openedAt: string; openedByName: string; openingCashCents: number }; summary: RegisterSummary };

export default function RegisterPage() {
  const { data, isLoading } = useQuery({ queryKey: ['register'], queryFn: () => api.get<Current>('/api/register/current'), refetchInterval: 30_000 });
  const [move, setMove] = useState<null | 'SANGRIA' | 'SUPRIMENTO'>(null);
  const [closing, setClosing] = useState(false);
  const [closed, setClosed] = useState<null | { expectedCashCents: number; countedCashCents: number; differenceCents: number }>(null);

  if (closed) return (
    <div className="page narrow" style={{ maxWidth: 520 }}>
      <div className="card col gap-lg">
        <h1>Caixa fechado ✔</h1>
        <div>
          <div className="kv"><span>Dinheiro esperado</span><span className="v">{brl(closed.expectedCashCents)}</span></div>
          <div className="kv"><span>Dinheiro contado</span><span className="v">{brl(closed.countedCashCents)}</span></div>
          <div className="kv total"><span>Diferença</span><span className="v" style={{ color: closed.differenceCents === 0 ? 'var(--ok)' : 'var(--danger)' }}>{closed.differenceCents > 0 ? '+' : ''}{brl(closed.differenceCents)}</span></div>
        </div>
        <div className="small muted">O resumo completo fica salvo no histórico de caixas. Um backup automático foi iniciado.</div>
        <button className="btn primary block" onClick={() => setClosed(null)}>OK</button>
      </div>
    </div>
  );
  if (isLoading || !data) return <Spinner />;
  if (!data.register) return <OpenRegister />;
  const { register: reg, summary: s } = data;

  return (
    <div className="col gap-lg">
      <div className="row between wrap">
        <div>
          <h1>Caixa aberto</h1>
          <div className="muted small">Aberto {dateTime(reg.openedAt)} por {reg.openedByName} com {brl(reg.openingCashCents)}</div>
        </div>
        <div className="row wrap">
          <button className="btn" onClick={() => setMove('SANGRIA')}>− Sangria</button>
          <button className="btn" onClick={() => setMove('SUPRIMENTO')}>＋ Suprimento</button>
          <button className="btn primary lg" onClick={() => setClosing(true)}>Fechar caixa</button>
        </div>
      </div>
      <RegisterSummaryView s={s} />
      {move && <MovementModal type={move} onClose={() => setMove(null)} />}
      {closing && <CloseModal s={s} onClose={() => setClosing(false)} onClosed={(r) => { setClosing(false); setClosed(r); }} />}
    </div>
  );
}

export function RegisterSummaryView({ s }: { s: RegisterSummary }) {
  return (
    <div className="grid-3">
      <div className="card">
        <div className="panel-title">Vendas</div>
        <div className="kv total"><span>Vendido (itens lançados)</span><span className="v">{brl(s.salesCents)}</span></div>
        <div className="kv"><span>Pedidos</span><span className="v">{s.ordersCount}</span></div>
        <div className="kv"><span>Contas</span><span className="v">{s.accountsCount}</span></div>
        <div className="kv"><span>Descontos/ajustes ({s.discountsCount})</span><span className="v">−{brl(s.discountsCents)}</span></div>
        {s.discountsByUser.map((d) => <div key={d.name} className="kv small"><span className="muted">· {d.name}</span><span className="v">{brl(d.cents)} ({d.count})</span></div>)}
        <div className="kv"><span>Cancelamentos ({s.cancellationsCount})</span><span className="v">{brl(s.cancellationsCents)}</span></div>
        {s.lossCents > 0 && <div className="kv small"><span className="muted">· dos quais perdas</span><span className="v">{brl(s.lossCents)}</span></div>}
      </div>
      <div className="card">
        <div className="panel-title">Recebido</div>
        {s.byMethod.map((m) => <div key={m.code} className="kv"><span>{m.name} <span className="faint small">({m.count})</span></span><span className="v">{brl(m.cents)}</span></div>)}
        <div className="kv total"><span>Total recebido</span><span className="v">{brl(s.receivedCents)}</span></div>
        <div className="kv small"><span className="muted">Pagamentos parciais (contas em aberto)</span><span className="v">{brl(s.partialPaymentsCents)}</span></div>
        <div className="kv small"><span className="muted">Recebido de pendências anteriores</span><span className="v">{brl(s.fromPreviousPendingCents)}</span></div>
      </div>
      <div className="card">
        <div className="panel-title">Dinheiro na gaveta</div>
        <div className="kv"><span>Abertura</span><span className="v">{brl(s.openingCashCents)}</span></div>
        <div className="kv"><span>+ Recebido em dinheiro</span><span className="v">{brl(s.cashReceivedCents)}</span></div>
        <div className="kv"><span>+ Suprimentos</span><span className="v">{brl(s.suprimentosCents)}</span></div>
        <div className="kv"><span>− Sangrias</span><span className="v">{brl(s.sangriasCents)}</span></div>
        <div className="kv total"><span>Esperado</span><span className="v">{brl(s.expectedCashCents)}</span></div>
        {s.countedCashCents != null && <>
          <div className="kv"><span>Contado</span><span className="v">{brl(s.countedCashCents)}</span></div>
          <div className="kv"><span>Diferença</span><span className="v" style={{ color: s.differenceCents === 0 ? 'var(--ok)' : 'var(--danger)' }}>{(s.differenceCents ?? 0) > 0 ? '+' : ''}{brl(s.differenceCents)}</span></div>
        </>}
      </div>
      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <div className="panel-title">Pendências criadas neste caixa ({s.pendingCreated.length}) · {brl(s.pendingCreatedCents)}</div>
        {!s.pendingCreated.length && <div className="muted small">Nenhuma.</div>}
        {s.pendingCreated.map((p) => <div key={p.id} className="kv"><span>#{p.number} · {p.customerName} · {p.contact}</span><span className="v">{brl(p.balance)}</span></div>)}
        {s.movements.length > 0 && <>
          <div className="divider" />
          <div className="panel-title">Sangrias e suprimentos</div>
          {s.movements.map((m, i) => <div key={i} className="kv small"><span>{m.type === 'SANGRIA' ? '− Sangria' : '＋ Suprimento'} · {dateTime(m.createdAt)} · {m.userName} · {m.reason}</span><span className="v">{brl(m.amountCents)}</span></div>)}
        </>}
      </div>
    </div>
  );
}

function MovementModal({ type, onClose }: { type: 'SANGRIA' | 'SUPRIMENTO'; onClose: () => void }) {
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const { busy, run } = useAction();
  const qc = useQueryClient();
  const label = type === 'SANGRIA' ? 'Sangria (retirar dinheiro da gaveta)' : 'Suprimento (colocar dinheiro na gaveta)';
  return (
    <Modal title={label} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary" disabled={busy || !amount || reason.trim().length < 3} onClick={async () => {
        if (await run(() => api.post('/api/register/movements', { type, amountCents: amount, reason: reason.trim() }), 'Registrado.')) {
          qc.invalidateQueries({ queryKey: ['register'] }); onClose();
        }
      }}>Registrar</button>
    </>}>
      <div className="col gap-lg">
        <label className="field"><span>Valor</span><MoneyInput value={amount} onChange={setAmount} autoFocus /></label>
        <label className="field"><span>Motivo</span><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={type === 'SANGRIA' ? 'Ex.: pagamento de fornecedor' : 'Ex.: reforço de troco'} /></label>
      </div>
    </Modal>
  );
}

function CloseModal({ s, onClose, onClosed }: { s: RegisterSummary; onClose: () => void; onClosed: (r: { expectedCashCents: number; countedCashCents: number; differenceCents: number }) => void }) {
  const [counted, setCounted] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const { busy, run } = useAction();
  const qc = useQueryClient();
  const diff = counted != null ? counted - s.expectedCashCents : null;
  return (
    <Modal title="Fechar caixa" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary lg" disabled={busy || counted == null} onClick={async () => {
        let r: any;
        if (await run(async () => { r = await api.post('/api/register/close', { countedCashCents: counted, note: note.trim() || null }); })) {
          qc.invalidateQueries(); onClosed(r);
        }
      }}>Confirmar fechamento</button>
    </>}>
      <div className="col gap-lg">
        {s.openAccountsNow > 0 && (
          <div className="problem-box">Ainda há {s.openAccountsNow} conta(s) aberta(s). Elas continuam abertas e os pagamentos futuros entram no próximo caixa.</div>
        )}
        <div className="kv total"><span>Dinheiro esperado na gaveta</span><span className="v">{brl(s.expectedCashCents)}</span></div>
        <label className="field"><span>Dinheiro contado na gaveta</span><MoneyInput value={counted} onChange={setCounted} autoFocus /></label>
        {diff != null && (
          <div className="kv total"><span>Diferença</span><span className="v" style={{ color: diff === 0 ? 'var(--ok)' : 'var(--danger)' }}>{diff > 0 ? '+' : ''}{brl(diff)}</span></div>
        )}
        <label className="field"><span>Observação (opcional)</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: faltou troco de R$ 10" /></label>
      </div>
    </Modal>
  );
}
