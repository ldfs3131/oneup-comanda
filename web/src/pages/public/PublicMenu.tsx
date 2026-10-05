import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, chaveDoEnvio, idAparelho, type ChaveEnvio } from '../../api';
import { brl } from '../../format';
import { Modal, Seg, Spinner } from '../../components/ui';
import { BrandLogo, usePageTitle } from '../../components/brand';
import { BotaoBaixarApp } from '../../components/instalar';
import '../../styles/clientes.css';

type PGroup = { id: number; name: string; required: boolean; multiple: boolean; options: { id: number; name: string; priceDeltaCents: number }[] };
type PProduct = { id: number; name: string; description: string; priceCents: number; imageUrl: string | null; soldOut?: boolean; groups: PGroup[] };
type PMenu = { enabled: boolean; name: string; whatsappNumber: string | null; isOpen?: boolean; deliveryOpen?: boolean; config?: Record<string, any>; categories?: { id: number; name: string; products: PProduct[] }[] };
type Line = { key: number; product: PProduct; optionIds: number[]; labels: string[]; unit: number; quantity: number };

let seq = 1;
const waLink = (n: string) => `https://wa.me/${n.startsWith('55') ? n : `55${n}`}`;

export default function PublicMenu() {
  usePageTitle('Cardápio');
  // Estado ABERTO/FECHADO segue o botão do caixa; confere a cada 15 s e ao voltar para a aba
  const { data, isLoading } = useQuery({ queryKey: ['public-menu'], queryFn: () => api.get<PMenu>('/api/public/menu'), refetchInterval: 60_000, refetchOnWindowFocus: true });
  const [cart, setCart] = useState<Line[]>([]);
  const [pick, setPick] = useState<PProduct | null>(null);
  const [checkout, setCheckout] = useState(false);
  const nav = useNavigate();
  const ultimo = lerLocal('oneup:ultimo-pedido');
  const total = cart.reduce((s, l) => s + l.unit * l.quantity, 0);
  const count = cart.reduce((s, l) => s + l.quantity, 0);

  if (isLoading || !data) return <Spinner />;
  const cfg = data.config ?? {};
  const logo = <div className="pub-logo-wrap"><BrandLogo className="pub-logo" height={96} logo={cfg.logo ?? null} name={data.name} /></div>;
  const links = (cfg.link_site || cfg.link_grupo) ? (
    <div className="row wrap" style={{ justifyContent: 'center', gap: 8 }}>
      {cfg.link_grupo && <a className="btn" href={cfg.link_grupo} target="_blank" rel="noreferrer">Entrar no grupo</a>}
      {cfg.link_site && <a className="btn" href={cfg.link_site} target="_blank" rel="noreferrer">Nosso site</a>}
    </div>
  ) : null;

  const wa = data.whatsappNumber ? (
    <a className="btn go block lg" href={waLink(data.whatsappNumber)} target="_blank" rel="noreferrer">💬 Pedir pelo WhatsApp</a>
  ) : null;

  if (!data.enabled) return (
    <div className="pub">
      {logo}
      <div className="card center col gap-lg" style={{ margin: 16 }}>
        <h2>Cardápio digital indisponível</h2>
        <p className="muted">Faça seu pedido no balcão.</p>
        {wa}
      </div>
    </div>
  );

  if (!data.isOpen) return (
    <div className="pub">
      {logo}
      <div className="card center col gap-lg" style={{ margin: 16 }}>
        <div style={{ fontSize: 48 }}>🌙</div>
        <h2>Estabelecimento fechado</h2>
        <p className="muted">{cfg.texto_fechado || 'No momento não estamos recebendo pedidos.'}</p>
        {cart.length > 0 && <p className="small muted">Seu pedido não enviado foi guardado nesta tela.</p>}
        {data.whatsappNumber && <a className="btn block lg" href={waLink(data.whatsappNumber)} target="_blank" rel="noreferrer">💬 Falar com a gente no WhatsApp</a>}
        {links}
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
        {logo}
        <div className="row wrap center" style={{ justifyContent: 'center', gap: 8 }}>
          <span className={`badge ${data.isOpen ? 'ok' : 'danger'}`}>{data.isOpen ? 'Aberto agora' : 'Fechado'}</span>
          <span className={`badge ${data.deliveryOpen ? 'ok' : ''}`}>Delivery {data.deliveryOpen ? 'aberto' : 'fechado'}</span>
        </div>
        {cfg.boas_vindas && <p className="pub-welcome">{cfg.boas_vindas}</p>}
        {ultimo && <a className="btn sm ghost" href={`/cardapio/pedido/${ultimo}`} onClick={(e) => { e.preventDefault(); nav(`/cardapio/pedido/${ultimo}`); }}>📍 Acompanhar meu último pedido</a>}
        <div className={`pub-app${new URLSearchParams(location.search).has('instalar') ? ' destaque' : ''}`}><BotaoBaixarApp para="cliente" className="btn sm" texto="Baixar o app" /></div>
      </header>
      <BarraCategorias cats={data.categories!.map((c) => ({ id: c.id, name: c.name }))} />
      <main className="pub-main">
        {data.categories!.map((c) => (
          <section key={c.id} id={`cat-${c.id}`}>
            <h2 className="pub-cat-title">{c.name}</h2>
            {c.products.map((p) => (
              <button key={p.id} className={`pub-item${p.soldOut ? ' sold-out' : ''}`} disabled={!data.isOpen || p.soldOut} onClick={() => (p.groups.length ? setPick(p) : add(p, [], 1))}>
                {p.imageUrl && <img src={p.imageUrl} alt="" />}
                <div className="grow" style={{ textAlign: 'left' }}>
                  <div style={{ fontWeight: 700 }}>{p.name}</div>
                  {p.description && <div className="small muted">{p.description}</div>}
                  <div className="num" style={{ color: 'var(--brand-text)', fontWeight: 800, marginTop: 4 }}>{brl(p.priceCents)}</div>
                </div>
                {p.soldOut ? <span className="badge">Acabou</span> : data.isOpen && <span className="pub-add">＋</span>}
              </button>
            ))}
          </section>
        ))}
        <div className="col gap-lg" style={{ padding: '16px 0 0' }}>{wa}{links}</div>
        <footer className="pub-rodape-privacidade" style={{ paddingBottom: 120 }}><a href="/privacidade">Privacidade e seus dados</a></footer>
      </main>

      {count > 0 && (
        <button className="cart-fab" style={{ display: 'flex' }} onClick={() => setCheckout(true)}>
          Ver pedido · {count} · <b className="num">{brl(total)}</b>
        </button>
      )}
      {pick && <PubOptions p={pick} onClose={() => setPick(null)} onAdd={(ids, q) => { add(pick, ids, q); setPick(null); }} />}
      {checkout && <Checkout cart={cart} setCart={setCart} total={total} deliveryOpen={!!data.deliveryOpen} restaurante={data.name} onClose={() => setCheckout(false)}
        onDone={(r) => { setCheckout(false); setCart([]); gravarLocal('oneup:ultimo-pedido', r.token); nav(`/cardapio/pedido/${r.token}`); }} />}
    </div>
  );
}

/**
 * Faixa de categorias que gruda no topo (só ela; o logotipo e os avisos rolam para cima e liberam espaço).
 * Mede a própria altura na hora, então o toque leva o título da categoria para logo abaixo da faixa em qualquer
 * celular e com qualquer logotipo. Marca a categoria em que a pessoa está e mantém o botão dela visível na faixa.
 */
function BarraCategorias({ cats }: { cats: { id: number; name: string }[] }) {
  const barra = useRef<HTMLDivElement>(null);
  const faixa = useRef<HTMLElement>(null);
  const [ativa, setAtiva] = useState<number | null>(cats[0]?.id ?? null);
  const [compacta, setCompacta] = useState(false);
  const travada = useRef<{ id: number; ate: number } | null>(null);
  const suave = () => (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth') as ScrollBehavior;
  const alturaBarra = () => barra.current?.getBoundingClientRect().height ?? 0;

  // Categoria atual = a última cujo título já passou por baixo da faixa. No fim da página, a última que aparece.
  useEffect(() => {
    let quadro = 0;
    const calcular = () => {
      quadro = 0;
      const el = barra.current;
      if (!el) return;
      setCompacta(el.getBoundingClientRect().top <= 1);
      const trava = travada.current;
      if (trava && Date.now() < trava.ate) { setAtiva(trava.id); return; }
      travada.current = null;
      const limite = alturaBarra() + 60;
      let atual: number | null = cats[0]?.id ?? null;
      for (const c of cats) {
        const sec = document.getElementById(`cat-${c.id}`);
        if (sec && sec.getBoundingClientRect().top <= limite) atual = c.id;
      }
      const fim = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      if (fim) {
        for (const c of cats) {
          const sec = document.getElementById(`cat-${c.id}`);
          if (sec && sec.getBoundingClientRect().top < window.innerHeight * 0.6) atual = c.id;
        }
      }
      setAtiva(atual);
    };
    const agendar = () => { if (!quadro) quadro = requestAnimationFrame(calcular); };
    const soltar = () => { if (travada.current) travada.current.ate = Math.min(travada.current.ate, Date.now() + 120); };
    calcular();
    window.addEventListener('scroll', agendar, { passive: true });
    window.addEventListener('resize', agendar);
    // A pessoa voltou a rolar com o dedo: a categoria tocada deixa de mandar.
    window.addEventListener('touchstart', soltar, { passive: true });
    window.addEventListener('wheel', soltar, { passive: true });
    return () => {
      if (quadro) cancelAnimationFrame(quadro);
      window.removeEventListener('scroll', agendar);
      window.removeEventListener('resize', agendar);
      window.removeEventListener('touchstart', soltar);
      window.removeEventListener('wheel', soltar);
    };
  }, [cats]);

  // O botão da categoria ativa fica sempre à vista na faixa (ex.: Bebidas, lá no fim).
  useEffect(() => {
    const f = faixa.current;
    const b = f?.querySelector<HTMLElement>(`[data-cat="${ativa}"]`);
    if (!f || !b) return;
    const alvo = b.offsetLeft - (f.clientWidth - b.offsetWidth) / 2;
    if (Math.abs(f.scrollLeft - alvo) > 4) f.scrollTo({ left: Math.max(0, alvo), behavior: suave() });
  }, [ativa]);

  const ir = (id: number) => {
    const sec = document.getElementById(`cat-${id}`);
    if (!sec) return;
    const topo = sec.getBoundingClientRect().top + window.scrollY - alturaBarra() + 1;
    travada.current = { id, ate: Date.now() + 1200 };
    setAtiva(id);
    window.scrollTo({ top: Math.max(0, topo), behavior: suave() });
    history.replaceState(null, '', `#cat-${id}`);
  };

  return (
    <div ref={barra} className={`pub-catbar${compacta ? ' compacta' : ''}`}>
      <nav ref={faixa} className="pub-cats" aria-label="Categorias do cardápio">
        {cats.map((c) => (
          <a key={c.id} data-cat={c.id} href={`#cat-${c.id}`} className={ativa === c.id ? 'on' : undefined} aria-current={ativa === c.id ? 'true' : undefined}
            onClick={(e) => { e.preventDefault(); ir(c.id); }}>{c.name}</a>
        ))}
      </nav>
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
        <button type="button" aria-label="Diminuir quantidade" onClick={() => setQ(Math.max(1, q - 1))}>−</button><span className="num" aria-live="polite" aria-label={`Quantidade: ${q}`}>{q}</span><button type="button" aria-label="Aumentar quantidade" onClick={() => setQ(Math.min(20, q + 1))}>+</button>
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
                return <button key={o.id} type="button" className={`opt-btn${on ? ' on' : ''}`} aria-pressed={!!on} onClick={() => setSel((s) => ({ ...s, [g.id]: g.multiple ? (on ? s[g.id].filter((x) => x !== o.id) : [...(s[g.id] ?? []), o.id]) : on ? [] : [o.id] }))}>
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

const lerLocal = (k: string) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } };
const gravarLocal = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* sem armazenamento: segue sem lembrar */ } };
const apagarLocal = (...ks: string[]) => { try { for (const k of ks) localStorage.removeItem(k); } catch { /* sem armazenamento */ } };
/** Nome/WhatsApp só ficam no aparelho se a pessoa marcou "Lembrar meus dados neste aparelho" (tablet compartilhado). */
const LEMBRAR = 'oneup:lembrar-dados';
function dadosLembrados() {
  if (lerLocal(LEMBRAR) !== '1') { apagarLocal('oneup:cliente-nome', 'oneup:cliente-zap'); return { nome: '', zap: '', lembrar: false }; }
  return { nome: lerLocal('oneup:cliente-nome'), zap: lerLocal('oneup:cliente-zap'), lembrar: true };
}

/** (11) 91234-5678 enquanto digita */
function mascaraZap(v: string) {
  const d = v.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}
function zapValido(v: string) {
  const d = v.replace(/\D/g, '');
  return (d.length === 10 || (d.length === 11 && d[2] === '9')) && Number(d.slice(0, 2)) >= 11;
}

type Mode = 'BALCAO' | 'LOCAL' | 'ENTREGA';
const MODO_LABEL: Record<Mode, string> = { BALCAO: 'Retirar no balcão', LOCAL: 'Consumir aqui', ENTREGA: 'Entrega' };

function Checkout({ cart, setCart, total, deliveryOpen, restaurante, onClose, onDone }: {
  cart: Line[]; setCart: (f: (c: Line[]) => Line[]) => void; total: number; deliveryOpen: boolean; restaurante: string;
  onClose: () => void; onDone: (r: { orderNumber: number; totalCents: number; token: string }) => void;
}) {
  const [salvos] = useState(dadosLembrados);
  const [name, setName] = useState(salvos.nome);
  const [zap, setZap] = useState(mascaraZap(salvos.zap));
  const [lembrar, setLembrar] = useState(salvos.lembrar); // desmarcada por padrão

  const [ofertas, setOfertas] = useState(false);
  const [mode, setMode] = useState<Mode>('BALCAO');
  const [location, setLocation] = useState('');
  const [note, setNote] = useState('');
  const [revisar, setRevisar] = useState(false);
  const [tentou, setTentou] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const envio: ChaveEnvio = useRef(null);
  const nomeOk = name.trim().length >= 2;
  const zapOk = zapValido(zap);
  const valid = cart.length > 0 && nomeOk && zapOk && (mode !== 'ENTREGA' || location.trim().length > 2);
  const modes = useMemo(() => {
    const m: Mode[] = ['BALCAO', 'LOCAL'];
    if (deliveryOpen) m.push('ENTREGA');
    return m;
  }, [deliveryOpen]);

  const send = async () => {
    setBusy(true); setErr('');
    try {
      const corpo = {
        customerName: name.trim(), phone: zap, aceitaOfertas: ofertas, mode, location, note,
        items: cart.map((l) => ({ productId: l.product.id, quantity: l.quantity, optionIds: l.optionIds })),
      };
      // a mesma chave num novo toque depois de falha de internet: o restaurante não recebe o pedido duas vezes
      const r = await api.post<{ orderNumber: number; totalCents: number; token: string }>('/api/public/orders', corpo, chaveDoEnvio(envio, corpo), { 'x-aparelho': idAparelho() });
      envio.current = null;
      if (lembrar) { gravarLocal(LEMBRAR, '1'); gravarLocal('oneup:cliente-nome', name.trim()); gravarLocal('oneup:cliente-zap', zap.replace(/\D/g, '')); }
      else apagarLocal(LEMBRAR, 'oneup:cliente-nome', 'oneup:cliente-zap');
      onDone(r);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  if (revisar) return (
    <Modal title="Confira antes de enviar" onClose={onClose} footer={<div className="col" style={{ width: '100%', gap: 8 }}>
      <button className="btn go lg block" disabled={busy} onClick={send}>{busy ? 'Enviando…' : `Enviar pedido · ${brl(total)}`}</button>
      <button className="btn block" onClick={() => setRevisar(false)} disabled={busy}>Voltar e mudar</button>
    </div>}>
      <div className="col gap-lg">
        <div>
          {cart.map((l) => (
            <div key={l.key} className="kv"><span>{l.quantity}× {l.product.name}{l.labels.length > 0 && <span className="small muted"> · {l.labels.join(', ')}</span>}</span><span className="v">{brl(l.unit * l.quantity)}</span></div>
          ))}
          <div className="kv total"><span>Total</span><span className="v">{brl(total)}</span></div>
        </div>
        <div className="info-box small col" style={{ gap: 4 }}>
          <div><b>{name.trim()}</b> · WhatsApp {zap}</div>
          <div>{MODO_LABEL[mode]}{location.trim() ? ` · ${location.trim()}` : ''}</div>
          {note.trim() && <div>Obs.: {note.trim()}</div>}
          {ofertas && <div>✓ Aceito receber ofertas pelo WhatsApp</div>}
        </div>
        <div className="small muted">O caixa confirma o pedido e o pagamento é feito no balcão. Depois de enviar, você acompanha o andamento nesta tela.</div>
        {err && <div className="problem-box" role="alert">Não foi possível enviar: {err}</div>}
      </div>
    </Modal>
  );

  return (
    <Modal title="Seu pedido" onClose={onClose} footer={
      <button className="btn go lg block" disabled={cart.length === 0 || busy} onClick={() => { setTentou(true); if (valid) setRevisar(true); }}>Revisar pedido · {brl(total)}</button>
    }>
      <div className="col gap-lg">
        <div>
          {cart.map((l) => (
            <div key={l.key} className="pub-cart-line">
              <span className="pub-cart-name">{l.product.name}{l.labels.length > 0 && <span className="small muted"> · {l.labels.join(', ')}</span>}</span>
              {/* − na quantidade 1 tira o item do pedido */}
              <span className="stepper qty" role="group" aria-label={`Quantidade de ${l.product.name}`}>
                <button type="button" aria-label={l.quantity <= 1 ? `Tirar ${l.product.name} do pedido` : `Diminuir ${l.product.name}`}
                  onClick={() => setCart((c) => (l.quantity <= 1 ? c.filter((x) => x.key !== l.key) : c.map((x) => (x.key === l.key ? { ...x, quantity: x.quantity - 1 } : x))))}>
                  {l.quantity <= 1 ? <span aria-hidden="true" style={{ fontSize: '1rem' }}>🗑</span> : '−'}
                </button>
                <span className="num" aria-live="polite">{l.quantity}</span>
                <button type="button" aria-label={`Aumentar ${l.product.name}`} disabled={l.quantity >= 20}
                  onClick={() => setCart((c) => c.map((x) => (x.key === l.key ? { ...x, quantity: Math.min(20, x.quantity + 1) } : x)))}>+</button>
              </span>
              <span className="pub-cart-price">{brl(l.unit * l.quantity)}</span>
            </div>
          ))}
          {cart.length === 0 && <div className="muted">Seu pedido está vazio. Feche e toque nos itens do cardápio.</div>}
        </div>
        <label className="field"><span>Seu nome *</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="name" />
          {tentou && !nomeOk && <div className="small cancel-text">Informe o seu nome.</div>}</label>
        <label className="field"><span>Seu WhatsApp *</span><input className="input" inputMode="tel" autoComplete="tel-national" value={zap} onChange={(e) => setZap(mascaraZap(e.target.value))} placeholder="(11) 91234-5678" />
          {tentou && !zapOk && <div className="small cancel-text">Informe o WhatsApp com DDD, por exemplo (11) 91234-5678.</div>}
          <div className="small faint">Usado para este pedido e para o restaurante reconhecer você nos próximos. Sem ofertas, a não ser que você marque abaixo.</div></label>
        <Seg value={mode} onChange={setMode} label="Como você quer receber" options={modes.map((m) => ({ value: m, label: MODO_LABEL[m] }))} />
        <label className="field"><span>{mode === 'ENTREGA' ? 'Endereço / casa *' : 'Onde você está? (opcional)'}</span>
          <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder={mode === 'ENTREGA' ? 'Ex.: casa 123' : 'Ex.: perto da piscina'} maxLength={120} />
          {tentou && mode === 'ENTREGA' && location.trim().length <= 2 && <div className="small cancel-text">Informe o endereço da entrega.</div>}</label>
        <label className="field"><span>Observação</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: sem cebola" maxLength={200} /></label>
        <label className="check small"><input type="checkbox" checked={ofertas} onChange={(e) => setOfertas(e.target.checked)} />
          <span>Aceito receber ofertas e novidades do {restaurante} pelo WhatsApp. Posso pedir para parar quando quiser. (opcional) <a className="pub-link-privacidade" href="/privacidade" target="_blank" rel="noreferrer">Como usamos seus dados</a></span></label>
        <label className="check small"><input type="checkbox" checked={lembrar} onChange={(e) => setLembrar(e.target.checked)} />
          <span>Lembrar meus dados neste aparelho <span className="faint">(não marque em aparelho compartilhado)</span></span></label>
        {err && <div className="cancel-text" role="alert">{err}</div>}
      </div>
    </Modal>
  );
}
