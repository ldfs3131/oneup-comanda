import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { homeFor, useAuth } from '../auth';

export default function Login() {
  const { user, login, meta } = useAuth();
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={homeFor(user.role)} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const u = await login(username, password);
      const from = loc.state?.from;
      nav(from && from !== '/login' ? from : homeFor(u.role), { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="login-page">
      {meta?.demoMode && <div className="banner demo" style={{ position: 'fixed', top: 0, left: 0, right: 0 }}>MODO DEMONSTRAÇÃO — logins admin / caixa / cozinha, senha 1234</div>}
      <form className="login-card" onSubmit={submit}>
        <img src="/logo.png" alt="Happy Alpha" className="login-logo" />
        <label className="field">
          <span>Usuário</span>
          <input className="input" autoFocus autoCapitalize="none" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="field">
          <span>Senha</span>
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="login-error">{error}</div>}
        <button className="btn primary lg block" disabled={busy || !username || !password}>{busy ? 'Entrando…' : 'Entrar'}</button>
      </form>
    </div>
  );
}
