import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { deliverySettings, restaurantSettings } from '../db/schema.js';
import { me, requireRole } from '../auth.js';
import { parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { notify } from '../realtime.js';
import { runBackup } from '../services/backup.js';
import { config } from '../config.js';
import { networkInterfaces } from 'node:os';
function lanUrls() {
    return Object.values(networkInterfaces()).flat()
        .filter((i) => i && i.family === 'IPv4' && !i.internal)
        .map((i) => `http://${i.address}:${config.port}`);
}
const n = (v) => Number(v ?? 0);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
function todayLocal() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export async function adminRoutes(app) {
    const admin = { preHandler: requireRole('ADMIN') };
    const anyUser = { preHandler: requireRole() };
    app.get('/api/dashboard', admin, async (req) => {
        const date = parse(z.object({ date: dateSchema.optional() }), req.query).date ?? todayLocal();
        const day = (col) => sql.raw(`(${col} AT TIME ZONE 'America/Sao_Paulo')::date`);
        const q = async (s) => (await db.execute(s)).rows;
        const [sales] = await q(sql `
      SELECT COALESCE(SUM(oi.unit_price_cents*oi.quantity),0) AS cents, COUNT(DISTINCT o.id) AS orders, COUNT(DISTINCT o.account_id) AS accounts
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE ${day('o.created_at')} = ${date}::date AND oi.status='ACTIVE' AND o.status NOT IN ('AWAITING_CONFIRMATION')`);
        const [disc] = await q(sql `SELECT COALESCE(SUM(amount_cents),0) AS cents, COUNT(*) AS count FROM discounts WHERE ${day('created_at')} = ${date}::date`);
        const discByUser = await q(sql `
      SELECT u.name, SUM(d.amount_cents) AS cents, COUNT(*) AS count FROM discounts d JOIN users u ON u.id=d.user_id
      WHERE ${day('d.created_at')} = ${date}::date GROUP BY u.name ORDER BY cents DESC`);
        const [canc] = await q(sql `
      SELECT COALESCE(SUM(amount_cents),0) AS cents, COUNT(*) AS count, COALESCE(SUM(amount_cents) FILTER (WHERE was_in_preparation),0) AS loss
      FROM cancellations WHERE ${day('created_at')} = ${date}::date`);
        const byMethod = await q(sql `
      SELECT pm.code, pm.name, COALESCE(SUM(p.amount_cents),0) AS cents, COUNT(p.id) AS count
      FROM payment_methods pm LEFT JOIN payments p ON p.method_id=pm.id AND p.reversed_at IS NULL AND ${day('p.created_at')} = ${date}::date
      GROUP BY pm.id ORDER BY pm.sort_order`);
        const [accs] = await q(sql `
      SELECT COUNT(*) FILTER (WHERE ${day('opened_at')} = ${date}::date AND status <> 'CANCELLED') AS opened_today,
             COUNT(*) FILTER (WHERE status IN ('OPEN','PARTIALLY_PAID','PAID')) AS open_now,
             COUNT(*) FILTER (WHERE status = 'CLOSED' AND ${day('closed_at')} = ${date}::date) AS closed_today,
             COUNT(*) FILTER (WHERE status = 'PENDING') AS pending_now
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
        const [year] = await q(sql `
      SELECT COALESCE(SUM(oi.unit_price_cents*oi.quantity),0)
             - COALESCE((SELECT SUM(amount_cents) FROM discounts WHERE date_part('year', created_at AT TIME ZONE 'America/Sao_Paulo') = date_part('year', ${date}::date)),0) AS cents
      FROM orders o JOIN order_items oi ON oi.order_id=o.id
      WHERE oi.status='ACTIVE' AND o.status <> 'AWAITING_CONFIRMATION'
        AND date_part('year', o.created_at AT TIME ZONE 'America/Sao_Paulo') = date_part('year', ${date}::date)`);
        const topProducts = await q(sql `
      SELECT oi.product_name AS name, SUM(oi.quantity) AS qty, SUM(oi.unit_price_cents*oi.quantity) AS cents
      FROM orders o JOIN order_items oi ON oi.order_id=o.id
      WHERE ${day('o.created_at')} = ${date}::date AND oi.status='ACTIVE' AND o.status <> 'AWAITING_CONFIRMATION'
      GROUP BY oi.product_name ORDER BY qty DESC LIMIT 8`);
        const revenue = n(sales.cents) - n(disc.cents);
        const accountsWithSales = n(sales.accounts);
        return {
            date,
            revenueCents: revenue,
            grossSalesCents: n(sales.cents),
            ordersCount: n(sales.orders),
            accountsCount: n(accs.opened_today),
            averageTicketCents: accountsWithSales ? Math.round(revenue / accountsWithSales) : 0,
            accountsOpenNow: n(accs.open_now),
            accountsClosedToday: n(accs.closed_today),
            accountsPendingNow: n(accs.pending_now),
            pendingCents: n(pendingSum.cents),
            ordersNew: n(kitchen.new), ordersPreparing: n(kitchen.preparing), ordersReady: n(kitchen.ready), ordersAwaiting: n(kitchen.awaiting),
            discountsCents: n(disc.cents), discountsCount: n(disc.count),
            discountsByUser: discByUser.map((d) => ({ name: d.name, cents: n(d.cents), count: n(d.count) })),
            cancellationsCents: n(canc.cents), cancellationsCount: n(canc.count), lossCents: n(canc.loss),
            payments: byMethod.map((m) => ({ code: m.code, name: m.name, cents: n(m.cents), count: n(m.count) })),
            receivedCents: byMethod.reduce((s, m) => s + n(m.cents), 0),
            yearRevenueCents: n(year.cents),
            topProducts: topProducts.map((t) => ({ name: t.name, qty: n(t.qty), cents: n(t.cents) })),
        };
    });
    app.get('/api/audit', admin, async (req) => {
        const f = parse(z.object({
            date: dateSchema.optional(), search: z.string().trim().max(80).optional(),
            before: z.coerce.number().int().positive().optional(),
        }), req.query);
        const conds = [sql `TRUE`];
        if (f.date)
            conds.push(sql `(l.created_at AT TIME ZONE 'America/Sao_Paulo')::date = ${f.date}::date`);
        if (f.search)
            conds.push(sql `l.message ILIKE ${'%' + f.search + '%'}`);
        if (f.before)
            conds.push(sql `l.id < ${f.before}`);
        const rows = await db.execute(sql `
      SELECT l.id, l.created_at AS "createdAt", l.action, l.entity_type AS "entityType", l.entity_id AS "entityId", l.message, u.name AS "userName"
      FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
      WHERE ${sql.join(conds, sql ` AND `)} ORDER BY l.id DESC LIMIT 200`);
        return rows.rows;
    });
    app.get('/api/cancellations', admin, async (req) => {
        const f = parse(z.object({ date: dateSchema.optional() }), req.query);
        const rows = await db.execute(sql `
      SELECT c.id, c.created_at AS "createdAt", c.target, c.description, c.amount_cents AS "amountCents", c.reason,
             c.was_in_preparation AS "wasInPreparation", u.name AS "userName", a.number AS "accountNumber", a.id AS "accountId"
      FROM cancellations c JOIN users u ON u.id = c.user_id JOIN accounts a ON a.id = c.account_id
      WHERE ${f.date ? sql `(c.created_at AT TIME ZONE 'America/Sao_Paulo')::date = ${f.date}::date` : sql `TRUE`}
      ORDER BY c.id DESC LIMIT 300`);
        return rows.rows;
    });
    // ----- Configurações (leitura liberada a todos os perfis logados) -----
    app.get('/api/settings', anyUser, async () => {
        const [r] = await db.select().from(restaurantSettings).limit(1);
        const [d] = await db.select().from(deliverySettings).limit(1);
        return { restaurant: r, delivery: d, backupDirs: config.backupDirs, demoMode: config.demoMode, lanUrls: lanUrls() };
    });
    app.patch('/api/settings', admin, async (req) => {
        const b = parse(z.object({
            isOpen: z.boolean().optional(),
            qrEnabled: z.boolean().optional(),
            whatsappNumber: z.string().trim().max(20).nullable().optional(),
            name: z.string().trim().min(2).max(60).optional(),
            deliveryOpen: z.boolean().optional(),
        }), req.body);
        const user = me(req);
        const msgs = [];
        await db.transaction(async (tx) => {
            const { deliveryOpen, ...rest } = b;
            if (rest.whatsappNumber !== undefined)
                rest.whatsappNumber = rest.whatsappNumber ? rest.whatsappNumber.replace(/\D/g, '') : null;
            if (Object.keys(rest).length)
                await tx.update(restaurantSettings).set({ ...rest, updatedAt: new Date() }).where(eq(restaurantSettings.id, 1));
            if (deliveryOpen !== undefined)
                await tx.update(deliverySettings).set({ isOpen: deliveryOpen, updatedAt: new Date() }).where(eq(deliverySettings.id, 1));
            if (b.isOpen !== undefined)
                msgs.push(`restaurante ${b.isOpen ? 'ABERTO' : 'FECHADO'}`);
            if (b.qrEnabled !== undefined)
                msgs.push(`QR Code ${b.qrEnabled ? 'LIGADO' : 'DESLIGADO'}`);
            if (deliveryOpen !== undefined)
                msgs.push(`delivery ${deliveryOpen ? 'ABERTO' : 'FECHADO'}`);
            if (b.whatsappNumber !== undefined)
                msgs.push('WhatsApp atualizado');
            if (b.name)
                msgs.push(`nome → ${b.name}`);
            await audit(tx, { userId: user.id, action: 'settings.update', message: `${user.name} alterou configurações: ${msgs.join(', ')}.` });
        });
        notify.settingsChanged();
        return { ok: true };
    });
    app.post('/api/backup', admin, async (req) => {
        const results = await runBackup();
        const ok = results.filter((r) => r.ok).length;
        await audit(db, { userId: me(req).id, action: 'backup.manual', message: ok ? `${me(req).name} fez backup manual (${ok} pasta(s)).` : `Backup manual FALHOU: ${results.map((r) => r.error).join('; ')}`, data: results });
        return { results };
    });
}
