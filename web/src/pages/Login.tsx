import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { homeFor, useAuth } from '../auth';
import { OneUpCredit } from '../components/layout';
import { BrandLogo } from '../components/brand';
import { BotaoBaixarApp } from '../components/instalar';

const REMEMBER_KEY = 'ha:lastUser';
const readLast = () => { try { return localStorage.getItem(REMEMBER_KEY) ?? ''; } catch { return ''; } };

export default function Login() {
  const { user, login, loginPin, meta } = useAuth();
  // Aparelho da equipe (alguém já entrou aqui com usuário e senha): Caixa e Cozinha entram tocando no nome + PIN
  const { data: pin } = useQuery({ queryKey: ['pin-pessoas'], queryFn: () => api.get<{ aparelho: boolean; pessoas: { id: number; name: string; role: string }[] }>('/api/auth/pin/pessoas'), staleTime: 0 });
  const [modoSenha, setModoSenha] = useState(false);
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const last = readLast();
  const [username, setUsername] = useState(last);
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(true);
  const [forgot, setForgot] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={homeFor(user.role)} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const u = await login(username.trim(), password, remember);
      try { if (remember) localStorage.setItem(REMEMBER_KEY, username.trim()); else localStorage.removeItem(REMEMBER_KEY); } catch { /* sem armazenamento */ }
      const from = loc.state?.from;
      nav(from && from !== '/login' ? from : homeFor(u.role), { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  };

  const usarPin = !modoSenha && !!pin?.aparelho && pin.pessoas.length > 0;

  return (
    <div className="login-split">
      {meta?.demoMode && <div className="banner demo login-demo">MODO DEMONSTRAÇÃO — logins admin / caixa / cozinha, senha 1234</div>}
      <section className="login-brand">
        {meta?.logo && <BrandLogo className="login-brand-logo" height={120} />}
        <div className="login-brand-name">{meta?.restaurantName ?? ''}</div>
        {meta?.tagline ? <div className="login-brand-tag">{meta.tagline}</div> : null}
        <ul className="login-brand-points hide-mobile">
          <li>Pedidos do caixa direto na cozinha</li>
          <li>Conta por cliente, pagamento dividido e pendências</li>
          <li>Estoque e financeiro do dia</li>
        </ul>
      </section>
      <section className="login-form-side">
        {usarPin ? <EntrarComPin pessoas={pin!.pessoas} onSenha={() => setModoSenha(true)} onEntrar={async (id, p) => {
          const u = await loginPin(id, p);
          nav(homeFor(u.role), { replace: true });
        }} /> : <>
        <form className="login-form" onSubmit={submit}>
          <h1>Entrar</h1>
          <p className="muted small" style={{ marginTop: -4 }}>Use o usuário e a senha que o Dono do restaurante criou para você.</p>
          <label className="field">
            <span>Usuário</span>
            <input className="input" autoFocus={!last} autoCapitalize="none" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label className="field">
            <span>Senha</span>
            <div className="pw-wrap">
              <input className="input" type={show ? 'text' : 'password'} autoFocus={!!last} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              <button type="button" className="pw-eye" onClick={() => setShow((s) => !s)} aria-label={show ? 'Esconder senha' : 'Mostrar senha'}>{show ? 'Ocultar' : 'Mostrar'}</button>
            </div>
          </label>
          <div className="row between wrap">
            <label className="check small"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />Lembrar acesso neste aparelho</label>
            <button type="button" className="linkish small" onClick={() => setForgot((f) => !f)}>Esqueci minha senha</button>
          </div>
          {forgot && <div className="info-box small">Peça ao Dono do restaurante para redefinir sua senha em <b>Usuários</b>. Por segurança, o sistema não envia senha por e-mail.</div>}
          {error && <div className="login-error" role="alert">{error}</div>}
          <button className="btn primary lg block" disabled={busy || !username || !password}>{busy ? 'Entrando…' : 'Entrar'}</button>
          {!remember && <div className="small faint center">Sem “lembrar”, o acesso expira ao fechar o navegador ou em até 14 horas.</div>}
          {pin?.aparelho && pin.pessoas.length > 0 && <button type="button" className="btn ghost block" onClick={() => setModoSenha(false)}>Entrar com PIN</button>}
        </form>
        </>}
        <BotaoBaixarApp para="equipe" className="btn ghost" texto="Baixar o app da equipe" />
        <OneUpCredit version={meta?.version} />
      </section>
    </div>
  );
}

const PAPEL: Record<string, string> = { CAIXA: 'Caixa', COZINHA: 'Cozinha' };

/** Toque no seu nome e digite o PIN de 4 números (entra sozinho no 4º número). */
function EntrarComPin({ pessoas, onEntrar, onSenha }: { pessoas: { id: number; name: string; role: string }[]; onEntrar: (id: number, pin: string) => Promise<void>; onSenha: () => void }) {
  const [quem, setQuem] = useState<{ id: number; name: string; role: string } | null>(pessoas.length === 1 ? pessoas[0] : null);
  const [pin, setPin] = useState('');
  const [erro, setErro] = useState('');
  const [busy, setBusy] = useState(false);
  const digitar = (d: string) => { if (!busy) { setErro(''); setPin((p) => (p.length < 4 ? p + d : p)); } };
  useEffect(() => {
    if (pin.length !== 4 || !quem) return;
    setBusy(true);
    onEntrar(quem.id, pin).catch((e) => { setErro((e as Error).message); setPin(''); }).finally(() => setBusy(false));
  }, [pin]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (!quem) return; if (/^\d$/.test(e.key)) digitar(e.key); else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1)); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });
  if (!quem) return (
    <div className="login-form">
      <h1>Quem está entrando?</h1>
      <p className="muted small" style={{ marginTop: -4 }}>Toque no seu nome.</p>
      <div className="pin-pessoas">
        {pessoas.map((p) => (
          <button key={p.id} className="pin-pessoa" onClick={() => { setQuem(p); setPin(''); setErro(''); }}>
            <span className="pin-avatar">{p.name.trim().slice(0, 1).toUpperCase()}</span>
            <span><b>{p.name}</b><span className="small muted">{PAPEL[p.role] ?? p.role}</span></span>
          </button>
        ))}
      </div>
      <button className="btn ghost block" onClick={onSenha}>Entrar com usuário e senha</button>
    </div>
  );
  return (
    <div className="login-form">
      <button className="linkish small" style={{ alignSelf: 'flex-start' }} onClick={() => { setQuem(null); setPin(''); }}>‹ Trocar de pessoa</button>
      <h1>Olá, {quem.name.split(' ')[0]}</h1>
      <p className="muted small" style={{ marginTop: -4 }}>Digite o seu PIN de 4 números.</p>
      <div className={`pin-dots${erro ? ' erro' : ''}`} aria-label={`${pin.length} de 4 números`}>
        {[0, 1, 2, 3].map((i) => <span key={i} className={i < pin.length ? 'on' : ''} />)}
      </div>
      {erro && <div className="login-error" role="alert">{erro}</div>}
      <div className="pin-teclado">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button key={d} disabled={busy} onClick={() => digitar(d)}>{d}</button>)}
        <button className="pin-sec" onClick={() => setPin('')} disabled={busy}>Limpar</button>
        <button disabled={busy} onClick={() => digitar('0')}>0</button>
        <button className="pin-sec" onClick={() => setPin((p) => p.slice(0, -1))} disabled={busy} aria-label="Apagar">⌫</button>
      </div>
      <div className="small faint center">Esqueceu o PIN? Peça ao Dono para trocar em Usuários.</div>
    </div>
  );
}
