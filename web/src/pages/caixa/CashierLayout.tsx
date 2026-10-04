import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { brl, minutesSince } from '../../format';
import { useRealtimeEvent } from '../../realtime';
import { isAudioUnlocked, onAudioUnlock, playAlert, playNew, playReady, unlockAudio } from '../../sound';
import type { Board } from '../../types';
import { Banners, EstablishmentChip, Logo, SoundToggle, TopNav, UserMenu } from '../../components/layout';
import { Modal, ReasonModal, useAction, useToast } from '../../components/ui';
import { useStockGuard } from '../../components/stock';
import { usePageTitle } from '../../components/brand';
import { useMesaLabel } from '../../components/brand';
import '../../styles/caixa.css';

export function useBoard() {
  return useQuery({ queryKey: ['board'], queryFn: () => api.get<Board>('/api/cashier/board'), refetchInterval: 20_000 });
}

function useSoundUnlocked() {
  const [on, setOn] = useState(isAudioUnlocked());
  useEffect(() => {
    const off = onAudioUnlock(setOn);
    // qualquer toque/clique na tela libera o som (regra dos navegadores)
    const first = () => { unlockAudio(); };
    window.addEventListener('pointerdown', first, { once: true });
    return () => { off(); window.removeEventListener('pointerdown', first); };
  }, []);
  return on;
}

export default function CashierLayout() {
  const { data } = useBoard();
  const soundOn = useSoundUnlocked();
  const toast = useToast();
  const qc = useQueryClient();
  const [flash, setFlash] = useState<number[]>([]);
  const titleTimer = useRef<number | undefined>(undefined);

  const baseTitle = usePageTitle('Caixa');
  const blinkTitle = (text: string) => {
    window.clearInterval(titleTimer.current);
    let n = 0;
    titleTimer.current = window.setInterval(() => {
      document.title = n % 2 === 0 ? text : baseTitle;
      if (++n > 12) { window.clearInterval(titleTimer.current); document.title = baseTitle; }
    }, 800);
  };
  useEffect(() => () => window.clearInterval(titleTimer.current), []);

  // Som também pela LISTA: pedido pronto ou pedido do QR que chegou durante uma queda do Wi-Fi não passa calado
  const vistos = useRef<{ prontos: Set<number>; qr: Set<number> } | null>(null);
  const avisadosPorEvento = useRef(new Set<number>());
  useEffect(() => {
    if (!data) return;
    const prontos = new Set(data.ready.filter((r) => r.status === 'READY').map((r) => r.orderId));
    const qr = new Set(data.awaiting.map((o) => o.orderId));
    const antes = vistos.current;
    vistos.current = { prontos, qr };
    if (!antes) return;
    const novosProntos = [...prontos].filter((id) => !antes.prontos.has(id) && !avisadosPorEvento.current.has(id));
    if (novosProntos.length) { playReady(); setFlash((f) => [...f, ...novosProntos]); setTimeout(() => setFlash((f) => f.filter((x) => !novosProntos.includes(x))), 12_000); }
    if ([...qr].some((id) => !antes.qr.has(id))) playNew();
  }, [data]);
  // pedido do QR esperando há mais de 3 min: lembra com som a cada minuto
  useEffect(() => {
    const t = setInterval(() => {
      if (data?.awaiting.some((o) => minutesSince(o.createdAt) >= 3)) playNew();
    }, 60_000);
    return () => clearInterval(t);
  }, [data]);

  useRealtimeEvent((ev, p) => {
    if (ev === 'order:ready') {
      avisadosPorEvento.current.add(p.orderId);
      if (avisadosPorEvento.current.size > 500) avisadosPorEvento.current.clear();
      playReady();
      setFlash((f) => [...f, p.orderId]);
      setTimeout(() => setFlash((f) => f.filter((x) => x !== p.orderId)), 12_000);
      blinkTitle(`🔔 PEDIDO #${p.orderNumber} PRONTO`);
      qc.invalidateQueries({ queryKey: ['board'] });
    }
    if (ev === 'order:problem') {
      playAlert();
      toast(`⚠ Cozinha: problema no pedido #${p.orderNumber} — ${p.problemNote}`, 'danger');
      blinkTitle(`⚠ PROBLEMA NO PEDIDO #${p.orderNumber}`);
    }
    if (ev === 'qr:new') {
      toast(`📱 Novo pedido pelo QR Code: #${p.orderNumber}. Confirme para enviar à cozinha.`, 'info');
    }
  });

  return (
    <div className="app">
      <Banners />
      {!soundOn && <div className="banner sound" role="button" tabIndex={0} onClick={() => unlockAudio()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') unlockAudio(); }}>🔇 Toque aqui para ativar o som dos alertas de pedido pronto</div>}
      <header className="topbar">
        <Logo to="/caixa" />
        <TopNav label="Abas do caixa" items={[
          { to: '/caixa', label: 'Contas', end: true },
          { to: '/caixa/pedidos', label: 'Pedidos do dia' },
          { to: '/caixa/receber', label: 'A receber' },
          { to: '/caixa/estoque', label: 'Estoque' },
          { to: '/caixa/disponibilidade', label: 'Acabou?' },
          { to: '/caixa/registro', label: <>Dia / Caixa {data && !data.register && <span className="count">fechado</span>}</> },
        ]} />
        <EstablishmentChip hasRegister={!!data?.register} />
        <SoundToggle />
        <UserMenu />
      </header>
      {data && <AlertBar board={data} flash={flash} />}
      <main className="page"><Outlet /></main>
    </div>
  );
}

/** Quantas colunas a barra tem nesta largura (a barra mostra no máximo 2 linhas). */
function useColunas() {
  const calc = () => (typeof window === 'undefined' ? 3 : window.innerWidth >= 1100 ? 3 : window.innerWidth >= 700 ? 2 : 1);
  const [n, setN] = useState(calc);
  useEffect(() => { const f = () => setN(calc()); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);
  return n;
}

type Aviso =
  | { tipo: 'problema'; r: Board['ready'][number] }
  | { tipo: 'qr'; o: Board['awaiting'][number] }
  | { tipo: 'pronto'; r: Board['ready'][number] };

function AlertBar({ board, flash }: { board: Board; flash: number[] }) {
  const mesa = useMesaLabel();
  const { run } = useAction();
  const { guard, modal } = useStockGuard();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const colunas = useColunas();
  const [gaveta, setGaveta] = useState(false);
  const [reject, setReject] = useState<number | null>(null);
  // botão fica travado enquanto envia (dois toques não geram aviso de erro falso)
  const [enviando, setEnviando] = useState<Set<string>>(new Set());
  const acao = async (k: string, fn: () => Promise<unknown>) => {
    if (enviando.has(k)) return;
    setEnviando((s) => new Set(s).add(k));
    try { await fn(); } finally { setEnviando((s) => { const n = new Set(s); n.delete(k); return n; }); }
  };
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(t); }, []);

  const ready = board.ready.filter((r) => r.status === 'READY');
  // problema de dia anterior não volta para a barra (aparece no "Encerrar o dia")
  const problems = board.ready.filter((r) => r.problemNote && !r.anterior);
  // ordem: problema, QR esperando, pronto (o mais antigo primeiro)
  const avisos: Aviso[] = [
    ...problems.map((r) => ({ tipo: 'problema' as const, r })),
    ...board.awaiting.map((o) => ({ tipo: 'qr' as const, o })),
    ...ready.map((r) => ({ tipo: 'pronto' as const, r })),
  ];
  useEffect(() => { if (!avisos.length) setGaveta(false); }, [avisos.length]);
  if (!avisos.length) return null;

  const onde = (r: { tableLabel: string | null; customerName: string | null; accountNumber: number }) =>
    r.tableLabel ? `${mesa} ${r.tableLabel}` : r.customerName ? r.customerName : `Conta #${r.accountNumber}`;
  const resumo = [
    ready.length ? `${ready.length} ${ready.length === 1 ? 'pronto' : 'prontos'}` : null,
    problems.length ? `${problems.length} ${problems.length === 1 ? 'problema' : 'problemas'}` : null,
    board.awaiting.length ? `${board.awaiting.length} do QR` : null,
  ].filter(Boolean).join(' · ');

  const card = (a: Aviso, naGaveta = false) => {
    if (a.tipo === 'problema') {
      const r = a.r;
      return (
        <div key={`p${r.orderId}`} className="alert-card problem cx-alert">
          <div className="grow">
            <div className="alert-title">⚠ PROBLEMA · {onde(r)}</div>
            <div className="alert-sub cx-alert-itens">Pedido #{r.orderNumber} · conta #{r.accountNumber} — “{r.problemNote}”</div>
          </div>
          <div className="cx-alert-acoes">
            <Link className="btn ghost" to={`/caixa/conta/${r.accountId}`} onClick={() => setGaveta(false)}>Ver conta</Link>
            <button className="btn" disabled={enviando.has(`p${r.orderId}`)} onClick={() => acao(`p${r.orderId}`, () => run(() => api.post(`/api/orders/${r.orderId}/clear-problem`)))}>Resolvido</button>
          </div>
        </div>
      );
    }
    if (a.tipo === 'qr') {
      const o = a.o;
      return (
        <div key={`q${o.orderId}`} className="alert-card qr cx-alert">
          <div className="grow">
            <div className="alert-title">📱 QR · #{o.orderNumber} · {brl(o.totalCents)}
              <span className={minutesSince(o.createdAt) >= 3 ? 'alert-age late' : 'alert-age'}> · {minutesSince(o.createdAt)} min</span></div>
            <div className="alert-sub cx-alert-itens">{o.customerName ?? 'Cliente sem nome'}{o.accountNote ? ` · ${o.accountNote}` : ''}{o.note ? ` · “${o.note}”` : ''}</div>
          </div>
          <div className="cx-alert-acoes">
            <Link className="btn ghost" to={`/caixa/conta/${o.accountId}`} onClick={() => setGaveta(false)}>Itens</Link>
            <button className="btn danger" onClick={() => setReject(o.orderId)}>Recusar</button>
            <button className="btn go" disabled={enviando.has(`q${o.orderId}`)} onClick={() => acao(`q${o.orderId}`, () => guard((stockDecisions) => api.post(`/api/orders/${o.orderId}/confirm`, { stockDecisions }, true), 'Pedido confirmado e enviado à cozinha.'))}>Confirmar</button>
          </div>
        </div>
      );
    }
    const r = a.r;
    return (
      <div key={r.orderId} className={`alert-card ready cx-alert${flash.includes(r.orderId) && !naGaveta ? ' flash' : ''}`}>
        <div className="grow">
          <div className="alert-title">🔔 {onde(r)} · #{r.orderNumber}
            {r.readyAt && <span className="alert-age"> · {minutesSince(r.readyAt)} min</span>}</div>
          <div className="alert-sub cx-alert-itens">
            {r.consumptionType === 'VIAGEM' && <b className="viagem-tag">VIAGEM</b>}
            {r.itemsText || 'Pedido pronto'}
            {r.tableLabel && r.customerName ? <span className="muted"> · {r.customerName}</span> : null}
            {r.sequence > 1 ? <span className="muted"> · complemento</span> : null}
            {r.note ? <span className="muted"> · {r.note}</span> : null}
          </div>
        </div>
        <div className="cx-alert-acoes">
          <button className="btn ghost" onClick={() => { setGaveta(false); nav(`/caixa/conta/${r.accountId}`); }}>Conta</button>
          <button className="btn go" disabled={enviando.has(`e${r.orderId}`)} onClick={() => acao(`e${r.orderId}`, () => run(() => api.post(`/api/orders/${r.orderId}/deliver`)))}>✓ Entregue</button>
        </div>
      </div>
    );
  };

  // Na "Nova conta" a barra fica recolhida (uma linha) para não empurrar o cardápio
  const recolhida = pathname.startsWith('/caixa/nova');
  const limite = colunas * 2; // no máximo 2 linhas
  const cabem = avisos.length <= limite ? avisos : avisos.slice(0, limite - 1);
  const sobram = avisos.length - cabem.length;

  return (
    <>
      {recolhida ? (
        <div className="cx-alertbar-min">
          <button className={`btn cx-alertbar-min-btn${problems.length ? ' problem' : ready.length ? ' ready' : ' qr'}`} onClick={() => setGaveta(true)} aria-haspopup="dialog">
            <span className="grow">{problems.length ? '⚠' : ready.length ? '🔔' : '📱'} {resumo}</span><span className="cx-ver">ver ›</span>
          </button>
        </div>
      ) : (
        <div className="alertbar cx-alertbar" style={{ gridTemplateColumns: `repeat(${colunas}, minmax(0, 1fr))` }}>
          {cabem.map((a) => card(a))}
          {sobram > 0 && (
            <button className="cx-alert-mais" onClick={() => setGaveta(true)} aria-haspopup="dialog">
              <b className="num">{ready.length} {ready.length === 1 ? 'pronto' : 'prontos'}</b>
              <span>+{sobram} {sobram === 1 ? 'aviso' : 'avisos'} · ver todos</span>
            </button>
          )}
        </div>
      )}
      {gaveta && (
        <Modal wide title={`Prontos e avisos · ${resumo}`} onClose={() => setGaveta(false)}>
          <div className="cx-gaveta">{avisos.map((a) => card(a, true))}</div>
        </Modal>
      )}
      {modal}
      {reject && <RecusarPedido orderId={reject} onClose={() => setReject(null)} onDone={() => setReject(null)} />}
    </>
  );
}

/** O cliente vê só o motivo da lista; o que o caixa escreve fica interno. */
const MOTIVOS_CLIENTE = [
  ['FALTA', 'Produto em falta'], ['FECHANDO', 'Cozinha encerrando'], ['DUPLICADO', 'Pedido em duplicidade'], ['BALCAO', 'Fale com o balcão'],
] as const;
function RecusarPedido({ orderId, onClose, onDone }: { orderId: number; onClose: () => void; onDone: () => void }) {
  const [motivo, setMotivo] = useState<(typeof MOTIVOS_CLIENTE)[number][0] | null>(null);
  const [nota, setNota] = useState('');
  const { busy, run } = useAction();
  const rotulo = MOTIVOS_CLIENTE.find(([v]) => v === motivo)?.[1] ?? '';
  return (
    <Modal title="Recusar pedido do cardápio digital" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn danger solid" disabled={!motivo || busy} onClick={async () => {
        if (await run(() => api.post(`/api/orders/${orderId}/cancel`, { reason: nota.trim().length >= 3 ? `${rotulo} — ${nota.trim()}` : rotulo, motivoCliente: motivo, returnStock: false }), 'Pedido recusado.')) onDone();
      }}>Recusar pedido</button>
    </>}>
      <div className="col gap-lg">
        <div className="field"><span>Motivo que o cliente vai ver *</span>
          <div className="seg wrap">{MOTIVOS_CLIENTE.map(([v, r]) => <button key={v} className={motivo === v ? 'on' : ''} onClick={() => setMotivo(v)}>{r}</button>)}</div></div>
        <label className="field"><span>Observação interna (opcional — o cliente NÃO vê)</span><input className="input" value={nota} onChange={(e) => setNota(e.target.value)} maxLength={180} placeholder="Ex.: acabou a batata às 21h" /></label>
      </div>
    </Modal>
  );
}
