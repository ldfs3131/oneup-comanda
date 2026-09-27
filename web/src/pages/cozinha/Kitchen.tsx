import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { minutesSince, time } from '../../format';
import { useRealtimeEvent } from '../../realtime';
import { playAlert, playNew, unlockAudio } from '../../sound';
import { Banners, UserMenu } from '../../components/layout';
import { Modal, useAction } from '../../components/ui';

type KOrder = {
  id: number; number: number; sequence: number; status: 'CONFIRMED' | 'IN_PREPARATION' | 'READY'; note: string | null; origin: string;
  createdAt: string; confirmedAt: string | null; startedAt: string | null; readyAt: string | null; problemNote: string | null;
  account: { id: number; number: number; customerName: string | null; note: string | null };
  items: { id: number; name: string; quantity: number; options: { name: string }[]; note: string | null; cancelled: boolean }[];
};

const COLS = [
  { key: 'CONFIRMED', title: 'Novos' },
  { key: 'IN_PREPARATION', title: 'Em preparo' },
  { key: 'READY', title: 'Prontos' },
] as const;

export default function Kitchen() {
  const qc = useQueryClient();
  const { data = [] } = useQuery({ queryKey: ['kitchen'], queryFn: () => api.get<KOrder[]>('/api/kitchen/orders'), refetchInterval: 15_000 });
  const [started, setStarted] = useState(false);
  const [tab, setTab] = useState<(typeof COLS)[number]['key']>('CONFIRMED');
  const [alerts, setAlerts] = useState<{ id: number; msg: string }[]>([]);
  const [problem, setProblem] = useState<KOrder | null>(null);
  const [, tick] = useState(0);
  const wake = useRef<any>(null);
  const [clock, setClock] = useState(time(new Date()));

  useEffect(() => {
    document.title = 'Happy Alpha — Cozinha';
    const t = setInterval(() => { tick((x) => x + 1); setClock(time(new Date())); }, 20_000);
    return () => clearInterval(t);
  }, []);

  // Mantém a tela acesa (quando o navegador permite)
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

  return (
    <div className="kitchen">
      <Banners />
      {!started && (
        <div className="k-start" onClick={start}>
          <img src="/logo.png" alt="" style={{ width: 280, maxWidth: '70vw', borderRadius: 10 }} />
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
        <div className="k-clock num">{clock}</div>
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
  const { busy, run } = useAction();
  const qc = useQueryClient();
  const since = o.status === 'READY' ? minutesSince(o.readyAt) : minutesSince(o.confirmedAt ?? o.createdAt);
  const late = o.status !== 'READY' && since >= 25 ? 'late' : o.status !== 'READY' && since >= 15 ? 'warn' : '';
  const go = (action: string) => run(async () => { await api.post(`/api/kitchen/orders/${o.id}/${action}`); qc.invalidateQueries({ queryKey: ['kitchen'] }); });
  const active = o.items.filter((i) => !i.cancelled);

  return (
    <article className={`k-card ${o.status.toLowerCase()} ${late}`}>
      <div className="k-card-head">
        <div>
          <div className="k-order">PEDIDO #{o.number}</div>
          <div className={`k-acc${o.sequence > 1 ? ' comp' : ''}`}>{o.sequence > 1 ? `COMPLEMENTO DA CONTA #${o.account.number}` : `CONTA #${o.account.number}`}</div>
          {(o.account.customerName || o.account.note) && (
            <div className="k-who">{[o.account.customerName, o.account.note].filter(Boolean).join(' · ')}</div>
          )}
        </div>
        <div className="k-time">
          <div className="num">{time(o.confirmedAt ?? o.createdAt)}</div>
          <div className={`k-age num ${late}`}>{o.status === 'READY' ? `pronto há ${since} min` : `${since} min`}</div>
        </div>
      </div>
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
