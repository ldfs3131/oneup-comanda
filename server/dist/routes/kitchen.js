import { respostaCompartilhada } from '../lib/cacheRota.js';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, orderItems, orders } from '../db/schema.js';
import { me, requireRole } from '../auth.js';
import { conflict, idParam, notFound, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { notify } from '../realtime.js';
export async function kitchenRoutes(app) {
    const k = { preHandler: requireRole('COZINHA') };
    app.get('/api/kitchen/orders', { preHandler: [requireRole('COZINHA'), respostaCompartilhada('cozinha', 'dados', 5000)] }, async () => {
        // Novos e em preparo + prontos ainda não entregues (últimos 30)
        const rows = await db.execute(sql `
      (SELECT o.* FROM orders o WHERE o.goes_to_kitchen AND o.status IN ('CONFIRMED','IN_PREPARATION'))
      UNION ALL
      (SELECT o.* FROM orders o WHERE o.goes_to_kitchen AND o.status = 'READY' ORDER BY o.ready_at DESC LIMIT 30)`);
        const list = rows.rows;
        if (!list.length)
            return [];
        const ids = list.map((o) => o.id);
        const items = await db.select().from(orderItems).where(and(inArray(orderItems.orderId, ids), eq(orderItems.goesToKitchen, true)));
        const accs = await db.select({ id: accounts.id, number: accounts.number, customerName: accounts.customerName, note: accounts.note, tableLabel: accounts.tableLabel })
            .from(accounts).where(inArray(accounts.id, [...new Set(list.map((o) => o.account_id))]));
        // Itens anteriores da mesma conta (só leitura): a cozinha vê o que já foi feito, mas trabalha só no lote novo
        const prev = await db.execute(sql `
      SELECT o.id AS order_id, o.account_id, o.number, o.status, oi.product_name, oi.quantity
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.account_id IN (${sql.join([...new Set(list.map((o) => Number(o.account_id)))].map((aid) => sql `${aid}`), sql `, `)})
        AND o.goes_to_kitchen AND oi.goes_to_kitchen AND oi.status = 'ACTIVE' AND o.status NOT IN ('CANCELLED','AWAITING_CONFIRMATION')
      ORDER BY o.id, oi.id`);
        const prevRows = prev.rows;
        return list.map((o) => {
            const a = accs.find((x) => x.id === o.account_id);
            return {
                id: o.id, number: o.number, sequence: o.sequence, status: o.status, note: o.note, origin: o.origin,
                consumptionType: o.consumption_type, expectedMinutes: o.expected_minutes ?? 15,
                createdAt: o.created_at, confirmedAt: o.confirmed_at, startedAt: o.started_at, readyAt: o.ready_at,
                problemNote: o.problem_note,
                account: { id: a.id, number: a.number, customerName: a.customerName, note: a.note, tableLabel: a.tableLabel },
                items: items.filter((i) => i.orderId === o.id).map((i) => ({
                    id: i.id, name: i.productName, quantity: i.quantity, options: i.optionsSnapshot, note: i.note, cancelled: i.status === 'CANCELLED', isCustom: i.isCustom,
                })),
                previous: o.sequence > 1
                    ? prevRows.filter((p) => p.account_id === o.account_id && p.order_id < o.id)
                        .map((p) => ({ orderNumber: p.number, name: p.product_name, quantity: p.quantity, status: p.status }))
                    : [],
            };
        }).sort((a, b) => +new Date(a.confirmedAt ?? a.createdAt) - +new Date(b.confirmedAt ?? b.createdAt));
    });
    async function transition(orderId, userId, userName, from, to, verb) {
        return db.transaction(async (tx) => {
            const [o] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
            if (!o)
                throw notFound('Pedido não encontrado.');
            if (o.status === 'CANCELLED')
                throw conflict('Este pedido foi cancelado pelo caixa.');
            if (!from.includes(o.status))
                throw conflict('O pedido já mudou de etapa. A tela foi atualizada.');
            const now = new Date();
            const set = { status: to };
            if (to === 'IN_PREPARATION' && !o.startedAt) {
                set.startedAt = now;
                set.startedBy = userId;
            }
            if (to === 'READY') {
                set.readyAt = now;
                set.readyBy = userId;
                if (!o.startedAt) {
                    set.startedAt = now;
                    set.startedBy = userId;
                }
            }
            await tx.update(orders).set(set).where(eq(orders.id, orderId));
            const [a] = await tx.select().from(accounts).where(eq(accounts.id, o.accountId));
            await audit(tx, { userId, action: `kitchen.${to.toLowerCase()}`, entityType: 'order', entityId: o.id, message: `${userName} ${verb} o pedido #${o.number} (conta #${a.number}).` });
            return { o, a };
        });
    }
    app.post('/api/kitchen/orders/:id/start', k, async (req) => {
        const { id } = parse(idParam, req.params);
        await transition(id, me(req).id, me(req).name, ['CONFIRMED'], 'IN_PREPARATION', 'iniciou o preparo do');
        notify.ordersChanged();
        return { ok: true };
    });
    app.post('/api/kitchen/orders/:id/ready', k, async (req) => {
        const { id } = parse(idParam, req.params);
        const { o, a } = await transition(id, me(req).id, me(req).name, ['CONFIRMED', 'IN_PREPARATION'], 'READY', 'marcou como PRONTO');
        notify.orderReady({ orderId: o.id, orderNumber: o.number, accountId: a.id, accountNumber: a.number, customerName: a.customerName, note: a.note, sequence: o.sequence });
        notify.ordersChanged();
        notify.accountsChanged(a.id);
        return { ok: true };
    });
    app.post('/api/kitchen/orders/:id/back', k, async (req) => {
        const { id } = parse(idParam, req.params);
        const { a } = await transition(id, me(req).id, me(req).name, ['READY'], 'IN_PREPARATION', 'voltou para preparo');
        notify.ordersChanged();
        notify.accountsChanged(a.id);
        return { ok: true };
    });
    app.post('/api/kitchen/orders/:id/problem', k, async (req) => {
        const { id } = parse(idParam, req.params);
        const { note } = parse(z.object({ note: z.string().trim().min(2, 'descreva o problema').max(200) }), req.body);
        const user = me(req);
        const r = await db.transaction(async (tx) => {
            const [o] = await tx.select().from(orders).where(eq(orders.id, id)).for('update');
            if (!o)
                throw notFound('Pedido não encontrado.');
            if (!['CONFIRMED', 'IN_PREPARATION', 'READY'].includes(o.status))
                throw conflict('O pedido não está mais na cozinha.');
            await tx.update(orders).set({ problemNote: note, problemAt: new Date() }).where(eq(orders.id, id));
            const [a] = await tx.select().from(accounts).where(eq(accounts.id, o.accountId));
            await audit(tx, { userId: user.id, action: 'kitchen.problem', entityType: 'order', entityId: id, message: `${user.name} informou problema no pedido #${o.number} (conta #${a.number}): "${note}".` });
            return { o, a };
        });
        notify.orderProblem({ orderId: r.o.id, orderNumber: r.o.number, accountId: r.a.id, accountNumber: r.a.number, customerName: r.a.customerName, problemNote: note });
        notify.ordersChanged();
        return { ok: true };
    });
}
