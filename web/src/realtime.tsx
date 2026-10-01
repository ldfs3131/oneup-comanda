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
    // Junta os avisos que chegam em sequência (um pedido gera 2–3 avisos) e busca UMA vez.
    // O painel do dono (consulta pesada) atualiza no máximo a cada 30 s por aviso; o resto em 0,3 s.
    const pendentes = new Map<string, unknown[]>();
    let timer: number | undefined;
    let ultimoPainel = 0;
    const flush = () => {
      timer = undefined;
      for (const k of pendentes.values()) qc.invalidateQueries({ queryKey: k });
      pendentes.clear();
    };
    const inv = (...keys: unknown[][]) => {
      for (const k of keys) {
        if (k[0] === 'dashboard') { if (Date.now() - ultimoPainel < 30_000) continue; ultimoPainel = Date.now(); }
        pendentes.set(JSON.stringify(k), k);
      }
      if (timer === undefined) timer = window.setTimeout(flush, 300);
    };
    s.onAny((event: string, payload: any) => {
      switch (event) {
        case 'orders:changed': inv(['board'], ['kitchen'], ['account'], ['dashboard'], ['ordersToday'], ['order'], ['stock']); break;
        case 'accounts:changed': inv(['board'], ['account'], ['accounts'], ['receivable'], ['dashboard'], ['ordersToday'], ['order']); break;
        case 'menu:changed': inv(['menu'], ['stock'], ['stockDiv']); break;
        case 'settings:changed': inv(['settings'], ['meta'], ['configuracoes'], ['payment-methods-all']); break;
        case 'register:changed': inv(['register'], ['board'], ['dashboard'], ['registers']); break;
      }
      listeners.current.forEach((l) => l(event, payload));
    });
    return () => { s.close(); if (timer !== undefined) window.clearTimeout(timer); };
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
