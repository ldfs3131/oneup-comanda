import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { tokenFromCookieHeader, userFromToken } from './auth.js';
import { bumpDataVersion } from './lib/cache.js';

let io: Server | null = null;

export function initRealtime(server: HttpServer) {
  io = new Server(server, { path: '/socket.io', serveClient: false });
  io.use(async (socket, next) => {
    const user = await userFromToken(tokenFromCookieHeader(socket.handshake.headers.cookie));
    if (!user) return next(new Error('unauthorized'));
    socket.data.user = user;
    next();
  });
  io.on('connection', (socket) => {
    const role = socket.data.user.role as string;
    if (role === 'COZINHA' || role === 'ADMIN') socket.join('kitchen');
    if (role === 'CAIXA' || role === 'ADMIN') socket.join('cashier');
    if (role === 'ADMIN') socket.join('admin');
  });
  return io;
}

type Room = 'kitchen' | 'cashier' | 'admin';

export function emit(rooms: Room[], event: string, payload: unknown = {}) {
  if (!io) return;
  let target = io.to(rooms[0]);
  for (const r of rooms.slice(1)) target = target.to(r);
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
