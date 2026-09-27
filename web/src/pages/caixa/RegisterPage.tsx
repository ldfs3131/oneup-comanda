import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { brl, dateTime, signed } from '../../format';
import type { RegisterSummary } from '../../types';
import { Modal, MoneyInput, Spinner, useAction } from '../../components/ui';
import { OpenDay } from './Board';

type Current = { register: null; isOpen: boolean } | {
  register: { id: number; openedAt: string; openedByName: string; openingCashCents: number }; isOpen: boolean; blind: boolean; summary: RegisterSummary;
};
type CloseResult = { expectedCashCents: number; countedCashCents: number; differenceCents: number; receivedCents: number; openAccounts: number };

export function useRegister() {
  return useQuery({ queryKey: ['register'], queryFn: () => api.get<Current>('/api/register/current'), refetchInterval: 30_000 });
}

export default function RegisterPage() {
  const { data, isLoading } = useRegister();
  const [move, setMove] = useState<null | 'SANGRIA' | 'SUPRIMENTO'>(null);
  const [expense, setExpense] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closed, setClosed] = useState<CloseResult | null>(null);

  if (closed) return (
    <div className="page narrow" style={{ maxWidth: 520 }}>
      <div className="card col gap-lg">
        <h1>Dia encerrado ✔</h1>
        <div className="muted small">O estabelecimento ficou <b>FECHADO</b> e um backup automático foi iniciado.</div>
        <div>
          <div className="kv"><span>Total recebido no dia</span><span className="v">{brl(closed.receivedCents)}</span></div>
          <div className="kv"><span>Dinheiro esperado na gaveta</span><span className="v">{brl(closed.expectedCashCents)}</span></div>
          <div className="kv"><span>Dinheiro contado</span><span className="v">{brl(closed.countedCashCents)}</span></div>
          <div className="kv total"><span>Diferença</span><span className="v" style={{ color: closed.differenceCents === 0 ? 'var(--ok)' : 'var(--danger)' }}>{closed.differenceCents === 0 ? 'Sem diferença' : signed(closed.differenceCents)}</span></div>
        </div>
        {closed.openAccounts > 0 && <div className="info-box small">{closed.openAccounts} conta(s) continuam abertas e aparecem no próximo dia.</div>}
        <button className="btn primary block" onClick={() => setClosed(null)}>OK</button>
      </div>
    </div>
  );
  if (isLoading || !data) return <Spinner />;
  if (!data.register) return <OpenDay />;
  const { register: reg, summary: s, blind } = data;

  return (
    <div className="col gap-lg">
      <div className="row between wrap">
        <div>
          <h1>Dia aberto</h1>
          <div className="muted small">Aberto {dateTime(reg.openedAt)} por {reg.openedByName} com {brl(reg.openingCashCents)} na gaveta</div>
        </div>
        <div className="row wrap">
          <button className="btn" onClick={() => setExpense(true)}>🧾 Despesa paga com a gaveta</button>
          <button className="btn" onClick={() => setMove('SANGRIA')}>− Sangria</button>
          <button className="btn" onClick={() => setMove('SUPRIMENTO')}>＋ Suprimento</button>
          <button className="btn primary lg" onClick={() => setClosing(true)}>🌙 Encerrar o dia</button>
        </div>
      </div>
      <RegisterSummaryView s={s} blind={blind} />
      {move && <MovementModal type={move} onClose={() => setMove(null)} />}
      {expense && <DrawerExpenseModal onClose={() => setExpense(false)} />}
      {closing && <CloseModal s={s} blind={blind} onClose={() => setClosing(false)} onClosed={(r) => { setClosing(false); setClosed(r); }} />}
    </div>
  );
}

export function RegisterSummaryView({ s, blind }: { s: RegisterSummary; blind?: boolean }) {
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
        {!s.byMethod.length && <div className="muted small">Nenhum pagamento ainda.</div>}
        {s.byMethod.map((m) => <div key={m.code} className="kv"><span>{m.name} <span className="faint small">({m.count})</span></span><span className="v">{brl(m.cents)}</span></div>)}
        <div className="kv total"><span>Total recebido</span><span className="v">{brl(s.receivedCents)}</span></div>
        <div className="kv small"><span className="muted">Pagamentos parciais (contas em aberto)</span><span className="v">{brl(s.partialPaymentsCents)}</span></div>
        <div className="kv small"><span className="muted">Recebido de pendências anteriores</span><span className="v">{brl(s.fromPreviousPendingCents)}</span></div>
      </div>
      <div className="card">
        <div className="panel-title">Dinheiro na gaveta</div>
        <div className="kv"><span>Abertura</span><span className="v">{brl(s.openingCashCents)}</span></div>
        <div className="kv"><span>+ Suprimentos</span><span className="v">{brl(s.suprimentosCents)}</span></div>
        <div className="kv"><span>− Sangrias e despesas</span><span className="v">{brl(s.sangriasCents)}</span></div>
        {blind || s.expectedCashCents == null ? (
          <div className="info-box small mt">🔒 Fechamento às cegas: o valor esperado em dinheiro só aparece depois que você contar a gaveta no “Encerrar o dia”.</div>
        ) : <>
          <div className="kv"><span>+ Recebido em dinheiro</span><span className="v">{brl(s.cashReceivedCents)}</span></div>
          <div className="kv total"><span>Esperado</span><span className="v">{brl(s.expectedCashCents)}</span></div>
        </>}
        {s.countedCashCents != null && <>
          <div className="kv"><span>Contado</span><span className="v">{brl(s.countedCashCents)}</span></div>
          <div className="kv"><span>Diferença</span><span className="v" style={{ color: s.differenceCents === 0 ? 'var(--ok)' : 'var(--danger)' }}>{signed(s.differenceCents ?? 0)}</span></div>
        </>}
      </div>
      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <div className="panel-title">Pendências criadas hoje ({s.pendingCreated.length}) · {brl(s.pendingCreatedCents)}</div>
        {!s.pendingCreated.length && <div className="muted small">Nenhuma.</div>}
        {s.pendingCreated.map((p) => <div key={p.id} className="kv"><span>#{p.number} · {p.customerName} · {p.contact}</span><span className="v">{brl(p.balance)}</span></div>)}
        {s.movements.length > 0 && <>
          <div className="divider" />
          <div className="panel-title">Sangrias, despesas e suprimentos</div>
          {s.movements.map((m, i) => <div key={i} className="kv small"><span>{m.type === 'SANGRIA' ? '− Saída' : '＋ Suprimento'} · {dateTime(m.createdAt)} · {m.userName} · {m.reason}</span><span className="v">{brl(m.amountCents)}</span></div>)}
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
        {type === 'SANGRIA' && <div className="small muted">Pagou uma conta com o dinheiro da gaveta? Use <b>“Despesa paga com a gaveta”</b> — ela já faz a sangria e entra no financeiro.</div>}
        <label className="field"><span>Valor</span><MoneyInput value={amount} onChange={setAmount} autoFocus /></label>
        <label className="field"><span>Motivo</span><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={type === 'SANGRIA' ? 'Ex.: dinheiro levado para o cofre' : 'Ex.: reforço de troco'} /></label>
      </div>
    </Modal>
  );
}

function DrawerExpenseModal({ onClose }: { onClose: () => void }) {
  const { data: cats = [] } = useQuery({ queryKey: ['expenseCats'], queryFn: () => api.get<{ id: number; name: string; active: boolean }[]>('/api/expense-categories') });
  const [cat, setCat] = useState<number | null>(null);
  const [desc, setDesc] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const { busy, run } = useAction();
  const qc = useQueryClient();
  const ok = !!cat && desc.trim().length >= 2 && !!amount;
  return (
    <Modal title="Despesa paga com o dinheiro da gaveta" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary" disabled={!ok || busy} onClick={async () => {
        if (await run(() => api.post('/api/expenses', { description: desc.trim(), categoryId: cat, amountCents: amount, paidFromRegister: true }, true), 'Despesa lançada (saiu da gaveta).')) {
          qc.invalidateQueries({ queryKey: ['register'] }); onClose();
        }
      }}>Lançar {amount ? brl(amount) : ''}</button>
    </>}>
      <div className="col gap-lg">
        <div className="small muted">O valor sai da gaveta automaticamente (sangria) e aparece no financeiro do administrador.</div>
        <label className="field"><span>Categoria</span>
          <select className="input" value={cat ?? ''} onChange={(e) => setCat(Number(e.target.value) || null)}>
            <option value="">Escolha…</option>
            {cats.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="field"><span>Descrição</span><input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Ex.: gelo, gás, entregador" maxLength={120} /></label>
        <label className="field"><span>Valor</span><MoneyInput value={amount} onChange={setAmount} /></label>
      </div>
    </Modal>
  );
}

function CloseModal({ s, blind, onClose, onClosed }: { s: RegisterSummary; blind: boolean; onClose: () => void; onClosed: (r: CloseResult) => void }) {
  const [counted, setCounted] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState(false);
  const { busy, run } = useAction();
  const qc = useQueryClient();
  const diff = !blind && counted != null && s.expectedCashCents != null ? counted - s.expectedCashCents : null;
  return (
    <Modal title="Encerrar o dia" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      {!confirm
        ? <button className="btn primary lg" disabled={counted == null} onClick={() => setConfirm(true)}>Continuar</button>
        : <button className="btn primary lg" disabled={busy || counted == null} onClick={async () => {
          let r: CloseResult | undefined;
          if (await run(async () => { r = await api.post<CloseResult>('/api/day/close', { countedCashCents: counted, note: note.trim() || null }, true); })) {
            qc.invalidateQueries(); onClosed(r!);
          }
        }}>Confirmar e encerrar o dia</button>}
    </>}>
      <div className="col gap-lg">
        {s.openAccountsNow > 0 && (
          <div className="problem-box">Ainda há {s.openAccountsNow} conta(s) aberta(s). Elas continuam abertas e os pagamentos futuros entram no próximo dia.</div>
        )}
        <div className="small muted">Conte o dinheiro da gaveta e digite o valor. {blind ? 'Por segurança, o valor esperado só aparece depois de confirmar.' : ''}</div>
        <label className="field"><span>Dinheiro contado na gaveta</span><MoneyInput value={counted} onChange={(v) => { setCounted(v); setConfirm(false); }} autoFocus /></label>
        {diff != null && (
          <div className="kv total"><span>Diferença</span><span className="v" style={{ color: diff === 0 ? 'var(--ok)' : 'var(--danger)' }}>{signed(diff)}</span></div>
        )}
        <label className="field"><span>Observação (opcional)</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: faltou troco de R$ 10" /></label>
        {confirm && <div className="info-box small">Ao encerrar: o caixa fecha, o estabelecimento fica <b>FECHADO</b> (sem novos pedidos) e o backup automático roda.</div>}
      </div>
    </Modal>
  );
}
