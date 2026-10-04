import { useEffect, useRef, useState } from 'react';
import { api, registrarAutorizacaoDono } from '../api';
import { useAuth } from '../auth';
import { Modal } from './ui';

/** Janela "Autorização do Dono": aparece quando o caixa tenta algo que só o Dono faz. A sessão do caixa não muda. */
export function AutorizacaoDono() {
  const { user } = useAuth();
  const [pedido, setPedido] = useState<{ motivo: string } | null>(null);
  const resolver = useRef<((t: string | null) => void) | null>(null);
  const [usuario, setUsuario] = useState(() => { try { return localStorage.getItem('oneup:dono-login') ?? ''; } catch { return ''; } });
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!user || user.role === 'ADMIN') { registrarAutorizacaoDono(null); return; }
    registrarAutorizacaoDono((motivo) => new Promise((r) => { resolver.current = r; setSenha(''); setErro(''); setPedido({ motivo }); }));
    return () => registrarAutorizacaoDono(null);
  }, [user]);
  if (!pedido) return null;
  const fechar = (t: string | null) => { resolver.current?.(t); resolver.current = null; setPedido(null); };
  const confirmar = async () => {
    setBusy(true); setErro('');
    try {
      const r = await api.post<{ token: string }>('/api/auth/autorizar', { username: usuario.trim(), password: senha });
      try { localStorage.setItem('oneup:dono-login', usuario.trim()); } catch { /* sem armazenamento */ }
      fechar(r.token);
    } catch (e) { setErro((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title="Autorização do Dono" onClose={() => fechar(null)} footer={<>
      <button className="btn" onClick={() => fechar(null)}>Voltar</button>
      <button className="btn primary" disabled={busy || !usuario.trim() || !senha} onClick={confirmar}>{busy ? 'Conferindo…' : 'Autorizar'}</button>
    </>}>
      <form className="col gap-lg" onSubmit={(e) => { e.preventDefault(); void confirmar(); }}>
        <div className="info-box small">{pedido.motivo}</div>
        <div className="small muted">O Dono digita o usuário e a senha dele aqui. Vale só para esta ação; você continua no seu acesso.</div>
        <label className="field"><span>Usuário do Dono</span><input className="input" autoCapitalize="none" autoComplete="off" value={usuario} onChange={(e) => setUsuario(e.target.value)} /></label>
        <label className="field"><span>Senha do Dono</span><input className="input" type="password" autoComplete="off" autoFocus={!!usuario} value={senha} onChange={(e) => setSenha(e.target.value)} /></label>
        {erro && <div className="login-error" role="alert">{erro}</div>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
