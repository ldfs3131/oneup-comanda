import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db, nextNumber, type Executor } from '../db/index.js';
import {
  accounts, cancellations, discounts, orderItems, orders, paymentMethods, payments,
} from '../db/schema.js';
import { me, requireRole } from '../auth.js';
import { bad, brl, centsSchema, conflict, idParam, notFound, parse, reasonSchema } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { notify } from '../realtime.js';
import {
  accountDetail, accountTotals, assertAccountEditable, currentRegister, getAccount, insertOrder,
  listAccountsWithTotals, recomputeStatus, requireOpenRegister,
} from '../services/accounts.js';

const itemSchema = z.object({
  productId: z.number().int().positive(),
  quantity: z.number().int().min(1).max(99),
  optionIds: z.array(z.number().int().positive()).max(20).default([]),
  note: z.string().trim().max(200).nullable().optional(),
});
const itemsSchema = z.array(itemSchema).max(60);
const optText = (n: number) => z.string().trim().max(n).nullable().optional().transform((v) => v || null);

const label = (a: { number: number; customerName: string | null }) =>
  `conta #${a.number}${a.customerName ? ` (${a.customerName})` : ''}`;

async function orderWithAccount(tx: Executor, id: number, lock = false) {
  const q = tx.select().from(orders).where(eq(orders.id, id));
  const [o] = lock ? await q.for('update') : await q;
  if (!o) throw notFound('Pedido não encontrado.');
  const acc = await getAccount(tx, o.accountId);
  return { o, acc };
}

/** Dados que o caixa precisa para o alerta de pedido pronto. */
async function readyPayload(tx: Executor, orderId: number) {
  const { o, acc } = await orderWithAccount(tx, orderId);
  return {
    orderId: o.id, orderNumber: o.number, accountId: acc.id, accountNumber: acc.number,
    customerName: acc.customerName, note: acc.note, sequence: o.sequence, problemNote: o.problemNote,
  };
}

export async function accountRoutes(app: FastifyInstance) {
  const ops = { preHandler: requireRole('CAIXA') };
  const admin = { preHandler: requireRole('ADMIN') };

  app.get('/api/payment-methods', ops, async () =>
    db.select().from(paymentMethods).where(eq(paymentMethods.active, true)).orderBy(asc(paymentMethods.sortOrder)));

  // Painel do caixa: contas vivas + prontos + aguardando confirmação (QR)
  app.get('/api/cashier/board', ops, async () => {
    const live = await listAccountsWithTotals(db, sql`a.status IN ('OPEN','PARTIALLY_PAID','PAID')
      AND (a.origin = 'CAIXA' OR EXISTS (SELECT 1 FROM orders o WHERE o.account_id = a.id AND o.status NOT IN ('AWAITING_CONFIRMATION','CANCELLED')))`);
    const ready = await db.execute(sql`
      SELECT o.id AS "orderId", o.number AS "orderNumber", o.sequence, o.ready_at AS "readyAt", o.problem_note AS "problemNote",
             o.status, a.id AS "accountId", a.number AS "accountNumber", a.customer_name AS "customerName", a.note
      FROM orders o JOIN accounts a ON a.id = o.account_id
      WHERE o.status = 'READY' OR (o.problem_note IS NOT NULL AND o.status IN ('CONFIRMED','IN_PREPARATION','READY'))
      ORDER BY o.ready_at NULLS LAST, o.id`);
    const awaiting = await db.execute(sql`
      SELECT o.id AS "orderId", o.number AS "orderNumber", o.note, o.created_at AS "createdAt",
             a.id AS "accountId", a.number AS "accountNumber", a.customer_name AS "customerName", a.note AS "accountNote",
             COALESCE((SELECT SUM(unit_price_cents*quantity) FROM order_items WHERE order_id = o.id AND status='ACTIVE'),0) AS "totalCents"
      FROM orders o JOIN accounts a ON a.id = o.account_id
      WHERE o.status = 'AWAITING_CONFIRMATION' ORDER BY o.id`);
    const reg = await currentRegister(db);
    return { accounts: live, ready: ready.rows, awaiting: awaiting.rows, register: reg ? { id: reg.id, openedAt: reg.openedAt } : null };
  });

  // Histórico / busca de contas
  app.get('/api/accounts', ops, async (req) => {
    const q = parse(z.object({
      status: z.string().optional(), search: z.string().trim().max(60).optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }), req.query);
    const conds = [sql`TRUE`];
    if (q.status) {
      const list = q.status.split(',').filter((s) => ['OPEN', 'PARTIALLY_PAID', 'PENDING', 'PAID', 'CLOSED', 'CANCELLED'].includes(s));
      if (list.length) conds.push(sql`a.status IN (${sql.join(list.map((s) => sql`${s}`), sql`, `)})`);
    }
    if (q.date) conds.push(sql`(a.opened_at AT TIME ZONE 'America/Sao_Paulo')::date = ${q.date}::date`);
    if (q.search) {
      const n = Number(q.search.replace('#', ''));
      if (Number.isInteger(n) && n > 0) conds.push(sql`a.number = ${n}`);
      else conds.push(sql`(a.customer_name ILIKE ${'%' + q.search + '%'} OR a.note ILIKE ${'%' + q.search + '%'} OR a.contact ILIKE ${'%' + q.search + '%'})`);
    }
    return listAccountsWithTotals(db, sql.join(conds, sql` AND `), 300);
  });

  app.get('/api/accounts/receivable', ops, async () =>
    listAccountsWithTotals(db, sql`a.status = 'PENDING'`, 500));

  app.get('/api/accounts/:id', ops, async (req) => {
    const { id } = parse(idParam, req.params);
    return accountDetail(db, id);
  });

  // Nova conta (opcionalmente já com o primeiro pedido)
  app.post('/api/accounts', ops, async (req) => {
    const b = parse(z.object({
      customerName: optText(80), note: optText(200), items: itemsSchema.default([]), orderNote: optText(200),
    }), req.body);
    const user = me(req);
    const result = await db.transaction(async (tx) => {
      const reg = await requireOpenRegister(tx);
      const number = await nextNumber(tx, 'account');
      const [acc] = await tx.insert(accounts).values({
        number, customerName: b.customerName, note: b.note, cashRegisterId: reg.id, openedBy: user.id,
      }).returning();
      await audit(tx, { userId: user.id, action: 'account.create', entityType: 'account', entityId: acc.id, message: `${user.name} abriu a ${label(acc)}.` });
      let order = null;
      if (b.items.length) {
        const r = await insertOrder(tx, { accountId: acc.id, items: b.items, note: b.orderNote, userId: user.id, origin: 'CAIXA', cashRegisterId: reg.id });
        order = r.order;
        await audit(tx, {
          userId: user.id, action: 'order.create', entityType: 'order', entityId: order.id,
          message: `${user.name} lançou o pedido #${order.number} na ${label(acc)} — ${r.itemCount} item(ns), ${brl(r.totalCents)}${order.goesToKitchen ? ', enviado para a cozinha' : ' (balcão)'}.`,
        });
        await recomputeStatus(tx, acc.id);
      }
      return { acc, order };
    });
    if (result.order?.goesToKitchen) notify.kitchenNewOrder({ orderNumber: result.order.number, accountNumber: result.acc.number, sequence: 1 });
    notify.ordersChanged(); notify.accountsChanged(result.acc.id);
    return { id: result.acc.id, number: result.acc.number, orderNumber: result.order?.number ?? null };
  });

  app.patch('/api/accounts/:id', ops, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ customerName: optText(80), note: optText(200), contact: optText(120) }), req.body);
    const user = me(req);
    await db.transaction(async (tx) => {
      const acc = await getAccount(tx, id, true);
      assertAccountEditable(acc.status);
      const set: Partial<typeof accounts.$inferInsert> = {};
      if (b.customerName !== undefined) set.customerName = b.customerName;
      if (b.note !== undefined) set.note = b.note;
      if (b.contact !== undefined) set.contact = b.contact;
      if (acc.status === 'PENDING' && (!(set.customerName ?? acc.customerName) || !(set.contact ?? acc.contact))) {
        throw bad('Conta pendente precisa de nome e casa/telefone.');
      }
      await tx.update(accounts).set(set).where(eq(accounts.id, id));
      await audit(tx, { userId: user.id, action: 'account.update', entityType: 'account', entityId: id, message: `${user.name} alterou a identificação da ${label(acc)}.`, data: { before: { customerName: acc.customerName, note: acc.note, contact: acc.contact }, after: set } });
    });
    notify.accountsChanged(id);
    return { ok: true };
  });

  // Novo pedido / complemento na mesma conta
  app.post('/api/accounts/:id/orders', ops, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ items: itemsSchema.min(1, 'adicione ao menos um produto'), note: optText(200) }), req.body);
    const user = me(req);
    const r = await db.transaction(async (tx) => {
      const acc = await getAccount(tx, id, true);
      assertAccountEditable(acc.status);
      if (acc.status === 'PENDING') throw conflict('Conta pendente não recebe novos pedidos. Abra uma nova conta.');
      const reg = await requireOpenRegister(tx);
      const r = await insertOrder(tx, { accountId: id, items: b.items, note: b.note, userId: user.id, origin: 'CAIXA', cashRegisterId: reg.id });
      const kind = r.order.sequence > 1 ? 'complemento' : 'pedido';
      await audit(tx, {
        userId: user.id, action: 'order.create', entityType: 'order', entityId: r.order.id,
        message: `${user.name} lançou ${kind} #${r.order.number} na ${label(acc)} — ${r.itemCount} item(ns), ${brl(r.totalCents)}${r.order.goesToKitchen ? ', enviado para a cozinha' : ' (balcão)'}.`,
      });
      await recomputeStatus(tx, id);
      return { acc, order: r.order };
    });
    if (r.order.goesToKitchen) notify.kitchenNewOrder({ orderNumber: r.order.number, accountNumber: r.acc.number, sequence: r.order.sequence });
    notify.ordersChanged(); notify.accountsChanged(id);
    return { orderId: r.order.id, orderNumber: r.order.number };
  });

  // Pagamentos (uma ou várias formas de uma vez)
  app.post('/api/accounts/:id/payments', ops, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({
      payments: z.array(z.object({
        methodId: z.number().int().positive(),
        amountCents: centsSchema,
        tenderedCents: z.number().int().positive().nullable().optional(),
      })).min(1).max(6),
      close: z.boolean().default(false),
    }), req.body);
    const user = me(req);
    const out = await db.transaction(async (tx) => {
      const acc = await getAccount(tx, id, true);
      assertAccountEditable(acc.status);
      const reg = await requireOpenRegister(tx);
      const t = await accountTotals(tx, id);
      const sum = b.payments.reduce((s, p) => s + p.amountCents, 0);
      if (t.balance <= 0) throw conflict('Esta conta não tem saldo a pagar.');
      if (sum > t.balance) throw bad(`O valor (${brl(sum)}) é maior que o saldo da conta (${brl(t.balance)}). Para dinheiro, informe o valor recebido para calcular o troco.`);
      const methods = await tx.select().from(paymentMethods).where(inArray(paymentMethods.id, b.payments.map((p) => p.methodId)));
      const parts: string[] = [];
      for (const p of b.payments) {
        const m = methods.find((x) => x.id === p.methodId && x.active);
        if (!m) throw bad('Forma de pagamento inválida.');
        if (p.tenderedCents != null) {
          if (!m.isCash) throw bad('Valor recebido/troco só se aplica a dinheiro.');
          if (p.tenderedCents < p.amountCents) throw bad('O valor recebido em dinheiro é menor que o valor pago.');
        }
        await tx.insert(payments).values({
          accountId: id, methodId: m.id, amountCents: p.amountCents, tenderedCents: p.tenderedCents ?? null,
          cashRegisterId: reg.id, userId: user.id,
        });
        parts.push(`${brl(p.amountCents)} ${m.name}${p.tenderedCents ? ` (recebido ${brl(p.tenderedCents)}, troco ${brl(p.tenderedCents - p.amountCents)})` : ''}`);
      }
      const newBalance = t.balance - sum;
      await audit(tx, {
        userId: user.id, action: 'payment.create', entityType: 'account', entityId: id,
        message: `${user.name} recebeu ${parts.join(' + ')} na ${label(acc)}. Saldo: ${brl(newBalance)}.`,
      });
      let status = await recomputeStatus(tx, id);
      if (b.close && newBalance === 0) {
        await tx.update(accounts).set({ status: 'CLOSED', closedAt: new Date(), closedBy: user.id }).where(eq(accounts.id, id));
        await audit(tx, { userId: user.id, action: 'account.close', entityType: 'account', entityId: id, message: `${user.name} encerrou a ${label(acc)} (total ${brl(t.total)}).` });
        status = 'CLOSED';
      }
      return { status, balance: newBalance };
    });
    notify.accountsChanged(id); notify.registerChanged();
    return out;
  });

  app.post('/api/accounts/:id/discounts', ops, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ amountCents: centsSchema, reason: reasonSchema }), req.body);
    const user = me(req);
    await db.transaction(async (tx) => {
      const acc = await getAccount(tx, id, true);
      assertAccountEditable(acc.status);
      const t = await accountTotals(tx, id);
      if (b.amountCents > t.balance) throw bad(`O desconto não pode ser maior que o saldo em aberto (${brl(t.balance)}).`);
      const reg = await currentRegister(tx);
      const kind = user.role === 'ADMIN' ? 'DISCOUNT' : 'ADJUSTMENT';
      await tx.insert(discounts).values({ accountId: id, kind, amountCents: b.amountCents, reason: b.reason, userId: user.id, cashRegisterId: reg?.id ?? null });
      await audit(tx, {
        userId: user.id, action: 'discount.create', entityType: 'account', entityId: id,
        message: `${user.name} concedeu ${kind === 'DISCOUNT' ? 'desconto' : 'ajuste'} de ${brl(b.amountCents)} na ${label(acc)}. Motivo: ${b.reason}`,
      });
      await recomputeStatus(tx, id);
    });
    notify.accountsChanged(id); notify.registerChanged();
    return { ok: true };
  });

  // Cliente saiu sem pagar → PENDENTE (exige nome + contato)
  app.post('/api/accounts/:id/pending', ops, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({
      customerName: z.string().trim().min(2, 'informe o nome do cliente').max(80),
      contact: z.string().trim().min(2, 'informe casa ou telefone').max(120),
      note: optText(200),
    }), req.body);
    const user = me(req);
    await db.transaction(async (tx) => {
      const acc = await getAccount(tx, id, true);
      if (!['OPEN', 'PARTIALLY_PAID'].includes(acc.status)) throw conflict('Só contas abertas com saldo podem virar pendentes.');
      const t = await accountTotals(tx, id);
      if (t.balance <= 0) throw conflict('Esta conta não tem saldo em aberto.');
      await tx.update(accounts).set({
        status: 'PENDING', customerName: b.customerName, contact: b.contact, note: b.note ?? acc.note,
        pendingAt: new Date(), pendingBy: user.id,
      }).where(eq(accounts.id, id));
      await audit(tx, {
        userId: user.id, action: 'account.pending', entityType: 'account', entityId: id,
        message: `${user.name} marcou a conta #${acc.number} (${b.customerName}, ${b.contact}) como PENDENTE — saldo ${brl(t.balance)}.`,
      });
    });
    notify.accountsChanged(id); notify.registerChanged();
    return { ok: true };
  });

  app.post('/api/accounts/:id/close', ops, async (req) => {
    const { id } = parse(idParam, req.params);
    const user = me(req);
    await db.transaction(async (tx) => {
      const acc = await getAccount(tx, id, true);
      assertAccountEditable(acc.status);
      const t = await accountTotals(tx, id);
      if (t.total <= 0) throw conflict('Conta sem valor. Se nada foi consumido, cancele a conta.');
      if (t.balance !== 0) throw conflict(`Ainda há saldo de ${brl(t.balance)}. Receba o pagamento ou marque como pendente.`);
      await tx.update(accounts).set({ status: 'CLOSED', closedAt: new Date(), closedBy: user.id }).where(eq(accounts.id, id));
      await audit(tx, { userId: user.id, action: 'account.close', entityType: 'account', entityId: id, message: `${user.name} encerrou a ${label(acc)} (total ${brl(t.total)}).` });
    });
    notify.accountsChanged(id);
    return { ok: true };
  });

  app.post('/api/accounts/:id/reopen', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: reasonSchema }), req.body);
    const user = me(req);
    await db.transaction(async (tx) => {
      const acc = await getAccount(tx, id, true);
      if (!['CLOSED', 'PENDING'].includes(acc.status)) throw conflict('Só contas encerradas ou pendentes podem ser reabertas.');
      await tx.update(accounts).set({ status: 'OPEN', closedAt: null, closedBy: null }).where(eq(accounts.id, id));
      await recomputeStatus(tx, id);
      await audit(tx, { userId: user.id, action: 'account.reopen', entityType: 'account', entityId: id, message: `${user.name} reabriu a ${label(acc)} (estava ${acc.status === 'CLOSED' ? 'ENCERRADA' : 'PENDENTE'}). Motivo: ${reason}` });
    });
    notify.accountsChanged(id);
    return { ok: true };
  });

  app.post('/api/accounts/:id/cancel', ops, async (req) => {
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: reasonSchema }), req.body);
    const user = me(req);
    await db.transaction(async (tx) => {
      const acc = await getAccount(tx, id, true);
      assertAccountEditable(acc.status);
      const t = await accountTotals(tx, id);
      if (t.paid > 0) throw conflict('Esta conta já tem pagamentos. Peça ao administrador para estornar antes de cancelar.');
      const ords = await tx.select().from(orders).where(eq(orders.accountId, id));
      const reg = await currentRegister(tx);
      let lost = false;
      for (const o of ords) {
        if (o.status === 'CANCELLED') continue;
        if (['IN_PREPARATION', 'READY', 'DELIVERED'].includes(o.status)) lost = true;
        await tx.update(orderItems).set({ status: 'CANCELLED' }).where(and(eq(orderItems.orderId, o.id), eq(orderItems.status, 'ACTIVE')));
        await tx.update(orders).set({ status: 'CANCELLED' }).where(eq(orders.id, o.id));
      }
      await tx.update(accounts).set({ status: 'CANCELLED', closedAt: new Date(), closedBy: user.id }).where(eq(accounts.id, id));
      await tx.insert(cancellations).values({
        target: 'ACCOUNT', accountId: id, description: `Conta #${acc.number}`, amountCents: t.subtotal,
        wasInPreparation: lost, reason, userId: user.id, cashRegisterId: reg?.id ?? null,
      });
      await audit(tx, { userId: user.id, action: 'account.cancel', entityType: 'account', entityId: id, message: `${user.name} cancelou a ${label(acc)} (${brl(t.subtotal)}). Motivo: ${reason}` });
    });
    notify.kitchenCancelled({ message: 'Uma conta foi cancelada' });
    notify.ordersChanged(); notify.accountsChanged(id); notify.registerChanged();
    return { ok: true };
  });

  // ----- Cancelamentos de item e de pedido -----
  const LOSS_STATUSES = ['IN_PREPARATION', 'READY', 'DELIVERED'];

  app.post('/api/order-items/:id/cancel', ops, async (req) => {
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: reasonSchema }), req.body);
    const user = me(req);
    const info = await db.transaction(async (tx) => {
      const [it] = await tx.select().from(orderItems).where(eq(orderItems.id, id)).for('update');
      if (!it) throw notFound('Item não encontrado.');
      if (it.status === 'CANCELLED') throw conflict('Item já cancelado.');
      const { o, acc } = await orderWithAccount(tx, it.orderId, true);
      assertAccountEditable(acc.status);
      const value = it.unitPriceCents * it.quantity;
      const t = await accountTotals(tx, acc.id);
      if (t.total - value < t.paid) throw conflict('O valor já pago ficaria maior que o total. Peça ao administrador para estornar um pagamento antes.');
      const lost = LOSS_STATUSES.includes(o.status);
      await tx.update(orderItems).set({ status: 'CANCELLED' }).where(eq(orderItems.id, id));
      const reg = await currentRegister(tx);
      await tx.insert(cancellations).values({
        target: 'ITEM', accountId: acc.id, orderId: o.id, orderItemId: id,
        description: `${it.quantity}× ${it.productName}`, amountCents: value, wasInPreparation: lost,
        reason, userId: user.id, cashRegisterId: reg?.id ?? null,
      });
      const [{ n }] = (await tx.execute(sql`SELECT COUNT(*)::int AS n FROM order_items WHERE order_id = ${o.id} AND status = 'ACTIVE'`)).rows as { n: number }[];
      if (Number(n) === 0) await tx.update(orders).set({ status: 'CANCELLED' }).where(eq(orders.id, o.id));
      await audit(tx, {
        userId: user.id, action: 'item.cancel', entityType: 'order', entityId: o.id,
        message: `${user.name} cancelou ${it.quantity}× ${it.productName} (${brl(value)}) do pedido #${o.number}, ${label(acc)}${lost ? ' — PERDA (já em preparo/entregue)' : ''}. Motivo: ${reason}`,
      });
      await recomputeStatus(tx, acc.id);
      return { o, acc, it };
    });
    if (info.it.goesToKitchen && ['CONFIRMED', 'IN_PREPARATION', 'READY'].includes(info.o.status)) {
      notify.kitchenCancelled({ message: `Pedido #${info.o.number}: ${info.it.quantity}× ${info.it.productName} CANCELADO` });
    }
    notify.ordersChanged(); notify.accountsChanged(info.acc.id); notify.registerChanged();
    return { ok: true };
  });

  app.post('/api/orders/:id/cancel', ops, async (req) => {
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: reasonSchema }), req.body);
    const user = me(req);
    const info = await db.transaction(async (tx) => {
      const { o, acc } = await orderWithAccount(tx, id, true);
      assertAccountEditable(acc.status);
      if (o.status === 'CANCELLED') throw conflict('Pedido já cancelado.');
      const items = await tx.select().from(orderItems).where(and(eq(orderItems.orderId, id), eq(orderItems.status, 'ACTIVE')));
      const value = items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0);
      const t = await accountTotals(tx, acc.id);
      const counted = o.status === 'AWAITING_CONFIRMATION' ? 0 : value;
      if (t.total - counted < t.paid) throw conflict('O valor já pago ficaria maior que o total. Peça ao administrador para estornar um pagamento antes.');
      const lost = LOSS_STATUSES.includes(o.status);
      await tx.update(orderItems).set({ status: 'CANCELLED' }).where(and(eq(orderItems.orderId, id), eq(orderItems.status, 'ACTIVE')));
      await tx.update(orders).set({ status: 'CANCELLED' }).where(eq(orders.id, id));
      const reg = await currentRegister(tx);
      await tx.insert(cancellations).values({
        target: 'ORDER', accountId: acc.id, orderId: id,
        description: `Pedido #${o.number}: ${items.map((i) => `${i.quantity}× ${i.productName}`).join(', ')}`,
        amountCents: counted, wasInPreparation: lost, reason, userId: user.id, cashRegisterId: reg?.id ?? null,
      });
      await audit(tx, {
        userId: user.id, action: 'order.cancel', entityType: 'order', entityId: id,
        message: `${user.name} cancelou o pedido #${o.number} (${brl(value)}) da ${label(acc)}${lost ? ' — PERDA (já em preparo/entregue)' : ''}. Motivo: ${reason}`,
      });
      // Pedido de QR recusado numa conta sem mais nada: a conta também é cancelada
      if (o.origin === 'QR_CODE' && o.status === 'AWAITING_CONFIRMATION') {
        const [{ n }] = (await tx.execute(sql`SELECT COUNT(*)::int AS n FROM orders WHERE account_id = ${acc.id} AND status <> 'CANCELLED'`)).rows as { n: number }[];
        if (Number(n) === 0 && t.paid === 0) {
          await tx.update(accounts).set({ status: 'CANCELLED', closedAt: new Date(), closedBy: user.id }).where(eq(accounts.id, acc.id));
        }
      }
      await recomputeStatus(tx, acc.id);
      return { o, acc };
    });
    if (info.o.goesToKitchen && ['CONFIRMED', 'IN_PREPARATION', 'READY'].includes(info.o.status)) {
      notify.kitchenCancelled({ message: `Pedido #${info.o.number} CANCELADO` });
    }
    notify.ordersChanged(); notify.accountsChanged(info.acc.id); notify.registerChanged();
    return { ok: true };
  });

  app.post('/api/orders/:id/deliver', ops, async (req) => {
    const { id } = parse(idParam, req.params);
    const user = me(req);
    const acc = await db.transaction(async (tx) => {
      const { o, acc } = await orderWithAccount(tx, id, true);
      if (o.status !== 'READY') throw conflict('Só pedidos prontos podem ser marcados como entregues.');
      await tx.update(orders).set({ status: 'DELIVERED', deliveredAt: new Date(), deliveredBy: user.id, problemNote: null }).where(eq(orders.id, id));
      await audit(tx, { userId: user.id, action: 'order.deliver', entityType: 'order', entityId: id, message: `${user.name} entregou o pedido #${o.number} da ${label(acc)}.` });
      return acc;
    });
    notify.ordersChanged(); notify.accountsChanged(acc.id);
    return { ok: true };
  });

  app.post('/api/orders/:id/clear-problem', ops, async (req) => {
    const { id } = parse(idParam, req.params);
    const user = me(req);
    await db.transaction(async (tx) => {
      const { o, acc } = await orderWithAccount(tx, id, true);
      if (!o.problemNote) return;
      await tx.update(orders).set({ problemNote: null }).where(eq(orders.id, id));
      await audit(tx, { userId: user.id, action: 'order.problem.clear', entityType: 'order', entityId: id, message: `${user.name} resolveu o problema do pedido #${o.number} (${label(acc)}): "${o.problemNote}".` });
    });
    notify.ordersChanged();
    return { ok: true };
  });

  // Confirmação de pedido vindo do QR Code
  app.post('/api/orders/:id/confirm', ops, async (req) => {
    const { id } = parse(idParam, req.params);
    const user = me(req);
    const r = await db.transaction(async (tx) => {
      const { o, acc } = await orderWithAccount(tx, id, true);
      if (o.status !== 'AWAITING_CONFIRMATION') throw conflict('Este pedido não está aguardando confirmação.');
      const reg = await requireOpenRegister(tx);
      const now = new Date();
      const status = o.goesToKitchen ? 'CONFIRMED' : 'DELIVERED';
      await tx.update(orders).set({
        status, confirmedAt: now, confirmedBy: user.id, cashRegisterId: reg.id,
        deliveredAt: status === 'DELIVERED' ? now : null, deliveredBy: status === 'DELIVERED' ? user.id : null,
      }).where(eq(orders.id, id));
      if (!acc.cashRegisterId) await tx.update(accounts).set({ cashRegisterId: reg.id, openedBy: user.id }).where(eq(accounts.id, acc.id));
      await audit(tx, { userId: user.id, action: 'order.confirm', entityType: 'order', entityId: id, message: `${user.name} confirmou o pedido #${o.number} (QR Code) da ${label(acc)}.` });
      await recomputeStatus(tx, acc.id);
      return { o, acc };
    });
    if (r.o.goesToKitchen) notify.kitchenNewOrder({ orderNumber: r.o.number, accountNumber: r.acc.number, sequence: r.o.sequence });
    notify.ordersChanged(); notify.accountsChanged(r.acc.id);
    return { ok: true };
  });

  // Estorno de pagamento (somente admin)
  app.post('/api/payments/:id/reverse', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: reasonSchema }), req.body);
    const user = me(req);
    const accId = await db.transaction(async (tx) => {
      const [p] = await tx.select().from(payments).where(eq(payments.id, id)).for('update');
      if (!p) throw notFound('Pagamento não encontrado.');
      if (p.reversedAt) throw conflict('Pagamento já estornado.');
      const acc = await getAccount(tx, p.accountId, true);
      if (acc.status === 'CLOSED') throw conflict('Reabra a conta antes de estornar um pagamento.');
      await tx.update(payments).set({ reversedAt: new Date(), reversedBy: user.id, reversalReason: reason }).where(eq(payments.id, id));
      await audit(tx, { userId: user.id, action: 'payment.reverse', entityType: 'account', entityId: acc.id, message: `${user.name} estornou o pagamento de ${brl(p.amountCents)} da ${label(acc)}. Motivo: ${reason}` });
      await recomputeStatus(tx, acc.id);
      return acc.id;
    });
    notify.accountsChanged(accId); notify.registerChanged();
    return { ok: true };
  });

}
