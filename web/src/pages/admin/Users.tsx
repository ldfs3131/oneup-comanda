import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { ROLE_LABEL, dateOnly } from '../../format';
import { Badge, Modal, Spinner, useAction } from '../../components/ui';

type U = { id: number; name: string; username: string; role: 'ADMIN' | 'CAIXA' | 'COZINHA'; active: boolean; createdAt: string };

export default function Users() {
  const { data, isLoading } = useQuery({ queryKey: ['users'], queryFn: () => api.get<U[]>('/api/users') });
  const [edit, setEdit] = useState<U | 'new' | null>(null);
  if (isLoading || !data) return <Spinner />;
  return (
    <div className="col gap-lg">
      <div className="row between">
        <h1>Usuários</h1>
        <button className="btn primary" onClick={() => setEdit('new')}>＋ Novo usuário</button>
      </div>
      <div className="card table-wrap" style={{ padding: 0 }}>
        <table className="table">
          <thead><tr><th>Nome</th><th>Login</th><th>Perfil</th><th>Situação</th><th className="hide-mobile">Desde</th><th /></tr></thead>
          <tbody>
            {data.map((u) => (
              <tr key={u.id}>
                <td><b>{u.name}</b></td>
                <td className="mono">{u.username}</td>
                <td><Badge tone={u.role === 'ADMIN' ? 'brand' : u.role === 'CAIXA' ? 'info' : 'warn'}>{ROLE_LABEL[u.role]}</Badge></td>
                <td>{u.active ? <Badge tone="ok">Ativo</Badge> : <Badge>Desativado</Badge>}</td>
                <td className="small muted hide-mobile">{dateOnly(u.createdAt)}</td>
                <td className="right"><button className="btn sm" onClick={() => setEdit(u)}>Editar</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="small muted">Usuários não são apagados, só desativados — assim o histórico continua mostrando quem fez cada coisa.</div>
      {edit && <UserModal user={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function UserModal({ user, onClose }: { user: U | null; onClose: () => void }) {
  const me = useAuth().user;
  const qc = useQueryClient();
  const [name, setName] = useState(user?.name ?? '');
  const [username, setUsername] = useState(user?.username ?? '');
  const [role, setRole] = useState<U['role']>(user?.role ?? 'CAIXA');
  const [active, setActive] = useState(user?.active ?? true);
  const [password, setPassword] = useState('');
  const { busy, run } = useAction();
  const isMe = user?.id === me?.id;
  const valid = name.trim().length >= 2 && (user ? password === '' || password.length >= 4 : username.trim().length >= 2 && password.length >= 4);

  return (
    <Modal title={user ? `Editar · ${user.name}` : 'Novo usuário'} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary" disabled={!valid || busy} onClick={async () => {
        const ok = await run(() => user
          ? api.patch(`/api/users/${user.id}`, { name: name.trim(), role, active, ...(password ? { password } : {}) })
          : api.post('/api/users', { name: name.trim(), username: username.trim().toLowerCase(), password, role }), 'Usuário salvo.');
        if (ok) { qc.invalidateQueries({ queryKey: ['users'] }); onClose(); }
      }}>Salvar</button>
    </>}>
      <div className="col gap-lg">
        <label className="field"><span>Nome</span><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>Login</span><input className="input" disabled={!!user} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="ex.: joao" autoCapitalize="none" /></label>
        <div className="field"><span>Perfil</span>
          <div className="seg">
            {(['CAIXA', 'COZINHA', 'ADMIN'] as const).map((r) => <button key={r} disabled={isMe} className={role === r ? 'on' : ''} onClick={() => setRole(r)}>{ROLE_LABEL[r]}</button>)}
          </div>
        </div>
        <label className="field"><span>{user ? 'Nova senha (deixe vazio para manter)' : 'Senha (mín. 4)'}</span>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></label>
        {user && !isMe && <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />Usuário ativo</label>}
      </div>
    </Modal>
  );
}
