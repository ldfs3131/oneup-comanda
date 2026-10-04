import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ACCOUNT_STATUS, ORDER_STATUS, centsToInput, parseMoney } from '../format';
import { useQueryClient } from '@tanstack/react-query';

// ---------- Modal ----------
/** Pilha de modais abertos: Esc e clique fora fecham só o de cima (um modal pode abrir outro). */
const pilhaModais: symbol[] = [];
const FOCAVEIS = 'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
const focaveisDe = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(FOCAVEIS)].filter((e) => e.offsetParent !== null || e === document.activeElement);

/**
 * Janela por cima da tela. Para leitor de tela: role="dialog", aria-modal, título ligado por aria-labelledby.
 * Teclado: o foco entra na janela ao abrir, o Tab fica preso dentro, Esc fecha (só a janela do topo)
 * e, ao fechar, o foco volta para o botão que abriu.
 */
export function Modal({ title, onClose, children, footer, wide }: {
  title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  const tituloId = useId();
  const caixa = useRef<HTMLDivElement>(null);
  const fechar = useRef(onClose);
  fechar.current = onClose;
  const eu = useRef(Symbol('modal'));
  const noTopo = () => pilhaModais[pilhaModais.length - 1] === eu.current;

  useEffect(() => {
    const id = eu.current;
    pilhaModais.push(id);
    const antes = document.activeElement as HTMLElement | null;
    // foco inicial: se um campo com autoFocus já pegou o foco, mantém; senão, a própria janela (não abre o teclado do celular)
    if (caixa.current && !caixa.current.contains(document.activeElement)) caixa.current.focus({ preventScroll: true });
    const tecla = (e: KeyboardEvent) => {
      if (!noTopo() || !caixa.current) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fechar.current(); return; }
      if (e.key !== 'Tab') return;
      const lista = focaveisDe(caixa.current);
      if (!lista.length) { e.preventDefault(); caixa.current.focus(); return; }
      const primeiro = lista[0]; const ultimo = lista[lista.length - 1];
      const atual = document.activeElement as HTMLElement | null;
      const dentro = !!atual && caixa.current.contains(atual);
      if (e.shiftKey && (!dentro || atual === primeiro || atual === caixa.current)) { e.preventDefault(); ultimo.focus(); }
      else if (!e.shiftKey && (!dentro || atual === ultimo)) { e.preventDefault(); primeiro.focus(); }
    };
    // o foco não escapa (ex.: clique fora numa área sem botão, leitor de tela): volta para a janela do topo
    const foco = (e: FocusEvent) => {
      if (!noTopo() || !caixa.current) return;
      if (e.target instanceof Node && !caixa.current.contains(e.target)) caixa.current.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', tecla, true);
    document.addEventListener('focusin', foco);
    return () => {
      document.removeEventListener('keydown', tecla, true);
      document.removeEventListener('focusin', foco);
      const i = pilhaModais.lastIndexOf(id);
      if (i >= 0) pilhaModais.splice(i, 1);
      // devolve o foco a quem abriu (se ainda estiver na tela)
      if (antes && antes.isConnected && typeof antes.focus === 'function') setTimeout(() => antes.focus({ preventScroll: true }), 0);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // a mesma janela trocou de conteúdo (ex.: "Seu pedido" → "Confira antes de enviar") e o foco ficou num botão que sumiu
  useEffect(() => {
    if (caixa.current && noTopo() && !caixa.current.contains(document.activeElement)) caixa.current.focus({ preventScroll: true });
  });

  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget && noTopo()) onClose(); }}>
      <div ref={caixa} className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={tituloId} tabIndex={-1}>
        <div className="modal-head">
          <h2 id={tituloId}>{title}</h2>
          <button type="button" className="btn ghost icon" onClick={onClose} aria-label="Fechar">✕</button>
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
/**
 * Avisos rápidos. As duas faixas ficam sempre na tela (vazias) para o leitor de tela anunciar o que entrar:
 * erro em role="alert" (anuncia na hora), o resto em role="status" (anuncia sem interromper).
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((msg: string, tone: Toast['tone'] = 'ok') => {
    const id = ++seq.current;
    setList((l) => [...l, { id, msg, tone }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), tone === 'danger' ? 6000 : 3000);
  }, []);
  useSegmentosAcessiveis();
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">
        <div className="toast-lane" role="alert">{list.filter((t) => t.tone === 'danger').map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.msg}</div>)}</div>
        <div className="toast-lane" role="status" aria-live="polite">{list.filter((t) => t.tone !== 'danger').map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.msg}</div>)}</div>
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- Segmento (.seg) ----------
/** Grupo de botões em que um fica marcado (ex.: Retirar / Consumir aqui / Entrega). Marca aria-pressed para leitor de tela. */
export function Seg<T extends string>({ value, options, onChange, label, className }: {
  value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label?: string; className?: string;
}) {
  return (
    <div className={`seg${className ? ` ${className}` : ''}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className={value === o.value ? 'on' : ''} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/**
 * Telas antigas montam o segmento à mão (<div className="seg"> com botão .on). Este observador põe aria-pressed
 * nesses botões conforme a classe "on", sem precisar mexer em cada tela. Grupos com role="radiogroup" ficam de fora
 * (usam aria-checked próprio).
 */
function useSegmentosAcessiveis() {
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    let agendado = 0;
    const marcar = () => {
      agendado = 0;
      document.querySelectorAll<HTMLButtonElement>('.seg:not([role="radiogroup"]) > button').forEach((b) => {
        const v = b.classList.contains('on') ? 'true' : 'false';
        if (b.getAttribute('aria-pressed') !== v) b.setAttribute('aria-pressed', v);
      });
    };
    marcar();
    const obs = new MutationObserver(() => { if (!agendado) agendado = requestAnimationFrame(marcar); });
    obs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    return () => { obs.disconnect(); if (agendado) cancelAnimationFrame(agendado); };
  }, []);
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
