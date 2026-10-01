import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { homeFor, useAuth } from '../auth';
import { OneUpCredit } from '../components/layout';
import { BrandLogo } from '../components/brand';

const REMEMBER_KEY = 'ha:lastUser';
const readLast = () => { try { return localStorage.getItem(REMEMBER_KEY) ?? ''; } catch { return ''; } };

export default function Login() {
  const { user, login, meta } = useAuth();
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
          {error && <div className="login-error">{error}</div>}
          <button className="btn primary lg block" disabled={busy || !username || !password}>{busy ? 'Entrando…' : 'Entrar'}</button>
          {!remember && <div className="small faint center">Sem “lembrar”, o acesso expira ao fechar o navegador ou em até 14 horas.</div>}
        </form>
        <OneUpCredit version={meta?.version} />
      </section>
    </div>
  );
}
