import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { networkInterfaces } from 'node:os';
import { db } from '../db/index.js';
import { deliverySettings, excludedDays, restaurantSettings } from '../db/schema.js';
import { me, requireRole } from '../auth.js';
import { bad, parse, reasonSchema } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { aplicarConfiguracoes, lerConfiguracoes } from '../services/configuracoes.js';
import { notify } from '../realtime.js';
import { runBackupAndRecord } from '../services/backup.js';
import { setEstablishmentOpen } from '../services/day.js';
import { computeInsights } from '../services/insights.js';
import { config } from '../config.js';
const n = (v) => Number(v ?? 0);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TZ = 'America/Sao_Paulo';
export function todayLocal() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function lanUrls() {
    return Object.values(networkInterfaces()).flat()
        .filter((i) => i && i.family === 'IPv4' && !i.internal)
        .map((i) => `http://${i.address}:${config.port}`);
}
/** Período local [from, to] (datas inclusivas). */
export function rangeOf(q) {
    const from = q.from ?? q.date ?? todayLocal();
    const to = q.to ?? q.date ?? from;
    if (from > to)
        throw bad('Período inválido.');
    return { from, to };
}
const inRange = (col, r) => sql `(${sql.raw(col)} AT TIME ZONE ${TZ})::date BETWEEN ${r.from}::date AND ${r.to}::date`;
export async function adminRoutes(app) {
    const admin = { preHandler: requireRole('ADMIN') };
    // Insights: primeiro confere o perfil (Caixa/Cozinha continuam recebendo 403); com o recurso desligado, responde 404.
    const insightsOn = async (_req, reply) => {
        if (!config.insightsEnabled)
            return reply.code(404).send({ error: 'Recurso não disponível.' });
    };
    const insightsAdmin = { preHandler: [requireRole('ADMIN'), insightsOn] };
    const anyUser = { preHandler: requireRole() };
    // ---------- Dashboard por período ----------
    app.get('/api/dashboard', admin, async (req) => {
        const r = rangeOf(parse(z.object({ from: dateSchema.optional(), to: dateSchema.optional(), date: dateSchema.optional() }), req.query));
        const q = async (s) => (await db.execute(s)).rows;
        const liveOrders = sql `o.status NOT IN ('AWAITING_CONFIRMATION','CANCELLED')`;
        const [sales] = await q(sql `
      SELECT COALESCE(SUM(oi.unit_price_cents*oi.quantity),0) AS cents, COALESCE(SUM(oi.quantity),0) AS items,
             COUNT(DISTINCT o.id) AS orders, COUNT(DISTINCT o.account_id) AS accounts
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE ${inRange('o.created_at', r)} AND oi.status='ACTIVE' AND ${liveOrders}`);
        const [disc] = await q(sql `SELECT COALESCE(SUM(amount_cents),0) AS cents, COUNT(*) AS count FROM discounts WHERE ${inRange('created_at', r)}`);
        const discByUser = await q(sql `
      SELECT u.name, SUM(d.amount_cents) AS cents, COUNT(*) AS count FROM discounts d JOIN users u ON u.id=d.user_id
      WHERE ${inRange('d.created_at', r)} GROUP BY u.name ORDER BY cents DESC`);
        const [canc] = await q(sql `
      SELECT COALESCE(SUM(amount_cents),0) AS cents, COUNT(*) AS count, COALESCE(SUM(amount_cents) FILTER (WHERE was_in_preparation),0) AS loss
      FROM cancellations WHERE ${inRange('created_at', r)}`);
        const byMethod = await q(sql `
      SELECT pm.code, pm.name, COALESCE(SUM(p.amount_cents),0) AS cents, COUNT(p.id) AS count
      FROM payment_methods pm LEFT JOIN payments p ON p.method_id=pm.id AND p.reversed_at IS NULL AND ${inRange('p.created_at', r)}
      GROUP BY pm.id ORDER BY pm.sort_order`);
        const [accs] = await q(sql `
      SELECT COUNT(*) FILTER (WHERE status IN ('OPEN','PARTIALLY_PAID','PAID')) AS open_now,
             COUNT(*) FILTER (WHERE status = 'PENDING') AS pending_now,
             COUNT(*) FILTER (WHERE status = 'CLOSED' AND ${inRange('closed_at', r)}) AS closed_in_range
      FROM accounts`);
        const [pendingSum] = await q(sql `
      SELECT COALESCE(SUM(
        COALESCE((SELECT SUM(oi.unit_price_cents*oi.quantity) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.account_id=a.id AND oi.status='ACTIVE'),0)
        - COALESCE((SELECT SUM(amount_cents) FROM discounts WHERE account_id=a.id),0)
        - COALESCE((SELECT SUM(amount_cents) FROM payments WHERE account_id=a.id AND reversed_at IS NULL),0)),0) AS cents
      FROM accounts a WHERE a.status='PENDING'`);
        const [kitchen] = await q(sql `
      SELECT COUNT(*) FILTER (WHERE status='CONFIRMED') AS new, COUNT(*) FILTER (WHERE status='IN_PREPARATION') AS preparing,
             COUNT(*) FILTER (WHERE status='READY') AS ready, COUNT(*) FILTER (WHERE status='AWAITING_CONFIRMATION') AS awaiting
      FROM orders`);
        const topProducts = await q(sql `
      SELECT oi.product_name AS name, SUM(oi.quantity) AS qty, SUM(oi.unit_price_cents*oi.quantity) AS cents
      FROM orders o JOIN order_items oi ON oi.order_id=o.id
      WHERE ${inRange('o.created_at', r)} AND oi.status='ACTIVE' AND ${liveOrders}
      GROUP BY oi.product_name ORDER BY qty DESC LIMIT 8`);
        const byCategory = await q(sql `
      SELECT COALESCE(c.name, 'Outros') AS name, SUM(oi.unit_price_cents*oi.quantity) AS cents, SUM(oi.quantity) AS qty
      FROM orders o JOIN order_items oi ON oi.order_id=o.id LEFT JOIN products p ON p.id = oi.product_id LEFT JOIN categories c ON c.id = p.category_id
      WHERE ${inRange('o.created_at', r)} AND oi.status='ACTIVE' AND ${liveOrders}
      GROUP BY 1 ORDER BY cents DESC`);
        const byHour = await q(sql `
      SELECT EXTRACT(HOUR FROM o.created_at AT TIME ZONE ${TZ})::int AS h, COUNT(*) AS orders
      FROM orders o WHERE ${inRange('o.created_at', r)} AND ${liveOrders} GROUP BY 1 ORDER BY 1`);
        const [times] = await q(sql `
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (ready_at-confirmed_at))/60) AS kitchen,
             COUNT(*) AS n
      FROM orders WHERE goes_to_kitchen AND ready_at IS NOT NULL AND confirmed_at IS NOT NULL AND ${inRange('created_at', r)}
        AND EXTRACT(EPOCH FROM (ready_at-confirmed_at))/60 <= 3*COALESCE(expected_minutes,15)`);
        const lowStock = await q(sql `SELECT id, name, stock_qty AS qty, low_stock_at AS lim FROM products WHERE track_stock AND active AND stock_qty <= low_stock_at ORDER BY stock_qty, name LIMIT 10`);
        const [s] = await db.select().from(restaurantSettings).limit(1);
        const [year] = await q(sql `
      SELECT COALESCE(SUM(oi.unit_price_cents*oi.quantity),0)
             - COALESCE((SELECT SUM(amount_cents) FROM discounts WHERE date_part('year', created_at AT TIME ZONE ${TZ}) = date_part('year', ${r.to}::date)),0) AS cents
      FROM orders o JOIN order_items oi ON oi.order_id=o.id
      WHERE oi.status='ACTIVE' AND ${liveOrders} AND date_part('year', o.created_at AT TIME ZONE ${TZ}) = date_part('year', ${r.to}::date)`);
        const revenue = n(sales.cents) - n(disc.cents);
        const backupAgeH = s.lastBackupAt ? (Date.now() - new Date(s.lastBackupAt).getTime()) / 3_600_000 : null;
        return {
            from: r.from, to: r.to,
            revenueCents: revenue, grossSalesCents: n(sales.cents), itemsSold: n(sales.items),
            ordersCount: n(sales.orders), accountsCount: n(sales.accounts),
            averageTicketCents: n(sales.accounts) ? Math.round(revenue / n(sales.accounts)) : 0,
            accountsOpenNow: n(accs.open_now), accountsClosedInRange: n(accs.closed_in_range), accountsPendingNow: n(accs.pending_now),
            pendingCents: n(pendingSum.cents),
            ordersNew: n(kitchen.new), ordersPreparing: n(kitchen.preparing), ordersReady: n(kitchen.ready), ordersAwaiting: n(kitchen.awaiting),
            discountsCents: n(disc.cents), discountsCount: n(disc.count),
            discountsByUser: discByUser.map((d) => ({ name: d.name, cents: n(d.cents), count: n(d.count) })),
            cancellationsCents: n(canc.cents), cancellationsCount: n(canc.count), lossCents: n(canc.loss),
            payments: byMethod.map((m) => ({ code: m.code, name: m.name, cents: n(m.cents), count: n(m.count) })),
            receivedCents: byMethod.reduce((acc, m) => acc + n(m.cents), 0),
            topProducts: topProducts.map((t) => ({ name: t.name, qty: n(t.qty), cents: n(t.cents) })),
            byCategory: byCategory.map((c) => ({ name: c.name, cents: n(c.cents), qty: n(c.qty) })),
            byHour: byHour.map((h) => ({ hour: n(h.h), orders: n(h.orders) })),
            kitchenMedianMin: times?.kitchen == null ? null : Math.round(Number(times.kitchen)), kitchenSamples: n(times?.n),
            lowStock: lowStock.map((l) => ({ id: l.id, name: l.name, qty: n(l.qty), lim: n(l.lim) })),
            // instalação própria mostra o aviso de backup; online o backup é da plataforma (sem aviso para o restaurante)
            backup: config.backupDirs.length ? { at: s.lastBackupAt, ok: s.lastBackupOk, info: s.lastBackupInfo, stale: backupAgeH == null || backupAgeH > 48 || s.lastBackupOk === false, configured: true } : null,
            mei: s.meiEnabled ? { yearRevenueCents: n(year.cents), limitCents: s.meiLimitCents } : null,
        };
    });
    // ---------- Insights ----------
    app.get('/api/insights', insightsAdmin, async () => computeInsights(db));
    app.get('/api/excluded-days', insightsAdmin, async () => (await db.execute(sql `SELECT to_char(day,'YYYY-MM-DD') AS day, reason FROM excluded_days ORDER BY day DESC`)).rows);
    app.post('/api/excluded-days', insightsAdmin, async (req) => {
        const b = parse(z.object({ day: dateSchema, reason: reasonSchema }), req.body);
        await db.insert(excludedDays).values({ day: b.day, reason: b.reason, userId: me(req).id }).onConflictDoUpdate({ target: [excludedDays.empresaId, excludedDays.day], set: { reason: b.reason } });
        await audit(db, { userId: me(req).id, action: 'insights.exclude', message: `${me(req).name} marcou ${b.day.split('-').reverse().join('/')} como dia atípico (fora das comparações). Motivo: ${b.reason}` });
        return { ok: true };
    });
    app.delete('/api/excluded-days/:day', insightsAdmin, async (req) => {
        const { day } = parse(z.object({ day: dateSchema }), req.params);
        await db.delete(excludedDays).where(eq(excludedDays.day, day));
        await audit(db, { userId: me(req).id, action: 'insights.include', message: `${me(req).name} voltou a incluir ${day.split('-').reverse().join('/')} nas comparações.` });
        return { ok: true };
    });
    // ---------- Auditoria ----------
    app.get('/api/audit', admin, async (req) => {
        const f = parse(z.object({
            date: dateSchema.optional(), search: z.string().trim().max(80).optional(),
            before: z.coerce.number().int().positive().optional(),
        }), req.query);
        const conds = [sql `TRUE`];
        if (f.date)
            conds.push(sql `(l.created_at AT TIME ZONE ${TZ})::date = ${f.date}::date`);
        if (f.search)
            conds.push(sql `unaccent_lower(l.message) LIKE unaccent_lower(${'%' + f.search + '%'})`);
        if (f.before)
            conds.push(sql `l.id < ${f.before}`);
        const rows = await db.execute(sql `
      SELECT l.id, l.created_at AS "createdAt", l.action, l.entity_type AS "entityType", l.entity_id AS "entityId", l.message,
             u.name AS "userName", l.user_role AS "userRole"
      FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
      WHERE ${sql.join(conds, sql ` AND `)} ORDER BY l.id DESC LIMIT 200`);
        return rows.rows;
    });
    app.get('/api/cancellations', admin, async (req) => {
        const f = parse(z.object({ date: dateSchema.optional(), from: dateSchema.optional(), to: dateSchema.optional() }), req.query);
        const hasRange = f.date || f.from || f.to;
        const r = hasRange ? rangeOf(f) : null;
        const rows = await db.execute(sql `
      SELECT c.id, c.created_at AS "createdAt", c.target, c.description, c.amount_cents AS "amountCents", c.reason,
             c.was_in_preparation AS "wasInPreparation", c.status_before AS "statusBefore", c.status_after AS "statusAfter",
             c.stock_returned AS "stockReturned", u.name AS "userName", a.number AS "accountNumber", a.id AS "accountId"
      FROM cancellations c JOIN users u ON u.id = c.user_id JOIN accounts a ON a.id = c.account_id
      WHERE ${r ? inRange('c.created_at', r) : sql `TRUE`}
      ORDER BY c.id DESC LIMIT 300`);
        return rows.rows;
    });
    // ---------- Configurações ----------
    app.get('/api/settings', anyUser, async () => {
        const [r] = await db.select().from(restaurantSettings).limit(1);
        const [d] = await db.select().from(deliverySettings).limit(1);
        return {
            restaurant: {
                name: r.name, tagline: r.tagline, isOpen: r.isOpen, qrEnabled: r.qrEnabled, whatsappNumber: r.whatsappNumber,
                meiEnabled: r.meiEnabled, meiLimitCents: r.meiLimitCents,
            },
            delivery: { isOpen: d.isOpen },
            // valores efetivos do catálogo de personalização (o que muda o comportamento das telas)
            config: await lerConfiguracoes(),
            backupDirs: config.backupDirs, demoMode: config.demoMode, lanUrls: lanUrls(),
            publicPort: config.publicPort, version: config.version, insightsEnabled: config.insightsEnabled,
            product: config.productName,
        };
    });
    /** Compatibilidade com telas antigas: ABERTO/FECHADO aqui; o resto passa pelo catálogo (histórico e cadeados). */
    app.patch('/api/settings', admin, async (req) => {
        const b = parse(z.object({
            isOpen: z.boolean().optional(),
            qrEnabled: z.boolean().optional(),
            whatsappNumber: z.string().trim().max(20).nullable().optional(),
            name: z.string().trim().min(2).max(60).optional(),
            tagline: z.string().trim().max(60).optional(),
            deliveryOpen: z.boolean().optional(),
            meiEnabled: z.boolean().optional(),
            meiLimitCents: z.number().int().min(0).max(100_000_000_00).optional(),
        }), req.body);
        const user = me(req);
        const map = { qrEnabled: 'cardapio_digital_ligado', whatsappNumber: 'whatsapp', name: 'nome', tagline: 'subtitulo', deliveryOpen: 'delivery_aberto', meiEnabled: 'mei_ligado', meiLimitCents: 'mei_limite' };
        const valores = {};
        for (const [k, v] of Object.entries(b))
            if (map[k] && v !== undefined)
                valores[map[k]] = v;
        if (Object.keys(valores).length)
            await aplicarConfiguracoes(valores, user);
        if (b.isOpen !== undefined)
            await db.transaction((tx) => setEstablishmentOpen(tx, user, b.isOpen, 'configurações'));
        notify.settingsChanged();
        return { ok: true };
    });
    app.post('/api/backup', admin, async (req) => {
        if (!config.backupDirs.length)
            throw bad('No ONE Food online o backup do banco é automático e diário, feito pela ONE UP.');
        return { results: await runBackupAndRecord(me(req).id, 'backup.manual') };
    });
}
