import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ACCOUNT_STATUS, ORDER_STATUS, centsToInput, parseMoney } from '../format';
import { useQueryClient } from '@tanstack/react-query';

// ---------- Modal ----------
export function Modal({ title, onClose, children, footer, wide }: {
  title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn ghost icon" onClick={onClose} aria-label="Fechar">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- Toasts ----------
type Toast = { id: number; msg: string; tone: 'ok' | 'danger' | 'info' };
const ToastCtx = createContext<(msg: string, tone?: Toast['tone']) => void>(() => undefined);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((msg: string, tone: Toast['tone'] = 'ok') => {
    const id = ++seq.current;
    setList((l) => [...l, { id, msg, tone }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), tone === 'danger' ? 6000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">{list.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.msg}</div>)}</div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** Executa uma ação da API mostrando erro em toast. Retorna true se deu certo. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn: () => Promise<unknown>, okMsg?: string, onError?: (e: any) => boolean) => {
    setBusy(true);
    try {
      await fn();
      if (okMsg) toast(okMsg, 'ok');
      return true;
    } catch (e) {
      if (!onError || !onError(e)) toast((e as Error).message, 'danger');
      return false;
    } finally { setBusy(false); }
  }, [toast]);
  return { busy, run };
}

// ---------- Pequenos componentes ----------
export function Badge({ tone = 'muted', children }: { tone?: string; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function AccountBadge({ status }: { status: string }) {
  const s = ACCOUNT_STATUS[status] ?? { label: status, tone: 'muted' };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
export function OrderBadge({ status }: { status: string }) {
  const s = ORDER_STATUS[status] ?? { label: status, tone: 'muted' };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
/**
 * Carregando. Se passar de 8 s (servidor fora, internet caiu, erro), troca por uma explicação e "Tentar de novo"
 * — nunca um círculo girando para sempre (vale para todas as telas, inclusive o cardápio do cliente).
 */
export function Spinner() {
  const qc = useQueryClient();
  const [demorou, setDemorou] = useState(false);
  const [tentando, setTentando] = useState(false);
  useEffect(() => { const t = setTimeout(() => setDemorou(true), 8000); return () => clearTimeout(t); }, [tentando]);
  if (demorou) return (
    <div className="loading col" role="alert" style={{ gap: 12, textAlign: 'center', padding: 24 }}>
      <div style={{ fontWeight: 700 }}>Não conseguimos carregar agora.</div>
      <div className="small muted">Confira a internet. Se continuar, o sistema pode estar reiniciando — tente de novo em alguns segundos.</div>
      <button className="btn primary" onClick={() => { setDemorou(false); setTentando((x) => !x); qc.refetchQueries({ type: 'active' }); }}>Tentar de novo</button>
    </div>
  );
  return <div className="loading" role="status" aria-label="Carregando"><div className="spinner" /></div>;
}

export function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return <button type="button" className={`toggle${on ? ' on' : ''}`} aria-pressed={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} />;
}

/** Campo de dinheiro: digita "25,50"; devolve centavos (ou null). */
export function MoneyInput({ value, onChange, autoFocus, placeholder, id }: {
  value: number | null; onChange: (c: number | null) => void; autoFocus?: boolean; placeholder?: string; id?: string;
}) {
  const [text, setText] = useState(value != null ? centsToInput(value) : '');
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) { setText(value != null ? centsToInput(value) : ''); last.current = value; }
  }, [value]);
  return (
    <div className="row" style={{ gap: 0 }}>
      <span className="muted" style={{ padding: '0 10px 0 2px', fontWeight: 700 }}>R$</span>
      <input
        id={id} className="input money" inputMode="decimal" autoFocus={autoFocus} placeholder={placeholder ?? '0,00'} value={text}
        onFocus={(e) => e.target.select()}
        onChange={(e) => {
          const t = e.target.value.replace(/[^\d,.]/g, '');
          setText(t);
          const c = parseMoney(t);
          last.current = c;
          onChange(c);
        }}
      />
    </div>
  );
}

/** Pede um motivo obrigatório antes de uma ação sensível. */
export function ReasonModal({ title, description, confirmLabel, danger, suggestions, onConfirm, onClose }: {
  title: string; description?: ReactNode; confirmLabel: string; danger?: boolean; suggestions?: string[];
  onConfirm: (reason: string) => Promise<boolean>; onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = reason.trim().length >= 3;
  const submit = async () => {
    if (!ok || busy) return;
    setBusy(true);
    const done = await onConfirm(reason.trim());
    setBusy(false);
    if (done) onClose();
  };
  return (
    <Modal title={title} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className={`btn ${danger ? 'danger solid' : 'primary'}`} disabled={!ok || busy} onClick={submit}>{confirmLabel}</button>
    </>}>
      {description && <div className="muted" style={{ marginBottom: 12 }}>{description}</div>}
      <label className="field">
        <span>Motivo (obrigatório)</span>
        <input className="input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="Ex.: cliente desistiu" maxLength={300} />
      </label>
      {suggestions && (
        <div className="row wrap mt">
          {suggestions.map((s) => <button key={s} className="btn sm" onClick={() => setReason(s)}>{s}</button>)}
        </div>
      )}
    </Modal>
  );
}

export function ConfirmModal({ title, children, confirmLabel, onConfirm, onClose, tone = 'primary' }: {
  title: string; children: ReactNode; confirmLabel: string; onConfirm: () => Promise<boolean> | void; onClose: () => void; tone?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className={`btn ${tone}`} disabled={busy} onClick={async () => {
        setBusy(true); const r = await onConfirm(); setBusy(false); if (r !== false) onClose();
      }}>{confirmLabel}</button>
    </>}>{children}</Modal>
  );
}
