import { useCallback, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api';
import type { StockDecision, StockShortage } from '../types';
import { Modal, useToast } from './ui';

type Choice = { action: 'CORRECT' | 'RELEASE'; newQty: string; reason: string };

/**
 * Estoque zerado/insuficiente: o servidor recusa com STOCK_INSUFFICIENT e a lista do que falta.
 * Este hook mostra o modal com as 3 opções (corrigir e vender / liberar com divergência / cancelar)
 * e reenvia a mesma operação com as decisões. O estoque nunca fica negativo.
 */
export function useStockGuard() {
  const toast = useToast();
  const [state, setState] = useState<{ shortages: StockShortage[] } | null>(null);
  const resolver = useRef<((d: StockDecision[] | null) => void) | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = (shortages: StockShortage[]) => new Promise<StockDecision[] | null>((resolve) => {
    resolver.current = resolve;
    setState({ shortages });
  });
  const finish = (d: StockDecision[] | null) => { setState(null); resolver.current?.(d); resolver.current = null; };

  /** Executa `call(decisions)`; se faltar estoque, pergunta e tenta de novo. Retorna o resultado ou null. */
  const guard = useCallback(async <T,>(call: (decisions?: StockDecision[]) => Promise<T>, okMsg?: string): Promise<T | null> => {
    setBusy(true);
    let decisions: StockDecision[] | undefined;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await call(decisions);
          if (okMsg) toast(okMsg, 'ok');
          return r;
        } catch (e) {
          if (e instanceof ApiError && e.code === 'STOCK_INSUFFICIENT' && Array.isArray(e.details)) {
            const d = await ask(e.details as StockShortage[]);
            if (!d) { toast('Venda cancelada. Nada foi lançado.', 'info'); return null; }
            decisions = [...(decisions ?? []).filter((x) => !d.some((y) => y.productId === x.productId)), ...d];
            continue;
          }
          toast((e as Error).message, 'danger');
          return null;
        }
      }
      return null;
    } finally { setBusy(false); }
  }, [toast]);

  const modal: ReactNode = state ? <StockModal shortages={state.shortages} onDone={finish} /> : null;
  return { guard, modal, busy };
}

function StockModal({ shortages, onDone }: { shortages: StockShortage[]; onDone: (d: StockDecision[] | null) => void }) {
  const [choices, setChoices] = useState<Record<number, Choice>>(() =>
    Object.fromEntries(shortages.map((s) => [s.productId, { action: 'CORRECT', newQty: '', reason: '' }])));
  const set = (id: number, c: Partial<Choice>) => setChoices((x) => ({ ...x, [id]: { ...x[id], ...c } }));
  const valid = shortages.every((s) => {
    const c = choices[s.productId];
    if (c.action === 'CORRECT') return /^\d+$/.test(c.newQty) && Number(c.newQty) >= s.requested;
    return c.reason.trim().length >= 3;
  });
  const submit = () => {
    if (!valid) return;
    onDone(shortages.map((s) => {
      const c = choices[s.productId];
      return c.action === 'CORRECT' ? { productId: s.productId, action: 'CORRECT', newQty: Number(c.newQty) } : { productId: s.productId, action: 'RELEASE', reason: c.reason.trim() };
    }));
  };
  return (
    <Modal title="Estoque insuficiente" onClose={() => onDone(null)} footer={<>
      <button className="btn danger" onClick={() => onDone(null)}>Cancelar venda</button>
      <button className="btn go lg" disabled={!valid} onClick={submit}>Continuar e vender</button>
    </>}>
      <p className="muted" style={{ marginTop: 0 }}>O sistema registra menos unidades do que o pedido. Escolha o que fazer com cada produto — tudo fica no histórico com seu nome.</p>
      <div className="col gap-lg">
        {shortages.map((s) => {
          const c = choices[s.productId];
          return (
            <div key={s.productId} className="card tight">
              <div className="row between wrap"><b>{s.name}</b><span className="badge danger">registrado {s.stock} · pedido {s.requested}</span></div>
              <div className="col mt" style={{ gap: 6 }}>
                <label className="check"><input type="radio" checked={c.action === 'CORRECT'} onChange={() => set(s.productId, { action: 'CORRECT' })} />
                  <span><b>Corrigir o estoque e vender</b> <span className="small muted">— contei e tem mais do que o sistema mostra</span></span></label>
                {c.action === 'CORRECT' && (
                  <label className="field" style={{ paddingLeft: 32 }}>
                    <span>Quantidade que existe agora (antes desta venda)</span>
                    <input className="input" inputMode="numeric" value={c.newQty} onChange={(e) => set(s.productId, { newQty: e.target.value.replace(/\D/g, '') })} />
                    {c.newQty && Number(c.newQty) < s.requested && <span className="small cancel-text">Precisa ser pelo menos {s.requested}.</span>}
                  </label>
                )}
                <label className="check"><input type="radio" checked={c.action === 'RELEASE'} onChange={() => set(s.productId, { action: 'RELEASE' })} />
                  <span><b>Liberar a venda</b> <span className="small muted">— vende assim mesmo e registra divergência (estoque fica em 0)</span></span></label>
                {c.action === 'RELEASE' && (
                  <label className="field" style={{ paddingLeft: 32 }}>
                    <span>Motivo (obrigatório)</span>
                    <input className="input" value={c.reason} onChange={(e) => set(s.productId, { reason: e.target.value })} placeholder="Ex.: tinha no freezer, contagem atrasada" maxLength={300} />
                  </label>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
