import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { minutesSince, time } from '../../format';
import { useRealtimeEvent } from '../../realtime';
import { playAlert, playNew, unlockAudio } from '../../sound';
import { Banners, SoundToggle, UserMenu } from '../../components/layout';
import { Modal, useAction } from '../../components/ui';
import { BrandLogo, useMesaLabel, usePageTitle } from '../../components/brand';
import { useSettings } from '../../components/layout';

type KItem = { id: number; name: string; quantity: number; options: { name: string }[]; note: string | null; cancelled: boolean; isCustom: boolean };
type KOrder = {
  id: number; number: number; sequence: number; status: 'CONFIRMED' | 'IN_PREPARATION' | 'READY'; note: string | null; origin: string;
  consumptionType: 'LOCAL' | 'VIAGEM'; expectedMinutes: number;
  createdAt: string; confirmedAt: string | null; startedAt: string | null; readyAt: string | null; problemNote: string | null;
  account: { id: number; number: number; customerName: string | null; note: string | null; tableLabel: string | null };
  items: KItem[];
  previous: { orderNumber: number; name: string; quantity: number; status: string }[];
};

const COLS = [
  { key: 'CONFIRMED', title: 'Novos' },
  { key: 'IN_PREPARATION', title: 'Em preparo' },
  { key: 'READY', title: 'Prontos' },
] as const;

const PREV_STATUS: Record<string, string> = { CONFIRMED: 'na fila', IN_PREPARATION: 'em preparo', READY: 'pronto', DELIVERED: 'entregue' };
const readPref = (k: string) => { try { return localStorage.getItem(k) === '1'; } catch { return false; } };
const savePref = (k: string, v: boolean) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* ok */ } };

export default function Kitchen() {
  usePageTitle('Cozinha');
  const qc = useQueryClient();
  const { data = [] } = useQuery({ queryKey: ['kitchen'], queryFn: () => api.get<KOrder[]>('/api/kitchen/orders'), refetchInterval: 15_000 });
  const [started, setStarted] = useState(false);
  const [tab, setTab] = useState<(typeof COLS)[number]['key']>('CONFIRMED');
  const [alerts, setAlerts] = useState<{ id: number; msg: string }[]>([]);
  const [problem, setProblem] = useState<KOrder | null>(null);
  const [tv, setTv] = useState(() => readPref('ha:kitchenTv'));
  const [prod, setProd] = useState(() => readPref('ha:kitchenProd'));
  const [, tick] = useState(0);
  const wake = useRef<any>(null);
  const [clock, setClock] = useState(time(new Date()));

  useEffect(() => {
    const t = setInterval(() => { tick((x) => x + 1); setClock(time(new Date())); }, 20_000);
    return () => clearInterval(t);
  }, []);

  const keepAwake = async () => {
    try { wake.current = await (navigator as any).wakeLock?.request('screen'); } catch { /* sem suporte: usar Fully Kiosk */ }
  };
  useEffect(() => {
    const vis = () => { if (document.visibilityState === 'visible' && started) keepAwake(); };
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  }, [started]);

  useRealtimeEvent((ev, p) => {
    if (ev === 'kitchen:new') { playNew(); qc.invalidateQueries({ queryKey: ['kitchen'] }); setTab('CONFIRMED'); }
    if (ev === 'kitchen:cancelled') {
      playAlert();
      setAlerts((a) => [...a, { id: Date.now() + Math.random(), msg: p.message }]);
    }
  });

  const start = async () => {
    await unlockAudio();
    await keepAwake();
    try { await document.documentElement.requestFullscreen?.(); } catch { /* opcional */ }
    setStarted(true);
  };

  const by = (k: string) => data.filter((o) => o.status === k);

  // Resumo de produção: o que precisa sair agora (novos + em preparo), somado
  const production = useMemo(() => {
    const m = new Map<string, { name: string; opts: string; qty: number; oldest: string }>();
    for (const o of data.filter((x) => x.status !== 'READY')) {
      for (const i of o.items.filter((x) => !x.cancelled)) {
        const opts = i.options.map((x) => x.name).join(' · ');
        const k = `${i.name}|${opts}`;
        const cur = m.get(k) ?? { name: i.name, opts, qty: 0, oldest: o.confirmedAt ?? o.createdAt };
        cur.qty += i.quantity;
        m.set(k, cur);
      }
    }
    return [...m.values()].sort((a, b) => b.qty - a.qty);
  }, [data]);

  return (
    <div className={`kitchen${tv ? ' tv' : ''}`}>
      <Banners />
      {!started && (
        <div className="k-start" onClick={start}>
          <BrandLogo height={120} />
          <div className="k-start-btn">TOCAR PARA INICIAR O TURNO</div>
          <div className="muted">Libera o som dos novos pedidos e mantém a tela acesa.</div>
        </div>
      )}
      <header className="k-top">
        <div className="k-title">COZINHA</div>
        <div className="k-counts">
          {COLS.map((c) => (
            <button key={c.key} className={`k-tab${tab === c.key ? ' on' : ''}`} onClick={() => setTab(c.key)}>
              {c.title} <b>{by(c.key).length}</b>
            </button>
          ))}
        </div>
        <button className={`btn sm${prod ? ' primary' : ''}`} onClick={() => { setProd(!prod); savePref('ha:kitchenProd', !prod); }} title="Soma do que precisa sair">Produção</button>
        <button className={`btn sm${tv ? ' primary' : ''}`} onClick={() => { setTv(!tv); savePref('ha:kitchenTv', !tv); }} title="Letras grandes para TV">Modo TV</button>
        <div className="k-clock num">{clock}</div>
        <SoundToggle />
        <UserMenu />
      </header>

      {alerts.length > 0 && (
        <div className="k-alerts">
          {alerts.map((a) => (
            <div key={a.id} className="k-alert">
              <span>✕ {a.msg}</span>
              <button className="btn" onClick={() => setAlerts((l) => l.filter((x) => x.id !== a.id))}>OK, vi</button>
            </div>
          ))}
        </div>
      )}

      {prod && (
        <div className="k-prod">
          <span className="k-prod-title">PRODUÇÃO AGORA</span>
          {!production.length && <span className="muted">nada pendente</span>}
          {production.map((p) => (
            <span key={p.name + p.opts} className="k-prod-item"><b className="num">{p.qty}×</b> {p.name}{p.opts && <span className="muted"> · {p.opts}</span>}</span>
          ))}
        </div>
      )}

      <div className="k-cols">
        {COLS.map((c) => (
          <section key={c.key} className={`k-col${tab === c.key ? ' current' : ''}`}>
            <h2 className="k-col-title">{c.title} <span className="num">{by(c.key).length}</span></h2>
            <div className="k-list">
              {!by(c.key).length && <div className="empty">{c.key === 'CONFIRMED' ? 'Nenhum pedido novo' : c.key === 'IN_PREPARATION' ? 'Nada em preparo' : 'Nenhum pronto aguardando'}</div>}
              {by(c.key).map((o) => <KCard key={o.id} o={o} onProblem={() => setProblem(o)} />)}
            </div>
          </section>
        ))}
      </div>
      {problem && <ProblemModal o={problem} onClose={() => setProblem(null)} />}
    </div>
  );
}

function KCard({ o, onProblem }: { o: KOrder; onProblem: () => void }) {
  const mesa = useMesaLabel();
  const { busy, run } = useAction();
  const qc = useQueryClient();
  const [showPrev, setShowPrev] = useState(false);
  const since = o.status === 'READY' ? minutesSince(o.readyAt) : minutesSince(o.confirmedAt ?? o.createdAt);
  const exp = o.expectedMinutes || 15;
  // limites de cor definidos pelo Dono em Configurações (% do tempo-meta)
  const { data: settings } = useSettings();
  const amarelo = (settings?.config?.cozinha_amarelo_pct ?? 100) / 100;
  const vermelho = (settings?.config?.cozinha_vermelho_pct ?? 150) / 100;
  const late = o.status !== 'READY' && since > exp * vermelho ? 'late' : o.status !== 'READY' && since > exp * amarelo ? 'warn' : '';
  const go = (action: string) => run(async () => { await api.post(`/api/kitchen/orders/${o.id}/${action}`); qc.invalidateQueries({ queryKey: ['kitchen'] }); });
  const active = o.items.filter((i) => !i.cancelled);
  const isComplement = o.sequence > 1;

  return (
    <article className={`k-card ${o.status.toLowerCase()} ${late}${o.consumptionType === 'VIAGEM' ? ' viagem' : ''}`}>
      {o.consumptionType === 'VIAGEM' && <div className="k-viagem">🛍 PARA VIAGEM</div>}
      <div className="k-card-head">
        <div>
          <div className="k-order">PEDIDO #{o.number}</div>
          <div className={`k-acc${isComplement ? ' comp' : ''}`}>
            {isComplement ? `COMPLEMENTO · CONTA #${o.account.number}` : `CONTA #${o.account.number}`}
            {o.account.tableLabel && <span className="k-table">{mesa.toUpperCase()} {o.account.tableLabel}</span>}
          </div>
          {(o.account.customerName || o.account.note) && (
            <div className="k-who">{[o.account.customerName, o.account.note].filter(Boolean).join(' · ')}</div>
          )}
        </div>
        <div className="k-time">
          <div className="num">{time(o.confirmedAt ?? o.createdAt)}</div>
          <div className={`k-age num ${late}`}>{o.status === 'READY' ? `pronto há ${since} min` : `${since} / ${exp} min`}</div>
        </div>
      </div>
      {isComplement && <div className="k-new-label">🆕 NOVO ITEM — preparar só isto</div>}
      <ul className="k-items">
        {o.items.map((i) => (
          <li key={i.id} className={i.cancelled ? 'cancelled' : ''}>
            <span className="k-qty num">{i.quantity}×</span>
            <div>
              <div className="k-name">{i.name}{i.cancelled && <span className="k-cancel-tag">CANCELADO</span>}</div>
              {i.options.length > 0 && <div className="k-opts">{i.options.map((x) => x.name).join(' · ')}</div>}
              {i.note && <div className="k-note">⚠ {i.note}</div>}
            </div>
          </li>
        ))}
      </ul>
      {o.note && <div className="k-order-note">Obs.: {o.note}</div>}
      {isComplement && o.previous.length > 0 && (
        <div className="k-prev">
          <button className="k-prev-toggle" onClick={() => setShowPrev((s) => !s)}>✓ Itens anteriores desta conta ({o.previous.reduce((s, p) => s + p.quantity, 0)}) — só referência {showPrev ? '▲' : '▼'}</button>
          {showPrev && (
            <ul>
              {o.previous.map((p, k) => <li key={k}><span className="num">{p.quantity}×</span> {p.name} <span className="faint">· #{p.orderNumber} {PREV_STATUS[p.status] ?? ''}</span></li>)}
            </ul>
          )}
        </div>
      )}
      {o.problemNote && <div className="k-problem">Problema enviado ao caixa: “{o.problemNote}”</div>}
      <div className="k-actions">
        {o.status === 'CONFIRMED' && <button className="btn xl block primary" disabled={busy || !active.length} onClick={() => go('start')}>INICIAR PREPARO</button>}
        {o.status === 'IN_PREPARATION' && <button className="btn xl block go" disabled={busy || !active.length} onClick={() => go('ready')}>PEDIDO PRONTO</button>}
        {o.status === 'READY' && <button className="btn block" disabled={busy} onClick={() => go('back')}>↩ Voltar para preparo</button>}
        {o.status !== 'READY' && (
          <div className="row" style={{ gap: 8 }}>
            {o.status === 'CONFIRMED' && <button className="btn grow" disabled={busy || !active.length} onClick={() => go('ready')}>Já está pronto</button>}
            <button className="btn grow" onClick={onProblem}>⚠ Problema</button>
          </div>
        )}
      </div>
    </article>
  );
}

function ProblemModal({ o, onClose }: { o: KOrder; onClose: () => void }) {
  const [note, setNote] = useState('');
  const { busy, run } = useAction();
  const send = async () => {
    if (note.trim().length < 2) return;
    if (await run(() => api.post(`/api/kitchen/orders/${o.id}/problem`, { note: note.trim() }), 'Aviso enviado ao caixa.')) onClose();
  };
  return (
    <Modal title={`Problema no pedido #${o.number}`} onClose={onClose} footer={<>
      <button className="btn lg" onClick={onClose}>Voltar</button>
      <button className="btn danger solid lg" disabled={busy || note.trim().length < 2} onClick={send}>Avisar o caixa</button>
    </>}>
      <div className="col gap-lg">
        <div className="opt-grid">
          {['Acabou um item', 'Vai demorar mais', 'Dúvida no pedido', 'Pedido duplicado?'].map((s) => (
            <button key={s} className={`opt-btn${note === s ? ' on' : ''}`} onClick={() => setNote(s)}>{s}</button>
          ))}
        </div>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Descreva (ex.: acabou o coração)" maxLength={200} />
      </div>
    </Modal>
  );
}
