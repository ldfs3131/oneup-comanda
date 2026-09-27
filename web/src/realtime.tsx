import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from './auth';

type Listener = (event: string, payload: any) => void;
type RT = { connected: boolean; subscribe: (fn: Listener) => () => void };
const Ctx = createContext<RT>({ connected: true, subscribe: () => () => undefined });

/**
 * Uma conexão em tempo real por aba. Cada evento invalida as consultas afetadas
 * (a tela busca de novo no servidor) — o servidor é sempre a fonte da verdade.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [connected, setConnected] = useState(true);
  const listeners = useRef(new Set<Listener>());

  useEffect(() => {
    if (!user) return;
    const s: Socket = io({ path: '/socket.io', transports: ['websocket', 'polling'], reconnectionDelayMax: 4000 });
    let everConnected = false;
    s.on('connect', () => {
      setConnected(true);
      if (everConnected) qc.invalidateQueries(); // voltou a conexão: atualiza tudo
      everConnected = true;
    });
    s.on('disconnect', () => setConnected(false));
    s.on('connect_error', () => setConnected(false));
    const inv = (...keys: unknown[][]) => keys.forEach((k) => qc.invalidateQueries({ queryKey: k }));
    s.onAny((event: string, payload: any) => {
      switch (event) {
        case 'orders:changed': inv(['board'], ['kitchen'], ['account'], ['dashboard']); break;
        case 'accounts:changed': inv(['board'], ['account'], ['accounts'], ['receivable'], ['dashboard']); break;
        case 'menu:changed': inv(['menu']); break;
        case 'settings:changed': inv(['settings']); break;
        case 'register:changed': inv(['register'], ['board'], ['dashboard'], ['registers']); break;
      }
      listeners.current.forEach((l) => l(event, payload));
    });
    return () => { s.close(); };
  }, [user, qc]);

  const subscribe = useCallback((fn: Listener) => { listeners.current.add(fn); return () => { listeners.current.delete(fn); }; }, []);
  return <Ctx.Provider value={{ connected, subscribe }}>{children}</Ctx.Provider>;
}

export const useRealtime = () => useContext(Ctx);

export function useRealtimeEvent(fn: Listener) {
  const { subscribe } = useRealtime();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => subscribe((e, p) => ref.current(e, p)), [subscribe]);
}
