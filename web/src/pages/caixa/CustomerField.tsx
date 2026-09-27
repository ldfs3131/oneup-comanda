import { useEffect, useState } from 'react';
import { api, qs } from '../../api';
import { brl, dateOnly } from '../../format';
import type { CustomerSuggestion } from '../../types';

/** Nome do cliente com sugestões do cadastro leve e alerta de pendência (fiado). */
export function CustomerField({ value, onChange, onPick, autoFocus, label = 'Cliente (opcional)' }: {
  value: string; onChange: (v: string) => void; onPick?: (c: CustomerSuggestion) => void; autoFocus?: boolean; label?: string;
}) {
  const [list, setList] = useState<CustomerSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<CustomerSuggestion | null>(null);

  useEffect(() => {
    const q = value.trim();
    if (q.length < 2 || picked?.name === q) { setList([]); return; }
    const t = setTimeout(() => {
      api.get<CustomerSuggestion[]>(`/api/customers/suggest${qs({ q })}`).then((r) => { setList(r); setOpen(true); }).catch(() => setList([]));
    }, 220);
    return () => clearTimeout(t);
  }, [value, picked]);

  const pendingHit = picked && picked.pendingCents > 0 ? picked : list.find((c) => c.pendingCents > 0 && c.name.toLowerCase() === value.trim().toLowerCase());

  return (
    <div className="field grow" style={{ position: 'relative' }}>
      <span>{label}</span>
      <input className="input" value={value} autoFocus={autoFocus} maxLength={80} placeholder="Ex.: João"
        onChange={(e) => { onChange(e.target.value); setPicked(null); }}
        onFocus={() => list.length && setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {open && list.length > 0 && (
        <div className="suggest">
          {list.map((c) => (
            <button key={c.id} type="button" className="suggest-item" onMouseDown={(e) => e.preventDefault()} onClick={() => {
              onChange(c.name); setPicked(c); setOpen(false); onPick?.(c);
            }}>
              <span className="grow">
                <b>{c.name}</b>
                <span className="small muted">{[c.contact, c.phone].filter(Boolean).join(' · ')}</span>
              </span>
              {c.pendingCents > 0 && <span className="badge danger">deve {brl(c.pendingCents)}</span>}
            </button>
          ))}
        </div>
      )}
      {pendingHit && (
        <div className="pending-alert">⚠ {pendingHit.name} tem <b>{brl(pendingHit.pendingCents)}</b> pendente{pendingHit.pendingCount > 1 ? ` em ${pendingHit.pendingCount} contas` : ''}{pendingHit.pendingSince ? ` desde ${dateOnly(pendingHit.pendingSince)}` : ''}. Vale lembrar o cliente.</div>
      )}
    </div>
  );
}
