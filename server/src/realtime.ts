import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { tokenFromCookieHeader, userFromToken } from './auth.js';
import { bumpDataVersion } from './lib/cache.js';
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
      const emp = await empresaPorSlug(slugDaRequisicao(h.host, h['x-empresa']));
      if (!emp) return next(new Error('empresa'));
      const user = await runAsEmpresa(emp.id, () => userFromToken(tokenFromCookieHeader(h.cookie)));
      if (!user) return next(new Error('unauthorized'));
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
  });
  return io;
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
  menuChanged: () => emit(['kitchen', 'cashier', 'admin'], 'menu:changed'),
  settingsChanged: () => emit(['kitchen', 'cashier', 'admin'], 'settings:changed'),
  registerChanged: () => { bumpDataVersion(); emit(['cashier', 'admin'], 'register:changed'); },
  kitchenNewOrder: (p: unknown) => emit(['kitchen'], 'kitchen:new', p),
  kitchenCancelled: (p: unknown) => emit(['kitchen'], 'kitchen:cancelled', p),
  orderReady: (p: unknown) => emit(['cashier'], 'order:ready', p),
  orderProblem: (p: unknown) => emit(['cashier'], 'order:problem', p),
  qrNew: (p: unknown) => emit(['cashier'], 'qr:new', p),
};
