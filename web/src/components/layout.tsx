import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth';
import { useRealtime } from '../realtime';
import { api } from '../api';
import { ROLE_LABEL } from '../format';
import type { Settings } from '../types';
import { Modal, useAction } from './ui';
import { isMuted, onMuteChange, setMuted } from '../sound';
import { BrandLogo } from './brand';

export function Logo({ to = '/' }: { to?: string }) {
  return <Link to={to} aria-label="Início" className="logo-link"><BrandLogo className="logo" height={40} /></Link>;
}

export function Banners() {
  const { connected } = useRealtime();
  const { meta } = useAuth();
  return <>
    {!connected && <div className="banner offline">⚠ Sem conexão com o servidor — reconectando… Se demorar, use o papel.</div>}
    {meta?.demoMode && <div className="banner demo">MODO DEMONSTRAÇÃO — dados de teste, nada aqui é real</div>}
  </>;
}

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/api/settings'), staleTime: 30_000 });
}

export function StatusChips() {
  const { data } = useSettings();
  if (!data) return null;
  return (
    <div className="row hide-mobile" style={{ gap: 14 }}>
      <span className={`est-chip ${data.restaurant.isOpen ? 'open' : 'closed'}`}><span className={`dot ${data.restaurant.isOpen ? 'ok' : 'danger'}`} />{data.restaurant.isOpen ? 'ABERTO' : 'FECHADO'}</span>
    </div>
  );
}

/** Estado único do estabelecimento (tempo real). Caixa e admin podem pausar/reabrir. */
export function EstablishmentChip({ hasRegister }: { hasRegister: boolean }) {
  const { data } = useSettings();
  const { busy, run } = useAction();
  const [ask, setAsk] = useState(false);
  if (!data) return null;
  const open = data.restaurant.isOpen;
  return <>
    <button className={`est-chip btnlike ${open ? 'open' : 'closed'}`} onClick={() => setAsk(true)} title="Pausar ou reabrir pedidos">
      <span className={`dot ${open ? 'ok' : 'danger'}`} />{open ? 'ABERTO' : 'FECHADO'}
    </button>
    {ask && (
      <Modal title={open ? 'Pausar pedidos?' : 'Reabrir pedidos?'} onClose={() => setAsk(false)} footer={<>
        <button className="btn" onClick={() => setAsk(false)}>Voltar</button>
        <button className={`btn ${open ? 'danger solid' : 'go'}`} disabled={busy || (!open && !hasRegister)} onClick={async () => {
          if (await run(() => api.post('/api/day/establishment', { isOpen: !open }), open ? 'Pedidos pausados: estabelecimento FECHADO.' : 'Pedidos reabertos: estabelecimento ABERTO.')) setAsk(false);
        }}>{open ? 'Fechar para novos pedidos' : 'Reabrir pedidos'}</button>
      </>}>
        {open
          ? <p className="muted">Enquanto estiver <b>FECHADO</b>, ninguém lança pedido novo (nem pelo QR Code). Continua possível consultar contas e <b>receber pagamentos</b>. Todos os aparelhos veem a mudança na hora.</p>
          : hasRegister
            ? <p className="muted">O estabelecimento volta a aceitar pedidos. Todos os aparelhos veem a mudança na hora.</p>
            : <p className="muted">O dia não está aberto. Use <b>“Abrir o dia”</b> no caixa (informa o dinheiro da gaveta e já abre o estabelecimento).</p>}
      </Modal>
    )}
  </>;
}

export function SoundToggle() {
  const [m, setM] = useState(isMuted());
  useEffect(() => onMuteChange(setM), []);
  return <button className="btn icon ghost" title={m ? 'Som desligado — toque para ligar' : 'Som ligado — toque para silenciar'} aria-label="Som dos alertas" aria-pressed={!m} onClick={() => setMuted(!m)}>{m ? '🔇' : '🔔'}</button>;
}

/** Rodapé do produto: logotipo ONE UP Comanda + versão (desenvolvido pela ONE UP). */
export function OneUpCredit({ version }: { version?: string }) {
  return (
    <div className="oneup" aria-label="ONE UP Comanda — desenvolvido pela ONE UP">
      <img className="product-mark-img" src="/comanda-logo-sm.webp" alt="ONE UP Comanda" />
      <span className="faint small">{version ? `v${version} · ` : ''}desenvolvido pela ONE UP</span>
    </div>
  );
}

export function UserMenu() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState(false);
  if (!user) return null;
  return (
    <div className="user-chip">
      <div className="hide-mobile right" style={{ lineHeight: 1.15 }}>
        <div style={{ fontWeight: 700 }}>{user.name}</div>
        <div className="small muted">{user.oneup ? 'ONE UP · suporte' : ROLE_LABEL[user.role]}</div>
      </div>
      <div style={{ position: 'relative' }}>
        <button className="btn icon" onClick={() => setOpen((o) => !o)} aria-label="Menu do usuário">☰</button>
        {open && (
          <div className="card tight col" style={{ position: 'absolute', right: 0, top: 50, width: 220, zIndex: 50, boxShadow: 'var(--shadow)' }} onMouseLeave={() => setOpen(false)}>
            {user.role === 'ADMIN' && <>
              <Link className="btn block" to="/admin" onClick={() => setOpen(false)}>Painel admin</Link>
              <Link className="btn block" to="/caixa" onClick={() => setOpen(false)}>Operar caixa</Link>
              <Link className="btn block" to="/cozinha" onClick={() => setOpen(false)}>Tela da cozinha</Link>
            </>}
            {user.role !== 'ADMIN' && <button className="btn primary block" onClick={async () => { await logout(); nav('/login'); }}>Trocar de pessoa</button>}
            <button className="btn block" onClick={() => { setPw(true); setOpen(false); }}>Trocar senha</button>
            <button className="btn danger block" onClick={async () => { await logout(); nav('/login'); }}>Sair</button>
          </div>
        )}
      </div>
      {pw && <PasswordModal onClose={() => setPw(false)} />}
    </div>
  );
}

function PasswordModal({ onClose }: { onClose: () => void }) {
  const [cur, setCur] = useState(''); const [next, setNext] = useState('');
  const { busy, run } = useAction();
  return (
    <Modal title="Trocar minha senha" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary" disabled={busy || next.length < 4} onClick={async () => {
        if (await run(() => api.post('/api/auth/password', { current: cur, next }), 'Senha alterada.')) onClose();
      }}>Salvar</button>
    </>}>
      <div className="col gap-lg">
        <label className="field"><span>Senha atual</span><input className="input" type="password" value={cur} onChange={(e) => setCur(e.target.value)} /></label>
        <label className="field"><span>Nova senha (mín. 4)</span><input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} /></label>
      </div>
    </Modal>
  );
}

/**
 * Abas do topo (caixa). No celular elas não cabem: rolam para o lado, com esmaecido e seta na borda mostrando que há
 * mais abas; a aba aberta é trazida para a vista.
 */
export function TopNav({ items, label = 'Navegação' }: { items: { to: string; label: ReactNode; end?: boolean }[]; label?: string }) {
  const ref = useRef<HTMLElement>(null);
  const [mais, setMais] = useState({ esq: false, dir: false });
  const loc = useLocation();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const medir = () => {
      const esq = el.scrollLeft > 2;
      const dir = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
      setMais((m) => (m.esq === esq && m.dir === dir ? m : { esq, dir }));
    };
    medir();
    el.addEventListener('scroll', medir, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(medir) : null;
    ro?.observe(el);
    window.addEventListener('resize', medir);
    return () => { el.removeEventListener('scroll', medir); ro?.disconnect(); window.removeEventListener('resize', medir); };
  }, [items.length]);
  useEffect(() => {
    const ativo = ref.current?.querySelector<HTMLElement>('a.active');
    if (ativo && ref.current && ref.current.scrollWidth > ref.current.clientWidth) ativo.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [loc.pathname]);
  const rolar = (lado: 1 | -1) => ref.current?.scrollBy({ left: lado * Math.max(120, ref.current.clientWidth * 0.7), behavior: 'smooth' });
  return (
    <div className={`topnav-wrap${mais.esq ? ' mais-esq' : ''}${mais.dir ? ' mais-dir' : ''}`}>
      <button type="button" className="topnav-seta esq" aria-hidden="true" tabIndex={-1} onClick={() => rolar(-1)}>‹</button>
      <nav className="topnav" ref={ref} aria-label={label}>
        {items.map((i) => <NavLink key={i.to} to={i.to} end={i.end}>{i.label}</NavLink>)}
      </nav>
      <button type="button" className="topnav-seta dir" aria-hidden="true" tabIndex={-1} onClick={() => rolar(1)}>›</button>
    </div>
  );
}
