import { Server } from 'socket.io';
import { tokenFromCookieHeader, userFromToken } from './auth.js';
let io = null;
export function initRealtime(server) {
    io = new Server(server, { path: '/socket.io', serveClient: false });
    io.use(async (socket, next) => {
        const user = await userFromToken(tokenFromCookieHeader(socket.handshake.headers.cookie));
        if (!user)
            return next(new Error('unauthorized'));
        socket.data.user = user;
        next();
    });
    io.on('connection', (socket) => {
        const role = socket.data.user.role;
        if (role === 'COZINHA' || role === 'ADMIN')
            socket.join('kitchen');
        if (role === 'CAIXA' || role === 'ADMIN')
            socket.join('cashier');
        if (role === 'ADMIN')
            socket.join('admin');
    });
    return io;
}
export function emit(rooms, event, payload = {}) {
    if (!io)
        return;
    let target = io.to(rooms[0]);
    for (const r of rooms.slice(1))
        target = target.to(r);
    target.emit(event, payload);
}
/** Atalhos semânticos */
export const notify = {
    ordersChanged: () => emit(['kitchen', 'cashier'], 'orders:changed'),
    accountsChanged: (accountId) => emit(['cashier', 'admin'], 'accounts:changed', { accountId }),
    menuChanged: () => emit(['kitchen', 'cashier', 'admin'], 'menu:changed'),
    settingsChanged: () => emit(['kitchen', 'cashier', 'admin'], 'settings:changed'),
    registerChanged: () => emit(['cashier', 'admin'], 'register:changed'),
    kitchenNewOrder: (p) => emit(['kitchen'], 'kitchen:new', p),
    kitchenCancelled: (p) => emit(['kitchen'], 'kitchen:cancelled', p),
    orderReady: (p) => emit(['cashier'], 'order:ready', p),
    orderProblem: (p) => emit(['cashier'], 'order:problem', p),
    qrNew: (p) => emit(['cashier'], 'qr:new', p),
};
