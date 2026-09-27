import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { cashMovements, cashRegisters, users } from '../db/schema.js';
import { me, requireRole } from '../auth.js';
import { brl, centsSchema, conflict, idParam, notFound, parse, reasonSchema } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { notify } from '../realtime.js';
import { currentRegister, requireOpenRegister } from '../services/accounts.js';
import { registerSummary } from '../services/register.js';
import { runBackup } from '../services/backup.js';
export async function registerRoutes(app) {
    const ops = { preHandler: requireRole('CAIXA') };
    app.get('/api/register/current', ops, async () => {
        const reg = await currentRegister(db);
        if (!reg)
            return { register: null };
        const [opener] = await db.select({ name: users.name }).from(users).where(eq(users.id, reg.openedBy));
        return { register: { ...reg, openedByName: opener?.name }, summary: await registerSummary(db, reg.id) };
    });
    app.post('/api/register/open', ops, async (req) => {
        const b = parse(z.object({ openingCashCents: z.number().int().min(0).max(100_000_00) }), req.body);
        const user = me(req);
        const reg = await db.transaction(async (tx) => {
            if (await currentRegister(tx))
                throw conflict('Já existe um caixa aberto.');
            const [reg] = await tx.insert(cashRegisters).values({ openedBy: user.id, openingCashCents: b.openingCashCents }).returning();
            await audit(tx, { userId: user.id, action: 'register.open', entityType: 'cash_register', entityId: reg.id, message: `${user.name} abriu o caixa com ${brl(b.openingCashCents)} em dinheiro.` });
            return reg;
        });
        notify.registerChanged();
        return reg;
    });
    app.post('/api/register/movements', ops, async (req) => {
        const b = parse(z.object({ type: z.enum(['SANGRIA', 'SUPRIMENTO']), amountCents: centsSchema, reason: reasonSchema }), req.body);
        const user = me(req);
        await db.transaction(async (tx) => {
            const reg = await requireOpenRegister(tx);
            await tx.insert(cashMovements).values({ cashRegisterId: reg.id, type: b.type, amountCents: b.amountCents, reason: b.reason, userId: user.id });
            await audit(tx, { userId: user.id, action: 'register.movement', entityType: 'cash_register', entityId: reg.id, message: `${user.name} registrou ${b.type === 'SANGRIA' ? 'sangria (retirada)' : 'suprimento (reforço)'} de ${brl(b.amountCents)}. Motivo: ${b.reason}` });
        });
        notify.registerChanged();
        return { ok: true };
    });
    app.post('/api/register/close', ops, async (req) => {
        const b = parse(z.object({ countedCashCents: z.number().int().min(0).max(100_000_00), note: z.string().trim().max(300).nullable().optional() }), req.body);
        const user = me(req);
        const out = await db.transaction(async (tx) => {
            const reg = await requireOpenRegister(tx);
            await tx.select().from(cashRegisters).where(eq(cashRegisters.id, reg.id)).for('update');
            const s = await registerSummary(tx, reg.id);
            const diff = b.countedCashCents - s.expectedCashCents;
            const closedAt = new Date();
            await tx.update(cashRegisters).set({
                status: 'CLOSED', closedBy: user.id, closedAt, expectedCashCents: s.expectedCashCents,
                countedCashCents: b.countedCashCents, differenceCents: diff, closingNote: b.note || null,
                summary: { ...s, closedAt, countedCashCents: b.countedCashCents, differenceCents: diff },
            }).where(eq(cashRegisters.id, reg.id));
            await audit(tx, {
                userId: user.id, action: 'register.close', entityType: 'cash_register', entityId: reg.id,
                message: `${user.name} fechou o caixa. Recebido: ${brl(s.receivedCents)}. Dinheiro esperado ${brl(s.expectedCashCents)}, contado ${brl(b.countedCashCents)}, diferença ${diff > 0 ? '+' : ''}${brl(diff)}.`,
            });
            return { id: reg.id, expectedCashCents: s.expectedCashCents, countedCashCents: b.countedCashCents, differenceCents: diff };
        });
        notify.registerChanged();
        // backup em segundo plano, não trava o fechamento
        runBackup().then(async (results) => {
            const okCount = results.filter((r) => r.ok).length;
            await audit(db, {
                action: 'backup.auto', message: okCount ? `Backup automático do fechamento salvo em ${okCount} pasta(s).` : `Backup automático FALHOU: ${results.map((r) => r.error).join('; ')}`,
                data: results,
            });
        }).catch(() => undefined);
        return out;
    });
    app.get('/api/registers', ops, async () => {
        return db.select({
            id: cashRegisters.id, status: cashRegisters.status, openedAt: cashRegisters.openedAt, closedAt: cashRegisters.closedAt,
            openingCashCents: cashRegisters.openingCashCents, expectedCashCents: cashRegisters.expectedCashCents,
            countedCashCents: cashRegisters.countedCashCents, differenceCents: cashRegisters.differenceCents, openedByName: users.name,
        }).from(cashRegisters).innerJoin(users, eq(users.id, cashRegisters.openedBy)).orderBy(desc(cashRegisters.id)).limit(120);
    });
    app.get('/api/registers/:id', ops, async (req) => {
        const { id } = parse(idParam, req.params);
        const [reg] = await db.select().from(cashRegisters).where(eq(cashRegisters.id, id));
        if (!reg)
            throw notFound('Caixa não encontrado.');
        return { register: reg, summary: reg.status === 'CLOSED' && reg.summary ? reg.summary : await registerSummary(db, id) };
    });
}
