import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { brl } from '../../format';
import { Modal, Spinner } from '../../components/ui';

type PGroup = { id: number; name: string; required: boolean; multiple: boolean; options: { id: number; name: string; priceDeltaCents: number }[] };
type PProduct = { id: number; name: string; description: string; priceCents: number; imageUrl: string | null; groups: PGroup[] };
type PMenu = { enabled: boolean; name: string; whatsappNumber: string | null; isOpen?: boolean; deliveryOpen?: boolean; categories?: { id: number; name: string; products: PProduct[] }[] };
type Line = { key: number; product: PProduct; optionIds: number[]; labels: string[]; unit: number; quantity: number };

let seq = 1;
const waLink = (n: string) => `https://wa.me/${n.startsWith('55') ? n : `55${n}`}`;

export default function PublicMenu() {
  useEffect(() => { document.title = 'Happy Alpha — Cardápio'; }, []);
  // Estado ABERTO/FECHADO segue o botão do caixa; confere a cada 15 s e ao voltar para a aba
  const { data, isLoading } = useQuery({ queryKey: ['public-menu'], queryFn: () => api.get<PMenu>('/api/public/menu'), refetchInterval: 15_000, refetchOnWindowFocus: true });
  const [cart, setCart] = useState<Line[]>([]);
  const [pick, setPick] = useState<PProduct | null>(null);
  const [checkout, setCheckout] = useState(false);
  const [done, setDone] = useState<{ orderNumber: number; totalCents: number } | null>(null);
  const total = cart.reduce((s, l) => s + l.unit * l.quantity, 0);
  const count = cart.reduce((s, l) => s + l.quantity, 0);

  if (isLoading || !data) return <Spinner />;

  const wa = data.whatsappNumber ? (
    <a className="btn go block lg" href={waLink(data.whatsappNumber)} target="_blank" rel="noreferrer">💬 Pedir pelo WhatsApp</a>
  ) : null;

  if (!data.enabled) return (
    <div className="pub">
      <img src="/logo.png" alt="Happy Alpha" className="pub-logo" />
      <div className="card center col gap-lg" style={{ margin: 16 }}>
        <h2>Cardápio digital indisponível</h2>
        <p className="muted">Faça seu pedido no balcão.</p>
        {wa}
      </div>
    </div>
  );

  if (done) return (
    <div className="pub">
      <img src="/logo.png" alt="Happy Alpha" className="pub-logo" />
      <div className="card center col gap-lg" style={{ margin: 16 }}>
        <div style={{ fontSize: 48 }}>✅</div>
        <h2>Pedido #{done.orderNumber} enviado!</h2>
        <p className="muted">Total {brl(done.totalCents)}. Aguarde a confirmação do caixa — o pagamento é feito no balcão.</p>
        <button className="btn primary block" onClick={() => { setDone(null); setCart([]); }}>Fazer outro pedido</button>
      </div>
    </div>
  );

  if (!data.isOpen) return (
    <div className="pub">
      <img src="/logo.png" alt="Happy Alpha" className="pub-logo" />
      <div className="card center col gap-lg" style={{ margin: 16 }}>
        <div style={{ fontSize: 48 }}>🌙</div>
        <h2>Estabelecimento fechado</h2>
        <p className="muted">No momento não estamos recebendo pedidos. Assim que abrirmos, o cardápio aparece aqui automaticamente.</p>
        {cart.length > 0 && <p className="small muted">Seu pedido não enviado foi guardado nesta tela.</p>}
        {data.whatsappNumber && <a className="btn block lg" href={waLink(data.whatsappNumber)} target="_blank" rel="noreferrer">💬 Falar com a gente no WhatsApp</a>}
      </div>
    </div>
  );

  const add = (p: PProduct, optionIds: number[], quantity: number) => {
    const opts = p.groups.flatMap((g) => g.options).filter((o) => optionIds.includes(o.id));
    setCart((c) => [...c, { key: seq++, product: p, optionIds, labels: opts.map((o) => o.name), unit: p.priceCents + opts.reduce((s, o) => s + o.priceDeltaCents, 0), quantity }]);
  };

  return (
    <div className="pub">
      <header className="pub-head">
        <img src="/logo.png" alt="Happy Alpha" className="pub-logo" />
        <div className="row wrap center" style={{ justifyContent: 'center', gap: 8 }}>
          <span className={`badge ${data.isOpen ? 'ok' : 'danger'}`}>{data.isOpen ? 'Aberto agora' : 'Fechado'}</span>
          <span className={`badge ${data.deliveryOpen ? 'ok' : ''}`}>Delivery {data.deliveryOpen ? 'aberto' : 'fechado'}</span>
        </div>
        <nav className="pub-cats">{data.categories!.map((c) => <a key={c.id} href={`#cat-${c.id}`}>{c.name}</a>)}</nav>
      </header>
      <main className="pub-main">
        {data.categories!.map((c) => (
          <section key={c.id} id={`cat-${c.id}`}>
            <h2 className="pub-cat-title">{c.name}</h2>
            {c.products.map((p) => (
              <button key={p.id} className="pub-item" disabled={!data.isOpen} onClick={() => (p.groups.length ? setPick(p) : add(p, [], 1))}>
                {p.imageUrl && <img src={p.imageUrl} alt="" />}
                <div className="grow" style={{ textAlign: 'left' }}>
                  <div style={{ fontWeight: 700 }}>{p.name}</div>
                  {p.description && <div className="small muted">{p.description}</div>}
                  <div className="num" style={{ color: 'var(--brand)', fontWeight: 800, marginTop: 4 }}>{brl(p.priceCents)}</div>
                </div>
                {data.isOpen && <span className="pub-add">＋</span>}
              </button>
            ))}
          </section>
        ))}
        <div style={{ padding: '16px 0 120px' }}>{wa}</div>
      </main>

      {count > 0 && (
        <button className="cart-fab" style={{ display: 'flex' }} onClick={() => setCheckout(true)}>
          Ver pedido · {count} · <b className="num">{brl(total)}</b>
        </button>
      )}
      {pick && <PubOptions p={pick} onClose={() => setPick(null)} onAdd={(ids, q) => { add(pick, ids, q); setPick(null); }} />}
      {checkout && <Checkout cart={cart} setCart={setCart} total={total} deliveryOpen={!!data.deliveryOpen} onClose={() => setCheckout(false)} onDone={(r) => { setCheckout(false); setDone(r); }} />}
    </div>
  );
}

function PubOptions({ p, onClose, onAdd }: { p: PProduct; onClose: () => void; onAdd: (ids: number[], q: number) => void }) {
  const [sel, setSel] = useState<Record<number, number[]>>({});
  const [q, setQ] = useState(1);
  const ids = Object.values(sel).flat();
  const missing = p.groups.some((g) => g.required && !(sel[g.id]?.length));
  const unit = p.priceCents + p.groups.flatMap((g) => g.options).filter((o) => ids.includes(o.id)).reduce((s, o) => s + o.priceDeltaCents, 0);
  return (
    <Modal title={p.name} onClose={onClose} footer={<>
      <div className="stepper lg" style={{ marginRight: 'auto' }}>
        <button onClick={() => setQ(Math.max(1, q - 1))}>−</button><span className="num">{q}</span><button onClick={() => setQ(Math.min(20, q + 1))}>+</button>
      </div>
      <button className="btn go lg" disabled={missing} onClick={() => onAdd(ids, q)}>Adicionar · {brl(unit * q)}</button>
    </>}>
      <div className="col gap-lg">
        {p.groups.map((g) => (
          <div key={g.id}>
            <div className="row between" style={{ marginBottom: 8 }}><b>{g.name}</b><span className="badge">{g.required ? 'obrigatório' : 'opcional'}</span></div>
            <div className="opt-grid">
              {g.options.map((o) => {
                const on = sel[g.id]?.includes(o.id);
                return <button key={o.id} className={`opt-btn${on ? ' on' : ''}`} onClick={() => setSel((s) => ({ ...s, [g.id]: g.multiple ? (on ? s[g.id].filter((x) => x !== o.id) : [...(s[g.id] ?? []), o.id]) : on ? [] : [o.id] }))}>
                  <span>{o.name}</span><span className="small">{o.priceDeltaCents ? `+ ${brl(o.priceDeltaCents)}` : ''}</span>
                </button>;
              })}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function Checkout({ cart, setCart, total, deliveryOpen, onClose, onDone }: {
  cart: Line[]; setCart: (f: (c: Line[]) => Line[]) => void; total: number; deliveryOpen: boolean;
  onClose: () => void; onDone: (r: { orderNumber: number; totalCents: number }) => void;
}) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'BALCAO' | 'LOCAL' | 'ENTREGA'>('BALCAO');
  const [location, setLocation] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const valid = cart.length > 0 && (mode !== 'ENTREGA' || location.trim().length > 2);
  type Mode = 'BALCAO' | 'LOCAL' | 'ENTREGA';
  const modes = useMemo(() => {
    const m: { v: Mode; label: string }[] = [{ v: 'BALCAO', label: 'Retirar no balcão' }, { v: 'LOCAL', label: 'Consumir aqui' }];
    if (deliveryOpen) m.push({ v: 'ENTREGA', label: 'Entrega' });
    return m;
  }, [deliveryOpen]);

  const send = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.post<{ orderNumber: number; totalCents: number }>('/api/public/orders', {
        customerName: name, mode, location, note,
        items: cart.map((l) => ({ productId: l.product.id, quantity: l.quantity, optionIds: l.optionIds })),
      });
      onDone(r);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Modal title="Seu pedido" onClose={onClose} footer={
      <button className="btn go lg block" disabled={!valid || busy} onClick={send}>{busy ? 'Enviando…' : `Enviar pedido · ${brl(total)}`}</button>
    }>
      <div className="col gap-lg">
        <div>
          {cart.map((l) => (
            <div key={l.key} className="kv">
              <span>{l.quantity}× {l.product.name}{l.labels.length > 0 && <span className="small muted"> · {l.labels.join(', ')}</span>}</span>
              <span className="row"><span className="v">{brl(l.unit * l.quantity)}</span><button className="btn sm ghost icon" onClick={() => setCart((c) => c.filter((x) => x.key !== l.key))}>✕</button></span>
            </div>
          ))}
        </div>
        <label className="field"><span>Seu nome (opcional)</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></label>
        <div className="seg">{modes.map((m) => <button key={m.v} className={mode === m.v ? 'on' : ''} onClick={() => setMode(m.v)}>{m.label}</button>)}</div>
        <label className="field"><span>{mode === 'ENTREGA' ? 'Endereço / casa (obrigatório)' : 'Onde você está? (opcional)'}</span>
          <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder={mode === 'ENTREGA' ? 'Ex.: casa 123' : 'Ex.: perto da piscina'} maxLength={120} /></label>
        <label className="field"><span>Observação</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: sem cebola" maxLength={200} /></label>
        <div className="small muted">O pedido será confirmado pelo caixa. O pagamento é feito no balcão.</div>
        {err && <div className="cancel-text">{err}</div>}
      </div>
    </Modal>
  );
}
