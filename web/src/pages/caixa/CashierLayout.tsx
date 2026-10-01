import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { brl, minutesSince } from '../../format';
import { useRealtimeEvent } from '../../realtime';
import { isAudioUnlocked, onAudioUnlock, playAlert, playNew, playReady, unlockAudio } from '../../sound';
import type { Board } from '../../types';
import { Banners, EstablishmentChip, Logo, SoundToggle, TopNav, UserMenu } from '../../components/layout';
import { ReasonModal, useAction, useToast } from '../../components/ui';
import { useStockGuard } from '../../components/stock';
import { usePageTitle } from '../../components/brand';
import { useMesaLabel } from '../../components/brand';

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

  useRealtimeEvent((ev, p) => {
    if (ev === 'order:ready') {
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
      playNew();
      toast(`📱 Novo pedido pelo QR Code: #${p.orderNumber}. Confirme para enviar à cozinha.`, 'info');
    }
  });

  return (
    <div className="app">
      <Banners />
      {!soundOn && <div className="banner sound" onClick={() => unlockAudio()}>🔇 Toque aqui para ativar o som dos alertas de pedido pronto</div>}
      <header className="topbar">
        <Logo to="/caixa" />
        <TopNav items={[
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

function AlertBar({ board, flash }: { board: Board; flash: number[] }) {
  const mesa = useMesaLabel();
  const { run } = useAction();
  const { guard, modal } = useStockGuard();
  const nav = useNavigate();
  const [reject, setReject] = useState<number | null>(null);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(t); }, []);

  const ready = board.ready.filter((r) => r.status === 'READY');
  const problems = board.ready.filter((r) => r.problemNote);
  if (!ready.length && !problems.length && !board.awaiting.length) return null;

  return (
    <div className="alertbar">
      {problems.map((r) => (
        <div key={`p${r.orderId}`} className="alert-card problem">
          <div className="grow">
            <div className="alert-title">⚠ PROBLEMA · PEDIDO #{r.orderNumber}</div>
            <div className="alert-sub">Conta #{r.accountNumber}{r.customerName ? ` · ${r.customerName}` : ''} — “{r.problemNote}”</div>
          </div>
          <Link className="btn sm" to={`/caixa/conta/${r.accountId}`}>Ver conta</Link>
          <button className="btn sm" onClick={() => run(() => api.post(`/api/orders/${r.orderId}/clear-problem`))}>Resolvido</button>
        </div>
      ))}
      {ready.map((r) => (
        <div key={r.orderId} className={`alert-card ready${flash.includes(r.orderId) ? ' flash' : ''}`}>
          <div className="alert-bell">🔔</div>
          <div className="grow">
            <div className="alert-title">PEDIDO #{r.orderNumber} PRONTO</div>
            <div className="alert-sub">
              {r.consumptionType === 'VIAGEM' && <b className="viagem-tag">VIAGEM</b>}
              Conta #{r.accountNumber}{r.tableLabel ? ` · ${mesa} ${r.tableLabel}` : ''}{r.sequence > 1 ? ' · complemento' : ''}
              {r.customerName ? ` · ${r.customerName}` : ''}{r.note ? ` · ${r.note}` : ''}
              {r.readyAt && <span className="alert-age"> · há {minutesSince(r.readyAt)} min</span>}
            </div>
          </div>
          <button className="btn sm ghost" onClick={() => nav(`/caixa/conta/${r.accountId}`)}>Conta</button>
          <button className="btn go" onClick={() => run(() => api.post(`/api/orders/${r.orderId}/deliver`))}>✓ Entregue</button>
        </div>
      ))}
      {board.awaiting.map((o) => (
        <div key={`q${o.orderId}`} className="alert-card qr">
          <div className="alert-bell">📱</div>
          <div className="grow">
            <div className="alert-title">QR CODE · PEDIDO #{o.orderNumber} · {brl(o.totalCents)}</div>
            <div className="alert-sub">{o.customerName ?? 'Cliente sem nome'}{o.accountNote ? ` · ${o.accountNote}` : ''}{o.note ? ` · “${o.note}”` : ''}</div>
          </div>
          <Link className="btn sm ghost" to={`/caixa/conta/${o.accountId}`}>Ver itens</Link>
          <button className="btn sm danger" onClick={() => setReject(o.orderId)}>Recusar</button>
          <button className="btn go" onClick={() => guard((stockDecisions) => api.post(`/api/orders/${o.orderId}/confirm`, { stockDecisions }, true), 'Pedido confirmado e enviado à cozinha.')}>Confirmar</button>
        </div>
      ))}
      {modal}
      {reject && (
        <ReasonModal title="Recusar pedido do QR Code" confirmLabel="Recusar pedido" danger
          suggestions={['Produto em falta', 'Pedido duplicado', 'Cliente não encontrado']}
          onClose={() => setReject(null)}
          onConfirm={(reason) => run(() => api.post(`/api/orders/${reject}/cancel`, { reason }), 'Pedido recusado.')} />
      )}
    </div>
  );
}
