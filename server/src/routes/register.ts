import { config } from '../config.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { db, empresaAtual, runAsEmpresa } from '../db/index.js';
import { cashMovements, cashRegisters, restaurantSettings, users } from '../db/schema.js';
import { me, requireRole } from '../auth.js';
import { brl, centsSchema, conflict, idParam, notFound, parse, reasonSchema } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { idempotent } from '../lib/idempotency.js';
import { notify } from '../realtime.js';
import { currentRegister, requireOpenRegister } from '../services/accounts.js';
import { registerSummary, resumoCego } from '../services/register.js';
import { lerConfig } from '../services/configuracoes.js';
import { runBackupAndRecord } from '../services/backup.js';
import { setEstablishmentOpen } from '../services/day.js';

export async function registerRoutes(app: FastifyInstance) {
  const ops = { preHandler: requireRole('CAIXA') };
  const admin = { preHandler: requireRole('ADMIN') };

  app.get('/api/register/current', ops, async (req) => {
    const reg = await currentRegister(db);
    const [s] = await db.select({ isOpen: restaurantSettings.isOpen }).from(restaurantSettings).limit(1);
    if (!reg) return { register: null, isOpen: s?.isOpen ?? false };
    const [opener] = await db.select({ name: users.name }).from(users).where(eq(users.id, reg.openedBy));
    const summary = await registerSummary(db, reg.id);
    // Fechamento às cegas: o caixa não vê o dinheiro esperado antes de contar
    const blind = me(req).role !== 'ADMIN';
    return {
      register: { ...reg, openedByName: opener?.name },
      isOpen: s?.isOpen ?? false,
      blind,
      summary: blind ? resumoCego(summary) : summary,
    };
  });

  // Abrir o dia = abrir o caixa (dinheiro inicial) + estabelecimento ABERTO
  const openDay = async (req: any) => {
    const b = parse(z.object({ openingCashCents: z.number().int().min(0).max(100_000_00) }), req.body);
    const user = me(req);
    const reg = await db.transaction(async (tx) => {
      if (await currentRegister(tx)) throw conflict('O dia já está aberto.');
      const [reg] = await tx.insert(cashRegisters).values({ openedBy: user.id, openingCashCents: b.openingCashCents }).returning();
      await audit(tx, { userId: user.id, action: 'register.open', entityType: 'cash_register', entityId: reg.id, message: `${user.name} abriu o dia/caixa com ${brl(b.openingCashCents)} em dinheiro.` });
      await setEstablishmentOpen(tx, user, true, 'abertura do dia');
      return reg;
    });
    notify.registerChanged(); notify.settingsChanged();
    return reg;
  };
  app.post('/api/day/open', ops, openDay);
  app.post('/api/register/open', ops, openDay);

  // Pausar/reabrir pedidos no meio do dia (estado único, caixa e admin)
  app.post('/api/day/establishment', ops, async (req) => {
    const { isOpen } = parse(z.object({ isOpen: z.boolean() }), req.body);
    const user = me(req);
    await db.transaction(async (tx) => {
      if (isOpen) await requireOpenRegister(tx);
      await setEstablishmentOpen(tx, user, isOpen, isOpen ? 'pedidos reabertos' : 'pedidos pausados');
    });
    notify.settingsChanged();
    return { ok: true, isOpen };
  });

  app.post('/api/register/movements', ops, async (req) => {
    const b = parse(z.object({ type: z.enum(['SANGRIA', 'SUPRIMENTO']), amountCents: centsSchema, reason: reasonSchema }), req.body);
    const user = me(req);
    await idempotent(req, 'register.movement', () => db.transaction(async (tx) => {
      const reg = await requireOpenRegister(tx);
      await tx.insert(cashMovements).values({ cashRegisterId: reg.id, type: b.type, amountCents: b.amountCents, reason: b.reason, userId: user.id });
      await audit(tx, { userId: user.id, action: 'register.movement', entityType: 'cash_register', entityId: reg.id, message: `${user.name} registrou ${b.type === 'SANGRIA' ? 'sangria (retirada)' : 'suprimento (reforço)'} de ${brl(b.amountCents)}. Motivo: ${b.reason}` });
      return { ok: true };
    }));
    notify.registerChanged();
    return { ok: true };
  });

  // Encerrar o dia = fechamento às cegas + estabelecimento FECHADO
  const closeDay = async (req: any) => {
    const b = parse(z.object({ countedCashCents: z.number().int().min(0).max(100_000_00), note: z.string().trim().max(300).nullable().optional() }), req.body);
    const user = me(req);
    const out = await db.transaction(async (tx) => {
      const reg = await requireOpenRegister(tx, 'fechar');
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
        message: `${user.name} encerrou o dia/caixa. Recebido: ${brl(s.receivedCents)}. Dinheiro esperado ${brl(s.expectedCashCents)}, contado ${brl(b.countedCashCents)}, diferença ${diff > 0 ? '+' : ''}${brl(diff)}.`,
      });
      await setEstablishmentOpen(tx, user, false, 'encerramento do dia');
      const completo = {
        id: reg.id, expectedCashCents: s.expectedCashCents, countedCashCents: b.countedCashCents, differenceCents: diff,
        receivedCents: s.receivedCents, openAccounts: s.openAccountsNow,
      };
      if (user.role === 'ADMIN') return completo;
      // caixa: só "contagem registrada"; diferença acima da tolerância vira um aviso sem valor
      const tolerancia = (await lerConfig<number>('tolerancia_caixa', tx)) ?? 500;
      return {
        id: reg.id, cego: true as const, countedCashCents: b.countedCashCents, openAccounts: s.openAccountsNow,
        conferir: Math.abs(diff) > tolerancia,
      };
    });
    notify.registerChanged(); notify.settingsChanged();
    // Backup local só em instalação própria (BACKUP_DIRS). Online, o backup do banco é diário e feito pela plataforma.
    if (config.backupDirs.length) {
      const eid = empresaAtual();
      setImmediate(() => { runAsEmpresa(eid, () => runBackupAndRecord(null, 'backup.auto')).catch(() => undefined); });
    }
    return out;
  };
  app.post('/api/day/close', ops, closeDay);
  app.post('/api/register/close', ops, closeDay);

  app.get('/api/registers', admin, async () => {
    return db.select({
      id: cashRegisters.id, status: cashRegisters.status, openedAt: cashRegisters.openedAt, closedAt: cashRegisters.closedAt,
      openingCashCents: cashRegisters.openingCashCents, expectedCashCents: cashRegisters.expectedCashCents,
      countedCashCents: cashRegisters.countedCashCents, differenceCents: cashRegisters.differenceCents, openedByName: users.name,
    }).from(cashRegisters).innerJoin(users, eq(users.id, cashRegisters.openedBy)).orderBy(desc(cashRegisters.id)).limit(120);
  });

  app.get('/api/registers/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const [reg] = await db.select().from(cashRegisters).where(eq(cashRegisters.id, id));
    if (!reg) throw notFound('Caixa não encontrado.');
    return { register: reg, summary: reg.status === 'CLOSED' && reg.summary ? reg.summary : await registerSummary(db, id) };
  });
}
