import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { cashMovements, expenseCategories, expenses, orders, orderTimeCorrections } from '../db/schema.js';
import { me, requireRole } from '../auth.js';
import { bad, brl, centsSchema, conflict, idParam, notFound, parse, reasonSchema } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { notify } from '../realtime.js';
import { currentRegister, requireOpenRegister } from '../services/accounts.js';
import { rangeOf, todayLocal } from './admin.js';
import { ritmoDoMes } from '../services/ritmo.js';

const TZ = 'America/Sao_Paulo';
const n = (v: unknown) => Number(v ?? 0);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const inRange = (col: string, r: { from: string; to: string }) =>
  // intervalo de horário no fuso do restaurante (usa o índice empresa+data)
  sql`${sql.raw(col)} >= (${r.from}::date::timestamp AT TIME ZONE ${TZ}) AND ${sql.raw(col)} < ((${r.to}::date + 1)::timestamp AT TIME ZONE ${TZ})`;

export async function managementRoutes(app: FastifyInstance) {
  const admin = { preHandler: requireRole('ADMIN') };
  const ops = { preHandler: requireRole('CAIXA') };

  // =============== FINANCEIRO ===============
  app.get('/api/finance', admin, async (req) => {
    const r = rangeOf(parse(z.object({ from: dateSchema.optional(), to: dateSchema.optional() }), req.query));
    const q = async (s: ReturnType<typeof sql>) => (await db.execute(s)).rows as any[];
    const live = sql`o.status NOT IN ('AWAITING_CONFIRMATION','CANCELLED') AND oi.status = 'ACTIVE'`;
    const [sales] = await q(sql`
      SELECT COALESCE(SUM(oi.unit_price_cents*oi.quantity),0) AS gross,
             COALESCE(SUM(oi.unit_cost_cents*oi.quantity) FILTER (WHERE oi.unit_cost_cents IS NOT NULL),0) AS cost,
             COALESCE(SUM(oi.unit_price_cents*oi.quantity) FILTER (WHERE oi.unit_cost_cents IS NOT NULL),0) AS gross_with_cost
      FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE ${inRange('o.created_at', r)} AND ${live}`);
    const [disc] = await q(sql`SELECT COALESCE(SUM(amount_cents),0) AS cents FROM discounts WHERE ${inRange('created_at', r)}`);
    const received = await q(sql`
      SELECT pm.name, COALESCE(SUM(p.amount_cents),0) AS cents,
             COALESCE(ROUND(SUM(p.amount_cents::bigint * COALESCE(p.taxa_bp, pm.taxa_bp) / 10000.0)),0) AS fees, pm.taxa_bp AS "taxaBp"
      FROM payment_methods pm
      LEFT JOIN payments p ON p.method_id = pm.id AND p.reversed_at IS NULL AND ${inRange('p.created_at', r)}
      GROUP BY pm.id ORDER BY pm.sort_order`);
    const [recv] = await q(sql`
      SELECT
        COALESCE(SUM(bal) FILTER (WHERE status = 'PENDING'),0) AS pending,
        COALESCE(SUM(bal) FILTER (WHERE status IN ('OPEN','PARTIALLY_PAID')),0) AS open
      FROM (SELECT a.status,
        COALESCE((SELECT SUM(oi.unit_price_cents*oi.quantity) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.account_id=a.id AND oi.status='ACTIVE' AND o.status<>'AWAITING_CONFIRMATION'),0)
        - COALESCE((SELECT SUM(amount_cents) FROM discounts WHERE account_id=a.id),0)
        - COALESCE((SELECT SUM(amount_cents) FROM payments WHERE account_id=a.id AND reversed_at IS NULL),0) AS bal
        FROM accounts a WHERE a.status IN ('PENDING','OPEN','PARTIALLY_PAID')) x`);
    const exp = await q(sql`
      SELECT c.name, COALESCE(SUM(e.amount_cents),0) AS cents, COUNT(e.id) AS count
      FROM expenses e JOIN expense_categories c ON c.id = e.category_id
      WHERE e.cancelled_at IS NULL AND e.date BETWEEN ${r.from}::date AND ${r.to}::date
      GROUP BY c.name ORDER BY cents DESC`);
    const products = await q(sql`
      SELECT oi.product_id AS id, oi.product_name AS name, p.price_cents AS price, p.cost_cents AS "currentCost",
             SUM(oi.quantity) AS qty, SUM(oi.unit_price_cents*oi.quantity) AS revenue,
             SUM(oi.unit_cost_cents*oi.quantity) FILTER (WHERE oi.unit_cost_cents IS NOT NULL) AS cost,
             SUM(oi.quantity) FILTER (WHERE oi.unit_cost_cents IS NULL) AS qty_without_cost
      FROM orders o JOIN order_items oi ON oi.order_id = o.id LEFT JOIN products p ON p.id = oi.product_id
      WHERE ${inRange('o.created_at', r)} AND ${live}
      GROUP BY oi.product_id, oi.product_name, p.price_cents, p.cost_cents ORDER BY revenue DESC`);

    const gross = n(sales.gross), discounts = n(disc.cents), revenue = gross - discounts;
    const cost = n(sales.cost), coverage = gross > 0 ? n(sales.gross_with_cost) / gross : 0;
    const expensesTotal = exp.reduce((s, e) => s + n(e.cents), 0);
    const grossProfit = revenue - cost;
    const fees = received.reduce((s, x) => s + n(x.fees), 0);
    return {
      from: r.from, to: r.to,
      grossSalesCents: gross, discountsCents: discounts, revenueCents: revenue,
      receivedCents: received.reduce((s, x) => s + n(x.cents), 0),
      receivedByMethod: received.map((x) => ({ name: x.name, cents: n(x.cents), feesCents: n(x.fees), taxaBp: n(x.taxaBp) })),
      // taxas da maquininha: calculadas com a taxa de cada forma no dia do recebimento
      feesCents: fees, netReceivedCents: received.reduce((s, x) => s + n(x.cents), 0) - fees,
      pendingCents: n(recv.pending), openBalanceCents: n(recv.open),
      costCents: cost, costCoverage: coverage,
      grossProfitCents: grossProfit, grossMargin: revenue > 0 ? grossProfit / revenue : null,
      expensesCents: expensesTotal, expensesByCategory: exp.map((e) => ({ name: e.name, cents: n(e.cents), count: n(e.count) })),
      operatingResultCents: grossProfit - expensesTotal - fees,
      products: products.map((p) => ({
        id: p.id, name: p.name, priceCents: p.price == null ? null : n(p.price), currentCostCents: p.currentCost == null ? null : n(p.currentCost),
        unitMarginCents: p.price != null && p.currentCost != null ? n(p.price) - n(p.currentCost) : null,
        qty: n(p.qty), revenueCents: n(p.revenue), costCents: p.cost == null ? null : n(p.cost),
        marginCents: p.cost == null ? null : n(p.revenue) - n(p.cost), qtyWithoutCost: n(p.qty_without_cost),
      })),
    };
  });

  // =============== RITMO DO MÊS (mesma permissão do financeiro) ===============
  app.get('/api/finance/ritmo', admin, async (req) => {
    const q = parse(z.object({ mes: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(), modo: z.enum(['liquido', 'bruto']).default('liquido') }), req.query);
    return ritmoDoMes(db, { mes: q.mes, modo: q.modo, hoje: todayLocal() });
  });

  // =============== DESPESAS ===============
  app.get('/api/expense-categories', ops, async () =>
    db.select().from(expenseCategories).orderBy(asc(expenseCategories.sortOrder), asc(expenseCategories.name)));

  app.post('/api/expense-categories', admin, async (req) => {
    const { name } = parse(z.object({ name: z.string().trim().min(2).max(40) }), req.body);
    const [c] = await db.insert(expenseCategories).values({ name, sortOrder: 99 }).onConflictDoNothing().returning();
    if (!c) throw conflict('Já existe uma categoria com esse nome.');
    await audit(db, { userId: me(req).id, action: 'expense.category', message: `${me(req).name} criou a categoria de despesa "${name}".` });
    return c;
  });

  app.patch('/api/expense-categories/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({ name: z.string().trim().min(2).max(40).optional(), active: z.boolean().optional() }), req.body);
    const upd = await db.update(expenseCategories).set(b).where(eq(expenseCategories.id, id)).returning({ id: expenseCategories.id });
    if (!upd.length) throw notFound('Categoria não encontrada.');
    return { ok: true };
  });

  app.get('/api/expenses', admin, async (req) => {
    const r = rangeOf(parse(z.object({ from: dateSchema.optional(), to: dateSchema.optional() }), req.query));
    return (await db.execute(sql`
      SELECT e.id, e.description, e.amount_cents AS "amountCents", to_char(e.date,'YYYY-MM-DD') AS date, e.note,
             e.paid_from_register AS "paidFromRegister", e.cancelled_at AS "cancelledAt", e.cancel_reason AS "cancelReason",
             c.name AS "categoryName", u.name AS "userName", e.created_at AS "createdAt"
      FROM expenses e JOIN expense_categories c ON c.id = e.category_id JOIN users u ON u.id = e.user_id
      WHERE e.date BETWEEN ${r.from}::date AND ${r.to}::date ORDER BY e.date DESC, e.id DESC`)).rows;
  });

  /** Nova despesa. Caixa só lança despesa paga com o dinheiro da gaveta (vira sangria automática). */
  app.post('/api/expenses', ops, async (req) => {
    const b = parse(z.object({
      description: z.string().trim().min(2).max(120),
      categoryId: z.number().int().positive(),
      amountCents: centsSchema,
      date: dateSchema.optional(),
      note: z.string().trim().max(300).nullable().optional(),
      paidFromRegister: z.boolean().default(false),
    }), req.body);
    const user = me(req);
    if (user.role !== 'ADMIN' && !b.paidFromRegister) throw bad('O caixa só lança despesas pagas com o dinheiro da gaveta.');
    const date = user.role === 'ADMIN' ? (b.date ?? todayLocal()) : todayLocal();
    const res = await db.transaction(async (tx) => {
      const [cat] = await tx.select().from(expenseCategories).where(eq(expenseCategories.id, b.categoryId));
      if (!cat || !cat.active) throw bad('Categoria de despesa inválida.');
      let movementId: number | null = null;
      if (b.paidFromRegister) {
        const reg = await requireOpenRegister(tx);
        const [m] = await tx.insert(cashMovements).values({
          cashRegisterId: reg.id, type: 'SANGRIA', amountCents: b.amountCents, reason: `Despesa: ${b.description} (${cat.name})`, userId: user.id,
        }).returning({ id: cashMovements.id });
        movementId = m.id;
      }
      const [e] = await tx.insert(expenses).values({
        description: b.description, categoryId: b.categoryId, amountCents: b.amountCents, date, note: b.note || null,
        paidFromRegister: b.paidFromRegister, cashMovementId: movementId, userId: user.id,
      }).returning();
      await audit(tx, {
        userId: user.id, action: 'expense.create', entityType: 'expense', entityId: e.id,
        message: `${user.name} lançou despesa "${b.description}" (${cat.name}) de ${brl(b.amountCents)}${b.paidFromRegister ? ' paga com o dinheiro do caixa (sangria automática)' : ''}.`,
      });
      return e;
    });
    if (b.paidFromRegister) notify.registerChanged();
    return res;
  });

  app.post('/api/expenses/:id/cancel', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: reasonSchema }), req.body);
    const user = me(req);
    await db.transaction(async (tx) => {
      const [e] = await tx.select().from(expenses).where(eq(expenses.id, id)).for('update');
      if (!e) throw notFound('Despesa não encontrada.');
      if (e.cancelledAt) throw conflict('Despesa já cancelada.');
      await tx.update(expenses).set({ cancelledAt: new Date(), cancelledBy: user.id, cancelReason: reason }).where(eq(expenses.id, id));
      if (e.paidFromRegister && e.cashMovementId) {
        // devolve o dinheiro ao caixa (suprimento) se ele ainda estiver aberto
        const [mv] = await tx.select().from(cashMovements).where(eq(cashMovements.id, e.cashMovementId));
        const reg = await currentRegister(tx);
        if (reg && mv && mv.cashRegisterId === reg.id) {
          await tx.insert(cashMovements).values({ cashRegisterId: reg.id, type: 'SUPRIMENTO', amountCents: e.amountCents, reason: `Estorno da despesa "${e.description}"`, userId: user.id });
        }
      }
      await audit(tx, { userId: user.id, action: 'expense.cancel', entityType: 'expense', entityId: id, message: `${user.name} cancelou a despesa "${e.description}" (${brl(e.amountCents)}). Motivo: ${reason}` });
    });
    notify.registerChanged();
    return { ok: true };
  });

  // =============== TEMPO DE PREPARO ===============
  app.get('/api/timing', admin, async (req) => {
    const r = rangeOf(parse(z.object({ from: dateSchema.optional(), to: dateSchema.optional() }), req.query));
    const rows = (await db.execute(sql`
      SELECT o.id, o.number, o.status, o.expected_minutes AS expected,
             a.number AS account_number, a.customer_name,
             EXTRACT(EPOCH FROM (o.started_at - o.confirmed_at))/60 AS queue,
             EXTRACT(EPOCH FROM (o.ready_at - o.started_at))/60 AS prep,
             EXTRACT(EPOCH FROM (o.ready_at - o.confirmed_at))/60 AS kitchen,
             EXTRACT(EPOCH FROM (o.delivered_at - o.ready_at))/60 AS counter,
             EXTRACT(EPOCH FROM (o.delivered_at - o.created_at))/60 AS total,
             (o.started_at = o.ready_at) AS skipped_start,
             EXISTS (SELECT 1 FROM order_time_corrections c WHERE c.order_id = o.id) AS corrected,
             o.created_at, o.confirmed_at, o.started_at, o.ready_at, o.delivered_at
      FROM orders o JOIN accounts a ON a.id = o.account_id
      WHERE o.goes_to_kitchen AND o.status IN ('READY','DELIVERED') AND ${inRange('o.created_at', r)}
      ORDER BY o.id DESC`)).rows as any[];
    const isSuspect = (x: any) => !x.corrected && x.kitchen != null && Number(x.kitchen) > 3 * Number(x.expected ?? 15);
    const valid = rows.filter((x) => !isSuspect(x));
    const med = (vals: number[]) => { const s = vals.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b); if (!s.length) return null; const m = Math.floor(s.length / 2); return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 10) / 10; };
    const col = (k: string, filter?: (x: any) => boolean) => valid.filter((x) => x[k] != null && (!filter || filter(x))).map((x) => Number(x[k]));
    // abertos esquecidos: na cozinha há mais de 3× o tempo padrão
    const stuck = (await db.execute(sql`
      SELECT o.id, o.number, o.status, o.expected_minutes AS expected, a.number AS account_number, a.customer_name,
             EXTRACT(EPOCH FROM (now() - o.confirmed_at))/60 AS age
      FROM orders o JOIN accounts a ON a.id = o.account_id
      WHERE o.goes_to_kitchen AND o.status IN ('CONFIRMED','IN_PREPARATION')
        AND now() - o.confirmed_at > (3 * COALESCE(o.expected_minutes,15)) * interval '1 minute'
      ORDER BY o.confirmed_at`)).rows as any[];
    // por produto (28 dias) + sugestão de tempo padrão
    const perProduct = (await db.execute(sql`
      WITH k AS (
        SELECT o.id, EXTRACT(EPOCH FROM (o.ready_at - o.confirmed_at))/60 AS kitchen, o.expected_minutes
        FROM orders o WHERE o.goes_to_kitchen AND o.ready_at IS NOT NULL AND o.confirmed_at IS NOT NULL
          AND o.created_at > now() - interval '28 days'
          AND (EXTRACT(EPOCH FROM (o.ready_at - o.confirmed_at))/60 <= 3*COALESCE(o.expected_minutes,15)
               OR EXISTS (SELECT 1 FROM order_time_corrections c WHERE c.order_id = o.id))
      )
      SELECT p.id, p.name, p.prep_minutes AS "prepMinutes",
             percentile_cont(0.5) WITHIN GROUP (ORDER BY k.kitchen) AS median, COUNT(DISTINCT k.id) AS n
      FROM k JOIN order_items oi ON oi.order_id = k.id AND oi.goes_to_kitchen AND oi.status='ACTIVE'
      JOIN products p ON p.id = oi.product_id
      GROUP BY p.id, p.name, p.prep_minutes ORDER BY n DESC`)).rows as any[];
    return {
      from: r.from, to: r.to, samples: valid.length,
      medians: {
        queue: med(col('queue', (x) => !x.skipped_start)), prep: med(col('prep', (x) => !x.skipped_start)),
        kitchen: med(col('kitchen')), counter: med(col('counter')), total: med(col('total')),
      },
      suspects: rows.filter(isSuspect).map((x) => ({
        id: x.id, number: x.number, accountNumber: x.account_number, customerName: x.customer_name, expected: n(x.expected ?? 15),
        kitchen: Math.round(Number(x.kitchen)), confirmedAt: x.confirmed_at, startedAt: x.started_at, readyAt: x.ready_at, deliveredAt: x.delivered_at,
      })),
      stuck: stuck.map((x) => ({ id: x.id, number: x.number, status: x.status, accountNumber: x.account_number, customerName: x.customer_name, expected: n(x.expected ?? 15), age: Math.round(Number(x.age)) })),
      perProduct: perProduct.map((p) => {
        const median = p.median == null ? null : Math.round(Number(p.median));
        const samples = n(p.n);
        const suggest = median != null && samples >= 10 && Math.abs(median - n(p.prepMinutes)) >= 3 ? Math.max(1, Math.min(240, median)) : null;
        return { id: p.id, name: p.name, prepMinutes: n(p.prepMinutes), medianMin: median, samples, suggestedMinutes: suggest };
      }),
    };
  });

  /** Correção de horário pelo admin (o original fica guardado). */
  app.post('/api/orders/:id/times', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({
      field: z.enum(['startedAt', 'readyAt', 'deliveredAt']),
      value: z.string().datetime({ offset: true }),
      reason: reasonSchema,
    }), req.body);
    const user = me(req);
    await db.transaction(async (tx) => {
      const [o] = await tx.select().from(orders).where(eq(orders.id, id)).for('update');
      if (!o) throw notFound('Pedido não encontrado.');
      const v = new Date(b.value);
      const next = { confirmedAt: o.confirmedAt, startedAt: o.startedAt, readyAt: o.readyAt, deliveredAt: o.deliveredAt, [b.field]: v };
      const seq = [next.confirmedAt, next.startedAt, next.readyAt, next.deliveredAt].filter(Boolean) as Date[];
      for (let i = 1; i < seq.length; i++) if (seq[i] < seq[i - 1]) throw bad('A ordem dos horários ficaria inválida (enviado ≤ iniciou ≤ pronto ≤ entregue).');
      if (v > new Date(Date.now() + 60_000)) throw bad('O horário não pode estar no futuro.');
      const before = o[b.field];
      await tx.update(orders).set({ [b.field]: v }).where(eq(orders.id, id));
      await tx.insert(orderTimeCorrections).values({ orderId: id, field: b.field, before, after: v, reason: b.reason, userId: user.id });
      const label = { startedAt: 'início do preparo', readyAt: 'pronto', deliveredAt: 'entregue' }[b.field];
      const fmt = (d: Date | null) => d ? d.toLocaleString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '—';
      await audit(tx, { userId: user.id, action: 'order.time.correct', entityType: 'order', entityId: id, message: `${user.name} corrigiu o horário de ${label} do pedido #${o.number}: ${fmt(before)} → ${fmt(v)}. Motivo: ${b.reason}` });
    });
    notify.ordersChanged();
    return { ok: true };
  });

  // =============== HISTÓRICO DE PEDIDOS ===============
  app.get('/api/orders/history', admin, async (req) => {
    const f = parse(z.object({
      from: dateSchema.optional(), to: dateSchema.optional(), search: z.string().trim().max(60).optional(),
      status: z.string().max(40).optional(), method: z.string().max(20).optional(), userId: z.coerce.number().int().positive().optional(),
      productId: z.coerce.number().int().positive().optional(), origin: z.enum(['CAIXA', 'QR_CODE', 'DELIVERY', 'WHATSAPP']).optional(),
      consumption: z.enum(['LOCAL', 'VIAGEM']).optional(),
    }), req.query);
    const r = rangeOf(f);
    const conds = [inRange('o.created_at', r)];
    if (f.search) {
      const num = Number(f.search.replace('#', ''));
      conds.push(Number.isInteger(num) && num > 0
        ? sql`(o.number = ${num} OR a.number = ${num})`
        : sql`(unaccent_lower(coalesce(a.customer_name,'')) LIKE unaccent_lower(${'%' + f.search + '%'}) OR unaccent_lower(coalesce(a.note,'')) LIKE unaccent_lower(${'%' + f.search + '%'}))`);
    }
    if (f.status) {
      const list = f.status.split(',').filter((s) => ['CONFIRMED', 'IN_PREPARATION', 'READY', 'DELIVERED', 'CANCELLED', 'AWAITING_CONFIRMATION'].includes(s));
      if (list.length) conds.push(sql`o.status IN (${sql.join(list.map((s) => sql`${s}`), sql`, `)})`);
    }
    if (f.method) conds.push(sql`EXISTS (SELECT 1 FROM payments p JOIN payment_methods pm ON pm.id = p.method_id WHERE p.account_id = a.id AND pm.code = ${f.method} AND p.reversed_at IS NULL)`);
    if (f.userId) conds.push(sql`o.created_by = ${f.userId}`);
    if (f.productId) conds.push(sql`EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.product_id = ${f.productId})`);
    if (f.origin) conds.push(sql`o.origin = ${f.origin}`);
    if (f.consumption) conds.push(sql`o.consumption_type = ${f.consumption}`);
    return (await db.execute(sql`
      SELECT o.id, o.number, o.status, o.origin, o.consumption_type AS "consumptionType", o.created_at AS "createdAt",
             a.id AS "accountId", a.number AS "accountNumber", a.customer_name AS "customerName", a.status AS "accountStatus",
             u.name AS "createdByName",
             COALESCE((SELECT SUM(unit_price_cents*quantity) FROM order_items WHERE order_id = o.id AND status='ACTIVE'),0)::int AS "totalCents",
             (SELECT string_agg(quantity || '× ' || product_name, ', ' ORDER BY id) FROM order_items WHERE order_id = o.id) AS "itemsText"
      FROM orders o JOIN accounts a ON a.id = o.account_id LEFT JOIN users u ON u.id = o.created_by
      WHERE ${sql.join(conds, sql` AND `)}
      ORDER BY o.id DESC LIMIT 500`)).rows;
  });
}
