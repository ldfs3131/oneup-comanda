import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Executor } from '../db/index.js';
import { nextNumber } from '../db/index.js';
import {
  accounts, cancellations, cashRegisters, discounts, optionGroups, options, orderItems, orders,
  paymentMethods, payments, products, users,
} from '../db/schema.js';
import { bad, conflict, notFound } from '../lib/http.js';

export type AccountStatus = typeof accounts.$inferSelect['status'];
export const LIVE_ACCOUNT: AccountStatus[] = ['OPEN', 'PARTIALLY_PAID', 'PAID'];

export async function currentRegister(tx: Executor) {
  const r = await tx.select().from(cashRegisters).where(eq(cashRegisters.status, 'OPEN')).limit(1);
  return r[0] ?? null;
}
export async function requireOpenRegister(tx: Executor) {
  const r = await currentRegister(tx);
  if (!r) throw conflict('O caixa está fechado. Abra o caixa antes de continuar.');
  return r;
}

export async function getAccount(tx: Executor, id: number, lock = false) {
  const q = tx.select().from(accounts).where(eq(accounts.id, id));
  const r = lock ? await q.for('update') : await q;
  if (!r[0]) throw notFound('Conta não encontrada.');
  return r[0];
}

export async function accountTotals(tx: Executor, accountId: number) {
  const r = await tx.execute(sql`
    SELECT
      COALESCE((SELECT SUM(oi.unit_price_cents * oi.quantity) FROM order_items oi
                JOIN orders o ON o.id = oi.order_id
                WHERE o.account_id = ${accountId} AND oi.status = 'ACTIVE'
                  AND o.status <> 'AWAITING_CONFIRMATION'), 0) AS subtotal,
      COALESCE((SELECT SUM(amount_cents) FROM discounts WHERE account_id = ${accountId}), 0) AS discounts,
      COALESCE((SELECT SUM(amount_cents) FROM payments WHERE account_id = ${accountId} AND reversed_at IS NULL), 0) AS paid`);
  const row = r.rows[0] as { subtotal: number; discounts: number; paid: number };
  const subtotal = Number(row.subtotal), disc = Number(row.discounts), paid = Number(row.paid);
  const total = subtotal - disc;
  return { subtotal, discounts: disc, total, paid, balance: total - paid };
}

/** Recalcula o status financeiro de uma conta viva (não mexe em ENCERRADA/CANCELADA). */
export async function recomputeStatus(tx: Executor, accountId: number) {
  const acc = await getAccount(tx, accountId);
  if (acc.status === 'CLOSED' || acc.status === 'CANCELLED') return acc.status;
  const t = await accountTotals(tx, accountId);
  let status: AccountStatus;
  if (acc.status === 'PENDING') status = t.balance <= 0 && t.total > 0 ? 'PAID' : 'PENDING';
  else if (t.total > 0 && t.balance <= 0) status = 'PAID';
  else if (t.paid > 0) status = 'PARTIALLY_PAID';
  else status = 'OPEN';
  if (status !== acc.status) await tx.update(accounts).set({ status }).where(eq(accounts.id, accountId));
  return status;
}

export function assertAccountEditable(status: AccountStatus) {
  if (status === 'CLOSED') throw conflict('Conta encerrada. Peça ao administrador para reabrir.');
  if (status === 'CANCELLED') throw conflict('Conta cancelada.');
}

// ---------- Criação de pedido (caixa e QR Code) ----------
export type ItemInput = { productId: number; quantity: number; optionIds?: number[]; note?: string | null };

export async function priceItems(tx: Executor, items: ItemInput[]) {
  if (!items.length) throw bad('Adicione ao menos um produto.');
  const productIds = [...new Set(items.map((i) => i.productId))];
  const prods = await tx.select().from(products).where(inArray(products.id, productIds));
  const groups = await tx.select().from(optionGroups)
    .where(and(inArray(optionGroups.productId, productIds), eq(optionGroups.active, true)));
  const groupIds = groups.map((g) => g.id);
  const opts = groupIds.length
    ? await tx.select().from(options).where(and(inArray(options.groupId, groupIds), eq(options.active, true)))
    : [];

  return items.map((it) => {
    const p = prods.find((x) => x.id === it.productId);
    if (!p || !p.active) throw bad('Produto não encontrado ou inativo.');
    if (!p.available) throw conflict(`"${p.name}" está indisponível (acabou).`);
    const pGroups = groups.filter((g) => g.productId === p.id);
    const chosen = [...new Set(it.optionIds ?? [])].map((oid) => {
      const o = opts.find((x) => x.id === oid);
      const g = o && pGroups.find((x) => x.id === o.groupId);
      if (!o || !g) throw bad(`Opção inválida para "${p.name}".`);
      if (!o.available) throw conflict(`Opção "${o.name}" está indisponível.`);
      return { o, g };
    });
    for (const g of pGroups) {
      const n = chosen.filter((c) => c.g.id === g.id).length;
      if (g.required && n === 0) throw bad(`Escolha "${g.name}" para "${p.name}".`);
      if (!g.multiple && n > 1) throw bad(`Escolha apenas uma opção em "${g.name}".`);
    }
    chosen.sort((a, b) => a.g.sortOrder - b.g.sortOrder || a.o.sortOrder - b.o.sortOrder);
    const snapshot = chosen.map((c) => ({ group: c.g.name, name: c.o.name, priceDeltaCents: c.o.priceDeltaCents }));
    const unit = p.priceCents + snapshot.reduce((s, c) => s + c.priceDeltaCents, 0);
    return {
      productId: p.id,
      productName: p.name,
      unitPriceCents: unit,
      quantity: it.quantity,
      optionsSnapshot: snapshot,
      note: it.note?.trim() || null,
      goesToKitchen: p.sendsToKitchen,
    };
  });
}

export async function insertOrder(
  tx: Executor,
  a: {
    accountId: number; items: ItemInput[]; note?: string | null; userId: number | null;
    origin: 'CAIXA' | 'QR_CODE'; cashRegisterId: number | null;
  },
) {
  const priced = await priceItems(tx, a.items);
  const goesToKitchen = priced.some((p) => p.goesToKitchen);
  const [{ n }] = (await tx.execute(sql`SELECT COUNT(*)::int AS n FROM orders WHERE account_id = ${a.accountId}`)).rows as { n: number }[];
  const number = await nextNumber(tx, 'order');
  const now = new Date();
  const awaiting = a.origin === 'QR_CODE';
  const status = awaiting ? 'AWAITING_CONFIRMATION' : goesToKitchen ? 'CONFIRMED' : 'DELIVERED';
  const [order] = await tx.insert(orders).values({
    number,
    accountId: a.accountId,
    sequence: Number(n) + 1,
    origin: a.origin,
    status,
    goesToKitchen,
    note: a.note?.trim() || null,
    cashRegisterId: a.cashRegisterId,
    createdBy: a.userId,
    confirmedAt: awaiting ? null : now,
    confirmedBy: awaiting ? null : a.userId,
    deliveredAt: status === 'DELIVERED' ? now : null,
    deliveredBy: status === 'DELIVERED' ? a.userId : null,
  }).returning();
  await tx.insert(orderItems).values(priced.map((p) => ({ ...p, orderId: order.id })));
  const totalCents = priced.reduce((s, p) => s + p.unitPriceCents * p.quantity, 0);
  return { order, totalCents, itemCount: priced.reduce((s, p) => s + p.quantity, 0) };
}

// ---------- Leitura detalhada da conta ----------
export async function accountDetail(tx: Executor, id: number) {
  const acc = await getAccount(tx, id);
  const totals = await accountTotals(tx, id);
  const ords = await tx.select().from(orders).where(eq(orders.accountId, id)).orderBy(asc(orders.id));
  const items = ords.length
    ? await tx.select().from(orderItems).where(inArray(orderItems.orderId, ords.map((o) => o.id))).orderBy(asc(orderItems.id))
    : [];
  const pays = await tx.select({
    id: payments.id, amountCents: payments.amountCents, tenderedCents: payments.tenderedCents,
    method: paymentMethods.name, methodCode: paymentMethods.code, createdAt: payments.createdAt,
    userName: users.name, reversedAt: payments.reversedAt, reversalReason: payments.reversalReason,
  }).from(payments)
    .innerJoin(paymentMethods, eq(paymentMethods.id, payments.methodId))
    .innerJoin(users, eq(users.id, payments.userId))
    .where(eq(payments.accountId, id)).orderBy(asc(payments.id));
  const discs = await tx.select({
    id: discounts.id, kind: discounts.kind, amountCents: discounts.amountCents, reason: discounts.reason,
    createdAt: discounts.createdAt, userName: users.name,
  }).from(discounts).innerJoin(users, eq(users.id, discounts.userId))
    .where(eq(discounts.accountId, id)).orderBy(asc(discounts.id));
  const cancels = await tx.select({
    id: cancellations.id, target: cancellations.target, description: cancellations.description,
    amountCents: cancellations.amountCents, reason: cancellations.reason, wasInPreparation: cancellations.wasInPreparation,
    createdAt: cancellations.createdAt, userName: users.name, orderId: cancellations.orderId, orderItemId: cancellations.orderItemId,
  }).from(cancellations).innerJoin(users, eq(users.id, cancellations.userId))
    .where(eq(cancellations.accountId, id)).orderBy(asc(cancellations.id));

  const cancelByItem = new Map(cancels.filter((c) => c.orderItemId).map((c) => [c.orderItemId!, c]));
  return {
    ...acc,
    totals,
    orders: ords.map((o) => ({
      ...o,
      items: items.filter((i) => i.orderId === o.id).map((i) => ({
        ...i, cancellation: cancelByItem.get(i.id) ?? null,
      })),
    })),
    payments: pays,
    discounts: discs,
    cancellations: cancels,
  };
}

/** Lista de contas com totais calculados em uma só consulta. */
export async function listAccountsWithTotals(tx: Executor, where: ReturnType<typeof sql>, limit = 200) {
  const r = await tx.execute(sql`
    SELECT a.*, t.subtotal, t.discounts, t.paid, (t.subtotal - t.discounts) AS total,
           (t.subtotal - t.discounts - t.paid) AS balance,
           ou.name AS opened_by_name, pu.name AS pending_by_name,
           (SELECT COUNT(*) FROM orders o WHERE o.account_id = a.id AND o.status IN ('CONFIRMED','IN_PREPARATION')) AS in_kitchen,
           (SELECT COUNT(*) FROM orders o WHERE o.account_id = a.id AND o.status = 'READY') AS ready,
           (SELECT MAX(o.created_at) FROM orders o WHERE o.account_id = a.id) AS last_order_at
    FROM accounts a
    LEFT JOIN users ou ON ou.id = a.opened_by
    LEFT JOIN users pu ON pu.id = a.pending_by
    CROSS JOIN LATERAL (
      SELECT
        COALESCE((SELECT SUM(oi.unit_price_cents * oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                  WHERE o.account_id = a.id AND oi.status = 'ACTIVE' AND o.status <> 'AWAITING_CONFIRMATION'), 0) AS subtotal,
        COALESCE((SELECT SUM(amount_cents) FROM discounts d WHERE d.account_id = a.id), 0) AS discounts,
        COALESCE((SELECT SUM(amount_cents) FROM payments p WHERE p.account_id = a.id AND p.reversed_at IS NULL), 0) AS paid
    ) t
    WHERE ${where}
    ORDER BY a.id DESC
    LIMIT ${limit}`);
  return r.rows.map((row: any) => ({
    id: row.id, number: row.number, customerName: row.customer_name, note: row.note, contact: row.contact,
    status: row.status, origin: row.origin, openedAt: row.opened_at, closedAt: row.closed_at, pendingAt: row.pending_at,
    openedByName: row.opened_by_name, pendingByName: row.pending_by_name,
    subtotal: Number(row.subtotal), discounts: Number(row.discounts), paid: Number(row.paid),
    total: Number(row.total), balance: Number(row.balance),
    inKitchen: Number(row.in_kitchen), ready: Number(row.ready), lastOrderAt: row.last_order_at,
  }));
}

