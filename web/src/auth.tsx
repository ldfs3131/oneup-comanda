import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';
import type { User } from './types';

export type Meta = { demoMode: boolean; restaurantName: string; tagline: string; version: string; product?: string; empresa?: string | null; logo?: string | null; accent?: string | null; tema?: 'escuro' | 'claro' | 'auto'; nomeApp?: string | null; icone?: string | null; acessoSuspenso?: boolean };
type AuthCtx = {
  user: User | null; loading: boolean; offline: boolean; meta: Meta | null;
  login: (u: string, p: string, remember?: boolean) => Promise<User>; loginPin: (userId: number, pin: string) => Promise<User>; logout: () => Promise<void>;
};
const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const qc = useQueryClient();
  // marca da empresa (nome, logotipo, cor): consulta pública, atualizada quando o Dono muda a personalização
  const { data: metaData } = useQuery({ queryKey: ['meta'], queryFn: () => api.get<Meta>('/api/meta'), staleTime: 60_000 });
  const meta = metaData ?? null;

  useEffect(() => {
    // Só a resposta "sessão expirada" (401) desloga. Sem internet (tablet da cozinha recarregando no Wi-Fi
    // instável), continua tentando sozinho e entra assim que a conexão volta, sem pedir a senha de novo.
    let vivo = true;
    let espera = 2000;
    const tentar = () => {
      api.get<{ user: User }>('/api/auth/me')
        .then((r) => { if (vivo) { setUser(r.user); setOffline(false); setLoading(false); } })
        .catch((e: ApiError) => {
          if (!vivo) return;
          if (e.status === 0 || e.status >= 500) { setOffline(true); setTimeout(tentar, espera); espera = Math.min(espera * 1.5, 10_000); return; }
          setUser(null); setOffline(false); setLoading(false);
        });
    };
    tentar();
    const onUnauth = () => setUser(null);
    window.addEventListener('ha:unauthorized', onUnauth);
    return () => { vivo = false; window.removeEventListener('ha:unauthorized', onUnauth); };
  }, []);

  const login = useCallback(async (username: string, password: string, remember = true) => {
    const r = await api.post<{ user: User }>('/api/auth/login', { username, password, remember });
    qc.clear();
    setUser(r.user);
    return r.user;
  }, [qc]);

  const loginPin = useCallback(async (userId: number, pin: string) => {
    const r = await api.post<{ user: User }>('/api/auth/pin', { userId, pin });
    qc.clear();
    setUser(r.user);
    return r.user;
  }, [qc]);

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    qc.clear();
    setUser(null);
  }, [qc]);

  return <Ctx.Provider value={{ user, loading, offline, meta, login, loginPin, logout }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);

export function homeFor(role: string) {
  return role === 'ADMIN' ? '/admin' : role === 'COZINHA' ? '/cozinha' : '/caixa';
}
