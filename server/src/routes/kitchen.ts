import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, orderItems, orders } from '../db/schema.js';
import { me, requireRole } from '../auth.js';
import { conflict, idParam, notFound, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { notify } from '../realtime.js';

export async function kitchenRoutes(app: FastifyInstance) {
  const k = { preHandler: requireRole('COZINHA') };

  app.get('/api/kitchen/orders', k, async () => {
    // Novos e em preparo + prontos ainda não entregues (últimos 30)
    const rows = await db.execute(sql`
      (SELECT o.* FROM orders o WHERE o.goes_to_kitchen AND o.status IN ('CONFIRMED','IN_PREPARATION'))
      UNION ALL
      (SELECT o.* FROM orders o WHERE o.goes_to_kitchen AND o.status = 'READY' ORDER BY o.ready_at DESC LIMIT 30)`);
    const list = rows.rows as any[];
    if (!list.length) return [];
    const ids = list.map((o) => o.id);
    const items = await db.select().from(orderItems).where(and(inArray(orderItems.orderId, ids), eq(orderItems.goesToKitchen, true)));
    const accs = await db.select({ id: accounts.id, number: accounts.number, customerName: accounts.customerName, note: accounts.note })
      .from(accounts).where(inArray(accounts.id, [...new Set(list.map((o) => o.account_id))]));
    return list.map((o) => {
      const a = accs.find((x) => x.id === o.account_id)!;
      return {
        id: o.id, number: o.number, sequence: o.sequence, status: o.status, note: o.note, origin: o.origin,
        createdAt: o.created_at, confirmedAt: o.confirmed_at, startedAt: o.started_at, readyAt: o.ready_at,
        problemNote: o.problem_note,
        account: { id: a.id, number: a.number, customerName: a.customerName, note: a.note },
        items: items.filter((i) => i.orderId === o.id).map((i) => ({
          id: i.id, name: i.productName, quantity: i.quantity, options: i.optionsSnapshot, note: i.note, cancelled: i.status === 'CANCELLED',
        })),
      };
    }).sort((a, b) => +new Date(a.confirmedAt ?? a.createdAt) - +new Date(b.confirmedAt ?? b.createdAt));
  });

  async function transition(
    orderId: number, userId: number, userName: string,
    from: string[], to: 'IN_PREPARATION' | 'READY', verb: string,
  ) {
    return db.transaction(async (tx) => {
      const [o] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
      if (!o) throw notFound('Pedido não encontrado.');
      if (o.status === 'CANCELLED') throw conflict('Este pedido foi cancelado pelo caixa.');
      if (!from.includes(o.status)) throw conflict('O pedido já mudou de etapa. A tela foi atualizada.');
      const now = new Date();
      const set: Partial<typeof orders.$inferInsert> = { status: to };
      if (to === 'IN_PREPARATION' && !o.startedAt) { set.startedAt = now; set.startedBy = userId; }
      if (to === 'READY') {
        set.readyAt = now; set.readyBy = userId;
        if (!o.startedAt) { set.startedAt = now; set.startedBy = userId; }
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
    notify.ordersChanged(); notify.accountsChanged(a.id);
    return { ok: true };
  });

  app.post('/api/kitchen/orders/:id/back', k, async (req) => {
    const { id } = parse(idParam, req.params);
    const { a } = await transition(id, me(req).id, me(req).name, ['READY'], 'IN_PREPARATION', 'voltou para preparo');
    notify.ordersChanged(); notify.accountsChanged(a.id);
    return { ok: true };
  });

  app.post('/api/kitchen/orders/:id/problem', k, async (req) => {
    const { id } = parse(idParam, req.params);
    const { note } = parse(z.object({ note: z.string().trim().min(2, 'descreva o problema').max(200) }), req.body);
    const user = me(req);
    const r = await db.transaction(async (tx) => {
      const [o] = await tx.select().from(orders).where(eq(orders.id, id)).for('update');
      if (!o) throw notFound('Pedido não encontrado.');
      if (!['CONFIRMED', 'IN_PREPARATION', 'READY'].includes(o.status)) throw conflict('O pedido não está mais na cozinha.');
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
