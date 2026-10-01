import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { User } from './types';

export type Meta = { demoMode: boolean; restaurantName: string; tagline: string; version: string; product?: string; empresa?: string | null; logo?: string | null; accent?: string | null };
type AuthCtx = {
  user: User | null; loading: boolean; meta: Meta | null;
  login: (u: string, p: string, remember?: boolean) => Promise<User>; logout: () => Promise<void>;
};
const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();
  // marca da empresa (nome, logotipo, cor): consulta pública, atualizada quando o Dono muda a personalização
  const { data: metaData } = useQuery({ queryKey: ['meta'], queryFn: () => api.get<Meta>('/api/meta'), staleTime: 60_000 });
  const meta = metaData ?? null;

  useEffect(() => {
    api.get<{ user: User }>('/api/auth/me').then((r) => setUser(r.user)).catch(() => setUser(null)).finally(() => setLoading(false));
    const onUnauth = () => setUser(null);
    window.addEventListener('ha:unauthorized', onUnauth);
    return () => window.removeEventListener('ha:unauthorized', onUnauth);
  }, []);

  const login = useCallback(async (username: string, password: string, remember = true) => {
    const r = await api.post<{ user: User }>('/api/auth/login', { username, password, remember });
    qc.clear();
    setUser(r.user);
    return r.user;
  }, [qc]);

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    qc.clear();
    setUser(null);
  }, [qc]);

  return <Ctx.Provider value={{ user, loading, meta, login, logout }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);

export function homeFor(role: string) {
  return role === 'ADMIN' ? '/admin' : role === 'COZINHA' ? '/cozinha' : '/caixa';
}
