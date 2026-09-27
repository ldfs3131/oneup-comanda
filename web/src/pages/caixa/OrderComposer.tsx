import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { brl } from '../../format';
import type { Category, Product } from '../../types';
import { Modal, Spinner } from '../../components/ui';

export type CartLine = {
  key: number; productId: number; name: string; unitCents: number; quantity: number;
  optionIds: number[]; optionLabels: string[]; note: string; kitchen: boolean;
};

export function useMenu() {
  return useQuery({ queryKey: ['menu'], queryFn: () => api.get<Category[]>('/api/menu'), staleTime: 60_000 });
}

let keySeq = 1;

export default function OrderComposer({ header, submitLabel, busy, onSubmit }: {
  header?: ReactNode; submitLabel: string; busy: boolean;
  onSubmit: (lines: CartLine[], note: string) => Promise<boolean>;
}) {
  const { data: menu, isLoading } = useMenu();
  const cats = useMemo(() => (menu ?? []).filter((c) => c.products.length), [menu]);
  const [catId, setCatId] = useState<number | 'all'>('all');
  const [search, setSearch] = useState('');
  const [lines, setLines] = useState<CartLine[]>([]);
  const [picking, setPicking] = useState<Product | null>(null);
  const [editNote, setEditNote] = useState<CartLine | null>(null);
  const [orderNote, setOrderNote] = useState('');
  const [showCart, setShowCart] = useState(false);

  const products = useMemo(() => {
    const s = search.trim().toLowerCase();
    const src = catId === 'all' ? cats.flatMap((c) => c.products) : cats.find((c) => c.id === catId)?.products ?? [];
    return s ? cats.flatMap((c) => c.products).filter((p) => p.name.toLowerCase().includes(s)) : src;
  }, [cats, catId, search]);

  const total = lines.reduce((s, l) => s + l.unitCents * l.quantity, 0);
  const count = lines.reduce((s, l) => s + l.quantity, 0);

  const add = (p: Product, optionIds: number[] = [], qty = 1, note = '') => {
    const opts = p.groups.flatMap((g) => g.options).filter((o) => optionIds.includes(o.id));
    const unit = p.priceCents + opts.reduce((s, o) => s + o.priceDeltaCents, 0);
    setLines((ls) => {
      const same = ls.find((l) => l.productId === p.id && l.note === note && l.optionIds.join() === optionIds.join());
      if (same) return ls.map((l) => (l === same ? { ...l, quantity: Math.min(99, l.quantity + qty) } : l));
      return [...ls, { key: keySeq++, productId: p.id, name: p.name, unitCents: unit, quantity: qty, optionIds, optionLabels: opts.map((o) => o.name), note, kitchen: p.sendsToKitchen }];
    });
  };
  const tap = (p: Product) => {
    if (!p.available) return;
    if (p.groups.some((g) => g.options.length)) setPicking(p);
    else add(p);
  };
  const setQty = (key: number, q: number) =>
    setLines((ls) => (q <= 0 ? ls.filter((l) => l.key !== key) : ls.map((l) => (l.key === key ? { ...l, quantity: Math.min(99, q) } : l))));

  const submit = async () => {
    if (!lines.length || busy) return;
    if (await onSubmit(lines, orderNote)) { setLines([]); setOrderNote(''); setShowCart(false); }
  };

  if (isLoading) return <Spinner />;

  return (
    <div className="composer">
      <section className="composer-menu">
        {header}
        <div className="row wrap" style={{ gap: 8 }}>
          <input className="input" style={{ maxWidth: 260 }} placeholder="Buscar produto" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="cat-tabs">
            <button className={catId === 'all' && !search ? 'on' : ''} onClick={() => { setCatId('all'); setSearch(''); }}>Todos</button>
            {cats.map((c) => (
              <button key={c.id} className={catId === c.id && !search ? 'on' : ''} onClick={() => { setCatId(c.id); setSearch(''); }}>{c.name}</button>
            ))}
          </div>
        </div>
        <div className="prod-grid">
          {products.map((p) => {
            const inCart = lines.filter((l) => l.productId === p.id).reduce((s, l) => s + l.quantity, 0);
            return (
              <button key={p.id} className={`prod-btn${p.available ? '' : ' out'}${inCart ? ' in' : ''}`} onClick={() => tap(p)} disabled={!p.available}>
                {inCart > 0 && <span className="prod-qty">{inCart}</span>}
                <span className="prod-name">{p.name}</span>
                <span className="prod-price num">{p.available ? brl(p.priceCents) : 'ESGOTADO'}</span>
                {p.groups.some((g) => g.options.length) && p.available && <span className="prod-opt">opções</span>}
                {!p.sendsToKitchen && p.available && <span className="prod-opt">balcão</span>}
              </button>
            );
          })}
          {!products.length && <div className="empty">Nenhum produto {search ? `para “${search}”` : 'nesta categoria'}.</div>}
        </div>
      </section>

      <aside className={`composer-cart${showCart ? ' open' : ''}`}>
        <div className="row between">
          <h2>Pedido</h2>
          <button className="btn ghost sm show-mobile-only" onClick={() => setShowCart(false)}>Fechar</button>
        </div>
        <div className="cart-lines">
          {!lines.length && <div className="empty small">Toque nos produtos para adicionar.</div>}
          {lines.map((l) => (
            <div key={l.key} className="cart-line">
              <div className="grow">
                <div style={{ fontWeight: 700 }}>{l.name}</div>
                {l.optionLabels.length > 0 && <div className="small muted">{l.optionLabels.join(' · ')}</div>}
                {l.note && <div className="small note-text">“{l.note}”</div>}
                <div className="row small" style={{ gap: 10, marginTop: 4 }}>
                  <button className="linkish" onClick={() => setEditNote(l)}>{l.note ? 'editar obs.' : '+ obs.'}</button>
                  {!l.kitchen && <span className="faint">balcão</span>}
                </div>
              </div>
              <div className="col" style={{ alignItems: 'flex-end', gap: 6 }}>
                <div className="stepper">
                  <button onClick={() => setQty(l.key, l.quantity - 1)} aria-label="Menos">−</button>
                  <span className="num">{l.quantity}</span>
                  <button onClick={() => setQty(l.key, l.quantity + 1)} aria-label="Mais">+</button>
                </div>
                <span className="num small">{brl(l.unitCents * l.quantity)}</span>
              </div>
            </div>
          ))}
        </div>
        {lines.length > 0 && (
          <input className="input" placeholder="Observação do pedido (ex.: sem cebola)" value={orderNote} onChange={(e) => setOrderNote(e.target.value)} maxLength={200} />
        )}
        <div className="cart-total">
          <span>{count} {count === 1 ? 'item' : 'itens'}</span>
          <span className="num">{brl(total)}</span>
        </div>
        <button className="btn go xl block" disabled={!lines.length || busy} onClick={submit}>
          {busy ? 'Enviando…' : submitLabel}
        </button>
      </aside>

      {lines.length > 0 && !showCart && (
        <button className="cart-fab show-mobile-only" onClick={() => setShowCart(true)}>
          Ver pedido · {count} · <b className="num">{brl(total)}</b>
        </button>
      )}

      {picking && <OptionPicker product={picking} onClose={() => setPicking(null)} onAdd={(ids, q, n) => { add(picking, ids, q, n); setPicking(null); }} />}
      {editNote && <NoteModal line={editNote} onClose={() => setEditNote(null)} onSave={(note) => {
        setLines((ls) => ls.map((l) => (l.key === editNote.key ? { ...l, note } : l))); setEditNote(null);
      }} />}
    </div>
  );
}

function OptionPicker({ product, onClose, onAdd }: { product: Product; onClose: () => void; onAdd: (ids: number[], qty: number, note: string) => void }) {
  const [sel, setSel] = useState<Record<number, number[]>>({});
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const groups = product.groups.filter((g) => g.options.length);
  const ids = Object.values(sel).flat();
  const missing = groups.filter((g) => g.required && !(sel[g.id]?.length));
  const unit = product.priceCents + groups.flatMap((g) => g.options).filter((o) => ids.includes(o.id)).reduce((s, o) => s + o.priceDeltaCents, 0);

  const toggle = (gid: number, oid: number, multiple: boolean) => setSel((s) => {
    const cur = s[gid] ?? [];
    if (multiple) return { ...s, [gid]: cur.includes(oid) ? cur.filter((x) => x !== oid) : [...cur, oid] };
    return { ...s, [gid]: cur.includes(oid) ? [] : [oid] };
  });

  return (
    <Modal title={product.name} onClose={onClose} footer={<>
      <div className="stepper lg" style={{ marginRight: 'auto' }}>
        <button onClick={() => setQty((q) => Math.max(1, q - 1))}>−</button>
        <span className="num">{qty}</span>
        <button onClick={() => setQty((q) => Math.min(99, q + 1))}>+</button>
      </div>
      <button className="btn go lg" disabled={missing.length > 0} onClick={() => onAdd(ids.sort((a, b) => a - b), qty, note.trim())}>
        Adicionar · {brl(unit * qty)}
      </button>
    </>}>
      {product.description && <p className="muted" style={{ marginTop: 0 }}>{product.description}</p>}
      <div className="col gap-lg">
        {groups.map((g) => (
          <div key={g.id}>
            <div className="row between" style={{ marginBottom: 8 }}>
              <b>{g.name}</b>
              <span className={`badge ${g.required ? (sel[g.id]?.length ? 'ok' : 'warn') : ''}`}>{g.required ? 'obrigatório' : 'opcional'}</span>
            </div>
            <div className="opt-grid">
              {g.options.map((o) => {
                const on = sel[g.id]?.includes(o.id);
                return (
                  <button key={o.id} className={`opt-btn${on ? ' on' : ''}`} disabled={!o.available} onClick={() => toggle(g.id, o.id, g.multiple)}>
                    <span>{o.name}</span>
                    <span className="small num">{!o.available ? 'esgotado' : o.priceDeltaCents ? `+ ${brl(o.priceDeltaCents)}` : ''}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <label className="field">
          <span>Observação do item</span>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: bem passado" maxLength={200} />
        </label>
      </div>
    </Modal>
  );
}

function NoteModal({ line, onClose, onSave }: { line: CartLine; onClose: () => void; onSave: (n: string) => void }) {
  const [note, setNote] = useState(line.note);
  return (
    <Modal title={`Observação — ${line.name}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary" onClick={() => onSave(note.trim())}>Salvar</button>
    </>}>
      <input className="input" autoFocus value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onSave(note.trim())} placeholder="Ex.: sem cebola" maxLength={200} />
      <div className="row wrap mt">
        {['Sem cebola', 'Bem passado', 'Ao ponto', 'Sem sal', 'Para viagem'].map((s) => <button key={s} className="btn sm" onClick={() => setNote(s)}>{s}</button>)}
      </div>
    </Modal>
  );
}

export function linesToItems(lines: CartLine[]) {
  return lines.map((l) => ({ productId: l.productId, quantity: l.quantity, optionIds: l.optionIds, note: l.note || null }));
}
