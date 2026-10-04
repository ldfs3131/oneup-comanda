import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { aoEsquecerUsuario, tokenFromCookieHeader, userFromToken } from './auth.js';
import { bumpDataVersion, bumpMenuVersion, estoqueMudou } from './lib/cache.js';
import { currentContext, runAsEmpresa } from './db/index.js';
import { empresaPorSlug, slugDaRequisicao } from './lib/empresa.js';

let io: Server | null = null;

/*
 * Tempo real ISOLADO POR EMPRESA: cada aparelho entra só nas salas da própria empresa
 * ("<empresa>:kitchen", "<empresa>:cashier", "<empresa>:admin"). Um evento nunca sai da empresa
 * que o gerou: a empresa vem do contexto da requisição, nunca de parâmetro.
 */
export function initRealtime(server: HttpServer) {
  io = new Server(server, { path: '/socket.io', serveClient: false });
  io.use(async (socket, next) => {
    try {
      const h = socket.handshake.headers;
      // só a página do próprio endereço abre o tempo real (outro site com o cookie da pessoa é recusado)
      if (h.origin) { try { if (new URL(h.origin).host !== h.host) return next(new Error('origem')); } catch { return next(new Error('origem')); } }
      const emp = await empresaPorSlug(slugDaRequisicao(h.host, h['x-empresa']));
      if (!emp) return next(new Error('empresa'));
      const user = await runAsEmpresa(emp.id, () => userFromToken(tokenFromCookieHeader(h.cookie)));
      if (!user) return next(new Error('unauthorized'));
      // licença SUSPENSA: a equipe do restaurante não conecta (a ONE UP sim)
      if (!user.oneup && emp.licencaStatus === 'SUSPENSO') return next(new Error('suspenso'));
      socket.data.user = user;
      socket.data.empresaId = emp.id;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });
  io.on('connection', (socket) => {
    const role = socket.data.user.role as string;
    const e = socket.data.empresaId as number;
    if (role === 'COZINHA' || role === 'ADMIN') socket.join(`${e}:kitchen`);
    if (role === 'CAIXA' || role === 'ADMIN') socket.join(`${e}:cashier`);
    if (role === 'ADMIN') socket.join(`${e}:admin`);
    socket.join(`${e}:user:${socket.data.user.id}`);
  });
  // pessoa desativada, rebaixada, que trocou a senha ou saiu: os aparelhos dela param de receber na hora
  aoEsquecerUsuario.push((e, userId) => { io?.in(`${e}:user:${userId}`).disconnectSockets(true); });
  return io;
}

/** Restaurante suspenso pela ONE UP: os aparelhos da equipe saem do tempo real na hora (a ONE UP continua). */
export async function desconectarEquipe(empresaId: number) {
  if (!io) return;
  for (const s of await io.fetchSockets()) {
    if (s.data.empresaId === empresaId && !s.data.user?.oneup) s.disconnect(true);
  }
}

/** Desligamento: fecha os sockets para o servidor sair rápido (tablets reconectam sozinhos no novo processo). */
export async function fecharRealtime() {
  if (!io) return;
  io.disconnectSockets(true);
  await new Promise<void>((r) => io!.close(() => r()));
}

type Room = 'kitchen' | 'cashier' | 'admin';

export function emit(rooms: Room[], event: string, payload: unknown = {}) {
  if (!io) return;
  const empresaId = currentContext()?.empresaId;
  if (!empresaId) { console.error(`[tempo real] evento "${event}" sem empresa no contexto: não enviado`); return; }
  let target = io.to(`${empresaId}:${rooms[0]}`);
  for (const r of rooms.slice(1)) target = target.to(`${empresaId}:${r}`);
  target.emit(event, payload);
}

/** Atalhos semânticos */
export const notify = {
  ordersChanged: () => { bumpDataVersion(); emit(['kitchen', 'cashier'], 'orders:changed'); },
  accountsChanged: (accountId?: number) => { bumpDataVersion(); emit(['cashier', 'admin'], 'accounts:changed', { accountId }); },
  menuChanged: () => { bumpMenuVersion(); emit(['kitchen', 'cashier', 'admin'], 'menu:changed'); },
  /** Depois de pedido/cancelamento: só avisa o cardápio se o estoque realmente mudou. */
  stockMaybeChanged: () => { if (estoqueMudou()) { bumpMenuVersion(); emit(['kitchen', 'cashier', 'admin'], 'menu:changed'); } },
  settingsChanged: () => { bumpMenuVersion(); bumpDataVersion(); emit(['kitchen', 'cashier', 'admin'], 'settings:changed'); },
  registerChanged: () => { bumpDataVersion(); emit(['cashier', 'admin'], 'register:changed'); },
  kitchenNewOrder: (p: unknown) => emit(['kitchen'], 'kitchen:new', p),
  kitchenCancelled: (p: unknown) => emit(['kitchen'], 'kitchen:cancelled', p),
  orderReady: (p: unknown) => emit(['cashier'], 'order:ready', p),
  orderProblem: (p: unknown) => emit(['cashier'], 'order:problem', p),
  qrNew: (p: unknown) => emit(['cashier'], 'qr:new', p),
};
