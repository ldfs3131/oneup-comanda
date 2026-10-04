import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db, nextNumber } from '../db/index.js';
import { accounts, cancellations, cashRegisters, customers, discounts, optionGroups, options, orderItems, orders, paymentMethods, payments, products, restaurantSettings, users, } from '../db/schema.js';
import { HttpError, bad, conflict, notFound } from '../lib/http.js';
import { applyStockForSale } from './stock.js';
export const LIVE_ACCOUNT = ['OPEN', 'PARTIALLY_PAID', 'PAID'];
export const DEFAULT_PREP = 15;
/**
 * Caixa aberto. Dentro de uma transação, o caixa fica PRESO até ela terminar: o fechamento espera os
 * pagamentos/pedidos em andamento entrarem no resumo, e quem chega depois do fechamento recebe "dia não aberto".
 * modo 'fechar' (só o fechamento) prende com exclusividade.
 */
export async function currentRegister(tx, modo = 'auto') {
    const q = tx.select().from(cashRegisters).where(eq(cashRegisters.status, 'OPEN')).limit(1);
    const r = modo === 'fechar' ? await q.for('update') : tx !== db ? await q.for('key share') : await q;
    return r[0] ?? null;
}
export async function requireOpenRegister(tx, modo = 'auto') {
    const r = await currentRegister(tx, modo);
    if (!r)
        throw conflict('O dia ainda não foi aberto. Clique em "Abrir o dia" (caixa) antes de continuar.');
    return r;
}
/** Pedidos novos só com o dia aberto: caixa aberto + estabelecimento ABERTO. */
export async function requireTakingOrders(tx) {
    const reg = await requireOpenRegister(tx);
    const [s] = await tx.select({ isOpen: restaurantSettings.isOpen }).from(restaurantSettings).limit(1);
    if (!s?.isOpen)
        throw conflict('Estabelecimento FECHADO: não é possível lançar pedidos. Reabra os pedidos para continuar.');
    return reg;
}
export async function getAccount(tx, id, lock = false) {
    const q = tx.select().from(accounts).where(eq(accounts.id, id));
    const r = lock ? await q.for('update') : await q;
    if (!r[0])
        throw notFound('Conta não encontrada.');
    return r[0];
}
/**
 * Escopo do caixa: só a operação do dia (desde a abertura do caixa atual),
 * as contas vivas e as pendentes. Admin vê tudo.
 */
export async function assertAccountInScope(tx, user, acc) {
    if (user.role === 'ADMIN')
        return;
    if (['OPEN', 'PARTIALLY_PAID', 'PAID', 'PENDING'].includes(acc.status))
        return;
    const reg = await currentRegister(tx);
    if (reg) {
        if (acc.cashRegisterId === reg.id)
            return;
        if (acc.closedAt && acc.closedAt >= reg.openedAt)
            return;
        if (acc.openedAt >= reg.openedAt)
            return;
    }
    throw new HttpError(403, 'Esta conta é de um dia anterior. Consulte o Dono.');
}
export async function accountTotals(tx, accountId) {
    const r = await tx.execute(sql `
    SELECT
      COALESCE((SELECT SUM(oi.unit_price_cents * oi.quantity) FROM order_items oi
                JOIN orders o ON o.id = oi.order_id
                WHERE o.account_id = ${accountId} AND oi.status = 'ACTIVE'
                  AND o.status <> 'AWAITING_CONFIRMATION'), 0) AS subtotal,
      COALESCE((SELECT SUM(amount_cents) FROM discounts WHERE account_id = ${accountId}), 0) AS discounts,
      COALESCE((SELECT SUM(amount_cents) FROM payments WHERE account_id = ${accountId} AND reversed_at IS NULL), 0) AS paid`);
    const row = r.rows[0];
    const subtotal = Number(row.subtotal), disc = Number(row.discounts), paid = Number(row.paid);
    const total = subtotal - disc;
    return { subtotal, discounts: disc, total, paid, balance: total - paid };
}
/** Recalcula o status financeiro de uma conta viva (não mexe em ENCERRADA/CANCELADA/JUNTADA). */
export async function recomputeStatus(tx, accountId) {
    const acc = await getAccount(tx, accountId);
    if (acc.status === 'CLOSED' || acc.status === 'CANCELLED' || acc.status === 'MERGED')
        return acc.status;
    const t = await accountTotals(tx, accountId);
    let status;
    if (acc.status === 'PENDING')
        status = t.balance <= 0 && t.total > 0 ? 'PAID' : 'PENDING';
    else if (t.total > 0 && t.balance <= 0)
        status = 'PAID';
    else if (t.paid > 0)
        status = 'PARTIALLY_PAID';
    else
        status = 'OPEN';
    if (status !== acc.status)
        await tx.update(accounts).set({ status }).where(eq(accounts.id, accountId));
    return status;
}
export function assertAccountEditable(status) {
    if (status === 'CLOSED')
        throw conflict('Conta encerrada. Peça ao Dono para reabrir.');
    if (status === 'CANCELLED')
        throw conflict('Conta cancelada.');
    if (status === 'MERGED')
        throw conflict('Esta conta foi juntada a outra. Use a conta de destino.');
}
// ---------- Cliente (cadastro leve) ----------
export async function upsertCustomer(tx, name, contact, phone) {
    const n = name?.trim();
    if (!n || (!contact?.trim() && !phone?.trim()))
        return null;
    const found = await tx.execute(sql `
    SELECT id FROM customers
    WHERE lower(name) = lower(${n})
      AND (${contact?.trim() || null}::text IS NULL OR lower(coalesce(contact,'')) = lower(${contact?.trim() || ''}))
      AND (${phone?.trim() || null}::text IS NULL OR coalesce(phone,'') = ${phone?.trim() || ''})
    ORDER BY id LIMIT 1`);
    const row = found.rows[0];
    if (row) {
        await tx.update(customers).set({ contact: contact?.trim() || undefined, phone: phone?.trim() || undefined, updatedAt: new Date() }).where(eq(customers.id, row.id));
        return row.id;
    }
    const [c] = await tx.insert(customers).values({ name: n, contact: contact?.trim() || null, phone: phone?.trim() || null }).returning({ id: customers.id });
    return c.id;
}
export async function priceItems(tx, items) {
    if (!items.length)
        throw bad('Adicione ao menos um produto.');
    const productIds = [...new Set(items.filter((i) => i.productId).map((i) => i.productId))];
    const prods = productIds.length ? await tx.select().from(products).where(inArray(products.id, productIds)) : [];
    const groups = productIds.length
        ? await tx.select().from(optionGroups).where(and(inArray(optionGroups.productId, productIds), eq(optionGroups.active, true)))
        : [];
    const groupIds = groups.map((g) => g.id);
    const opts = groupIds.length
        ? await tx.select().from(options).where(and(inArray(options.groupId, groupIds), eq(options.active, true)))
        : [];
    return items.map((it) => {
        if (it.custom) {
            const desc = it.custom.description.trim();
            if (desc.length < 2)
                throw bad('Descreva o item "Outro / Adicional" (ex.: Queijo extra).');
            if (!Number.isInteger(it.custom.priceCents) || it.custom.priceCents <= 0)
                throw bad('Informe o valor do item "Outro / Adicional".');
            return {
                productId: null, productName: desc, unitPriceCents: it.custom.priceCents, quantity: it.quantity,
                optionsSnapshot: [], note: it.note?.trim() || null, goesToKitchen: !!it.custom.goesToKitchen,
                isCustom: true, unitCostCents: null, prepMinutes: DEFAULT_PREP, stock: [],
            };
        }
        const p = prods.find((x) => x.id === it.productId);
        if (!p || !p.active)
            throw bad('Produto não encontrado ou inativo.');
        if (!p.available)
            throw conflict(`"${p.name}" está indisponível (acabou).`);
        if (p.priceCents <= 0)
            throw conflict(`"${p.name}" está sem preço cadastrado.`);
        const pGroups = groups.filter((g) => g.productId === p.id);
        const chosen = [...new Set(it.optionIds ?? [])].map((oid) => {
            const o = opts.find((x) => x.id === oid);
            const g = o && pGroups.find((x) => x.id === o.groupId);
            if (!o || !g)
                throw bad(`Opção inválida para "${p.name}".`);
            if (!o.available)
                throw conflict(`Opção "${o.name}" está indisponível.`);
            return { o, g };
        });
        for (const g of pGroups) {
            const n = chosen.filter((c) => c.g.id === g.id).length;
            const hasOpts = opts.some((o) => o.groupId === g.id);
            if (g.required && hasOpts && n === 0)
                throw bad(`Escolha "${g.name}" para "${p.name}".`);
            if (!g.multiple && n > 1)
                throw bad(`Escolha apenas uma opção em "${g.name}".`);
        }
        chosen.sort((a, b) => a.g.sortOrder - b.g.sortOrder || a.o.sortOrder - b.o.sortOrder);
        const snapshot = chosen.map((c) => ({ group: c.g.name, name: c.o.name, priceDeltaCents: c.o.priceDeltaCents, stockProductId: c.o.stockProductId }));
        const unit = p.priceCents + snapshot.reduce((s, c) => s + c.priceDeltaCents, 0);
        const stock = [];
        if (p.trackStock)
            stock.push({ productId: p.id, perUnit: 1 });
        for (const c of chosen)
            if (c.o.stockProductId)
                stock.push({ productId: c.o.stockProductId, perUnit: 1 });
        return {
            productId: p.id, productName: p.name, unitPriceCents: unit, quantity: it.quantity, optionsSnapshot: snapshot,
            note: it.note?.trim() || null, goesToKitchen: p.sendsToKitchen, isCustom: false,
            unitCostCents: p.costCents ?? null, prepMinutes: p.prepMinutes ?? DEFAULT_PREP, stock,
        };
    });
}
export function stockNeeds(priced) {
    const needs = [];
    priced.forEach((p, i) => p.stock.forEach((s) => needs.push({ productId: s.productId, qty: s.perUnit * p.quantity, itemIndex: i })));
    return needs;
}
/** Previsão de pronto: tempo padrão do pedido + 3 min por pedido já na fila da cozinha (máx. +30). */
export async function estimateReady(tx, expectedMinutes) {
    const r = await tx.execute(sql `SELECT COUNT(*)::int AS n FROM orders WHERE goes_to_kitchen AND status IN ('CONFIRMED','IN_PREPARATION')`);
    const queue = Number(r.rows[0].n);
    return new Date(Date.now() + (expectedMinutes + Math.min(30, queue * 3)) * 60_000);
}
export async function insertOrder(tx, a) {
    const priced = await priceItems(tx, a.items);
    const goesToKitchen = priced.some((p) => p.goesToKitchen);
    const kitchenItems = priced.filter((p) => p.goesToKitchen);
    const expectedMinutes = kitchenItems.length ? Math.max(...kitchenItems.map((p) => p.prepMinutes)) : null;
    const [{ n }] = (await tx.execute(sql `SELECT COUNT(*)::int AS n FROM orders WHERE account_id = ${a.accountId}`)).rows;
    const number = await nextNumber(tx, 'order');
    const now = new Date();
    const awaiting = a.origin === 'QR_CODE';
    const status = awaiting ? 'AWAITING_CONFIRMATION' : goesToKitchen ? 'CONFIRMED' : 'DELIVERED';
    const expectedReadyAt = !awaiting && goesToKitchen && expectedMinutes ? await estimateReady(tx, expectedMinutes) : null;
    const [order] = await tx.insert(orders).values({
        number,
        accountId: a.accountId,
        sequence: Number(n) + 1,
        origin: a.origin,
        status,
        goesToKitchen,
        consumptionType: a.consumptionType ?? 'LOCAL',
        expectedMinutes,
        expectedReadyAt,
        note: a.note?.trim() || null,
        cashRegisterId: a.cashRegisterId,
        createdBy: a.userId,
        confirmedAt: awaiting ? null : now,
        confirmedBy: awaiting ? null : a.userId,
        deliveredAt: status === 'DELIVERED' ? now : null,
        deliveredBy: status === 'DELIVERED' ? a.userId : null,
    }).returning();
    const inserted = await tx.insert(orderItems).values(priced.map((p) => ({
        orderId: order.id, productId: p.productId, productName: p.productName, unitPriceCents: p.unitPriceCents,
        quantity: p.quantity, optionsSnapshot: p.optionsSnapshot, note: p.note, goesToKitchen: p.goesToKitchen,
        isCustom: p.isCustom, unitCostCents: p.unitCostCents,
    }))).returning({ id: orderItems.id });
    // Estoque baixa só na confirmação (pedido do caixa já nasce confirmado; QR baixa quando o caixa confirmar)
    if (!awaiting) {
        await applyStockForSale(tx, stockNeeds(priced), inserted.map((i) => i.id), a.stockDecisions, a.userId, `Pedido #${number}`);
    }
    const totalCents = priced.reduce((s, p) => s + p.unitPriceCents * p.quantity, 0);
    return { order, totalCents, itemCount: priced.reduce((s, p) => s + p.quantity, 0) };
}
/** Recalcula as necessidades de estoque de um pedido já gravado (confirmação de QR Code). */
export async function stockNeedsForOrder(tx, orderId) {
    const items = await tx.select().from(orderItems).where(and(eq(orderItems.orderId, orderId), eq(orderItems.status, 'ACTIVE'))).orderBy(asc(orderItems.id));
    const pids = [...new Set(items.filter((i) => i.productId).map((i) => i.productId))];
    const prods = pids.length ? await tx.select({ id: products.id, trackStock: products.trackStock }).from(products).where(inArray(products.id, pids)) : [];
    const needs = [];
    items.forEach((it, idx) => {
        if (it.productId && prods.find((p) => p.id === it.productId)?.trackStock)
            needs.push({ productId: it.productId, qty: it.quantity, itemIndex: idx });
        for (const o of it.optionsSnapshot) {
            if (o.stockProductId)
                needs.push({ productId: o.stockProductId, qty: it.quantity, itemIndex: idx });
        }
    });
    return { needs, itemIds: items.map((i) => i.id) };
}
// ---------- Situação por pedido (pago / parcial / pendente) ----------
/** Distribui descontos e pagamentos pelos pedidos na ordem em que foram feitos. Não altera nenhum valor. */
export function allocateOrders(ordersList, discountsCents, paidCents) {
    let credit = discountsCents + paidCents;
    const out = new Map();
    for (const o of ordersList) {
        if (o.status === 'CANCELLED' || o.status === 'AWAITING_CONFIRMATION' || o.totalCents <= 0) {
            out.set(o.id, { situation: '—', coveredCents: 0 });
            continue;
        }
        const cover = Math.min(credit, o.totalCents);
        credit -= cover;
        out.set(o.id, { situation: cover >= o.totalCents ? 'PAGO' : cover > 0 ? 'PARCIAL' : 'PENDENTE', coveredCents: cover });
    }
    return out;
}
// ---------- Leitura detalhada da conta ----------
export async function accountDetail(tx, id) {
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
        totalBeforeCents: discounts.totalBeforeCents, totalAfterCents: discounts.totalAfterCents,
        createdAt: discounts.createdAt, userName: users.name,
    }).from(discounts).innerJoin(users, eq(users.id, discounts.userId))
        .where(eq(discounts.accountId, id)).orderBy(asc(discounts.id));
    const cancels = await tx.select({
        id: cancellations.id, target: cancellations.target, description: cancellations.description,
        amountCents: cancellations.amountCents, reason: cancellations.reason, wasInPreparation: cancellations.wasInPreparation,
        quantity: cancellations.quantity, stockReturned: cancellations.stockReturned,
        createdAt: cancellations.createdAt, userName: users.name, orderId: cancellations.orderId, orderItemId: cancellations.orderItemId,
    }).from(cancellations).innerJoin(users, eq(users.id, cancellations.userId))
        .where(eq(cancellations.accountId, id)).orderBy(asc(cancellations.id));
    const itemTotal = (oid) => items.filter((i) => i.orderId === oid && i.status === 'ACTIVE').reduce((s, i) => s + i.unitPriceCents * i.quantity, 0);
    const alloc = allocateOrders(ords.map((o) => ({ id: o.id, status: o.status, totalCents: itemTotal(o.id) })), totals.discounts, totals.paid);
    const cancelByItem = new Map(cancels.filter((c) => c.orderItemId).map((c) => [c.orderItemId, c]));
    const merged = acc.mergedInto ? await tx.select({ id: accounts.id, number: accounts.number }).from(accounts).where(eq(accounts.id, acc.mergedInto)) : [];
    return {
        ...acc,
        mergedIntoNumber: merged[0]?.number ?? null,
        totals,
        orders: ords.map((o) => ({
            ...o,
            totalCents: itemTotal(o.id),
            situation: alloc.get(o.id)?.situation ?? '—',
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
export async function listAccountsWithTotals(tx, where, limit = 200) {
    const r = await tx.execute(sql `
    SELECT a.*, t.subtotal, t.discounts, t.paid, (t.subtotal - t.discounts) AS total,
           (t.subtotal - t.discounts - t.paid) AS balance,
           ou.name AS opened_by_name, pu.name AS pending_by_name, cu.name AS cobranca_por_name,
           to_char(a.promised_date, 'YYYY-MM-DD') AS promised_str,
           (SELECT COUNT(*) FROM orders o WHERE o.account_id = a.id AND o.status IN ('CONFIRMED','IN_PREPARATION')) AS in_kitchen,
           (SELECT COUNT(*) FROM orders o WHERE o.account_id = a.id AND o.status = 'READY') AS ready,
           (SELECT MAX(o.created_at) FROM orders o WHERE o.account_id = a.id) AS last_order_at,
           (SELECT MIN(o.expected_ready_at) FROM orders o WHERE o.account_id = a.id AND o.status IN ('CONFIRMED','IN_PREPARATION')) AS next_ready_at
    FROM accounts a
    LEFT JOIN users ou ON ou.id = a.opened_by
    LEFT JOIN users pu ON pu.id = a.pending_by
    LEFT JOIN users cu ON cu.id = a.ultima_cobranca_por
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
    return r.rows.map((row) => ({
        id: row.id, number: row.number, customerName: row.customer_name, note: row.note, contact: row.contact,
        phone: row.phone, tableLabel: row.table_label,
        status: row.status, origin: row.origin, openedAt: row.opened_at, closedAt: row.closed_at, pendingAt: row.pending_at,
        openedByName: row.opened_by_name, pendingByName: row.pending_by_name, customerId: row.customer_id,
        subtotal: Number(row.subtotal), discounts: Number(row.discounts), paid: Number(row.paid),
        total: Number(row.total), balance: Number(row.balance),
        inKitchen: Number(row.in_kitchen), ready: Number(row.ready), lastOrderAt: row.last_order_at, nextReadyAt: row.next_ready_at,
        promisedDate: row.promised_str ?? null,
        ultimaCobrancaEm: row.ultima_cobranca_em ?? null, ultimaCobrancaPor: row.cobranca_por_name ?? null,
    }));
}
