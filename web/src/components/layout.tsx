import { useState, type ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth';
import { useRealtime } from '../realtime';
import { api } from '../api';
import { ROLE_LABEL } from '../format';
import type { Settings } from '../types';
import { Modal, useAction } from './ui';

export function Logo({ to = '/' }: { to?: string }) {
  return <Link to={to} aria-label="Início"><img className="logo" src="/logo.png" alt="Happy Alpha" /></Link>;
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
      <span className="status-chip"><span className={`dot ${data.restaurant.isOpen ? 'ok' : 'danger'}`} />Restaurante {data.restaurant.isOpen ? 'aberto' : 'fechado'}</span>
      <span className="status-chip"><span className={`dot ${data.delivery.isOpen ? 'ok' : 'danger'}`} />Delivery {data.delivery.isOpen ? 'aberto' : 'fechado'}</span>
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
        <div className="small muted">{ROLE_LABEL[user.role]}</div>
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

export function TopNav({ items }: { items: { to: string; label: ReactNode; end?: boolean }[] }) {
  return (
    <nav className="topnav">
      {items.map((i) => <NavLink key={i.to} to={i.to} end={i.end}>{i.label}</NavLink>)}
    </nav>
  );
}
