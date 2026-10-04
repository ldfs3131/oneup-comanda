import { config } from '../config.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, empresaAtual, runAsEmpresa } from '../db/index.js';
import { accounts, cancellations, cashMovements, cashRegisters, orders, restaurantSettings, users } from '../db/schema.js';
import { me, requireRole } from '../auth.js';
import { brl, centsSchema, conflict, idParam, notFound, parse, reasonSchema } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { idempotent } from '../lib/idempotency.js';
import { notify } from '../realtime.js';
import { accountTotals, currentRegister, getAccount, requireOpenRegister } from '../services/accounts.js';
import { pendenciasDoFechamento, registerSummary, resumoCego } from '../services/register.js';
import { lerConfig } from '../services/configuracoes.js';
import { runBackupAndRecord } from '../services/backup.js';
import { setEstablishmentOpen } from '../services/day.js';
import { MSG_SO_RECEBER, erroSoConsulta, erroSuspenso, licencaAtual } from '../lib/licenca.js';

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
      // o caixa já fez a 1ª contagem e passou da tolerância: falta só a recontagem
      recontagem: reg.primeiraContagemCents != null,
      summary: blind ? resumoCego(summary) : summary,
    };
  });

  // Abrir o dia = abrir o caixa (dinheiro inicial) + estabelecimento ABERTO.
  // A licença é conferida AQUI (e só aqui): vencida ou "só consulta" não abre o dia; um dia já aberto segue até encerrar.
  // Em "só consulta" dá para abrir o caixa SÓ PARA RECEBER contas abertas (sem pedido novo e com o estabelecimento fechado).
  const openDay = async (req: any) => {
    const b = parse(z.object({ openingCashCents: z.number().int().min(0).max(100_000_00), somenteReceber: z.boolean().default(false) }), req.body);
    const user = me(req);
    const lic = await licencaAtual();
    if (lic.efetivo === 'SUSPENSO') throw erroSuspenso();
    const soReceber = lic.efetivo === 'SO_CONSULTA';
    if (soReceber && !b.somenteReceber) throw erroSoConsulta();
    const reg = await db.transaction(async (tx) => {
      if (await currentRegister(tx)) throw conflict('O dia já está aberto.');
      const [reg] = await tx.insert(cashRegisters).values({ openedBy: user.id, openingCashCents: b.openingCashCents, somenteReceber: soReceber }).returning();
      await audit(tx, { userId: user.id, action: 'register.open', entityType: 'cash_register', entityId: reg.id, message: soReceber
        ? `${user.name} abriu o caixa SÓ PARA RECEBER contas (sistema em só consulta) com ${brl(b.openingCashCents)} em dinheiro.`
        : `${user.name} abriu o dia/caixa com ${brl(b.openingCashCents)} em dinheiro.` });
      if (!soReceber) await setEstablishmentOpen(tx, user, true, 'abertura do dia');
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
      if (isOpen) { const reg = await requireOpenRegister(tx); if (reg.somenteReceber) throw conflict(MSG_SO_RECEBER); }
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

  // Antes de contar a gaveta: o que ainda está pendurado (contas com saldo, pagas, vazias, cozinha, problemas)
  app.get('/api/day/pendencias', ops, async () => {
    await requireOpenRegister(db);
    return pendenciasDoFechamento(db);
  });

  // "Encerrar todas as pagas": cada conta paga (saldo 0, com consumo) é encerrada com auditoria, como no botão da conta
  app.post('/api/day/encerrar-pagas', ops, async (req) => {
    const user = me(req);
    const r = await idempotent(req, 'day.encerrar-pagas', () => db.transaction(async (tx) => {
      await requireOpenRegister(tx);
      const { pagas } = await pendenciasDoFechamento(tx);
      const feitas: number[] = [];
      for (const p of pagas) {
        const acc = await getAccount(tx, p.id, true);
        if (!['OPEN', 'PARTIALLY_PAID', 'PAID'].includes(acc.status)) continue;
        const t = await accountTotals(tx, p.id);
        if (t.subtotal <= 0 || t.balance !== 0) continue; // mudou enquanto isso: fica para o caixa ver
        await tx.update(accounts).set({ status: 'CLOSED', closedAt: new Date(), closedBy: user.id }).where(eq(accounts.id, p.id));
        await audit(tx, { userId: user.id, action: 'account.close', entityType: 'account', entityId: p.id, message: `${user.name} encerrou a conta #${acc.number} no fechamento do dia (total ${brl(t.total)}, paga).` });
        feitas.push(p.id);
      }
      return { encerradas: feitas.length, ids: feitas };
    }));
    for (const id of r.ids) notify.accountsChanged(id);
    notify.registerChanged();
    return { encerradas: r.encerradas };
  });

  // "Cancelar vazias": contas sem nenhum item e sem pagamento, com motivo automático
  app.post('/api/day/cancelar-vazias', ops, async (req) => {
    const user = me(req);
    const motivo = 'Conta vazia no fechamento';
    const r = await idempotent(req, 'day.cancelar-vazias', () => db.transaction(async (tx) => {
      const reg = await requireOpenRegister(tx);
      const { vazias } = await pendenciasDoFechamento(tx);
      const feitas: number[] = [];
      for (const v of vazias) {
        const acc = await getAccount(tx, v.id, true);
        if (!['OPEN', 'PARTIALLY_PAID', 'PAID'].includes(acc.status)) continue;
        const t = await accountTotals(tx, v.id);
        const ativos = await tx.execute(sql`SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.account_id = ${v.id} AND oi.status = 'ACTIVE' LIMIT 1`);
        if (t.paid !== 0 || ativos.rows.length) continue; // ganhou item/pagamento enquanto isso
        await tx.update(orders).set({ status: 'CANCELLED' }).where(and(eq(orders.accountId, v.id), sql`${orders.status} <> 'CANCELLED'`));
        await tx.update(accounts).set({ status: 'CANCELLED', closedAt: new Date(), closedBy: user.id }).where(eq(accounts.id, v.id));
        await tx.insert(cancellations).values({
          target: 'ACCOUNT', accountId: v.id, description: `Conta #${acc.number}`, amountCents: 0, wasInPreparation: false,
          reason: motivo, userId: user.id, cashRegisterId: reg.id, statusBefore: acc.status, statusAfter: 'CANCELLED', stockReturned: false,
        });
        await audit(tx, { userId: user.id, action: 'account.cancel', entityType: 'account', entityId: v.id, message: `${user.name} cancelou a conta #${acc.number} (vazia, R$ 0,00). Motivo: ${motivo}` });
        feitas.push(v.id);
      }
      return { canceladas: feitas.length, ids: feitas };
    }));
    for (const id of r.ids) notify.accountsChanged(id);
    notify.registerChanged();
    return { canceladas: r.canceladas };
  });

  /**
   * Encerrar o dia = fechamento às cegas + estabelecimento FECHADO.
   * CAIXA: se a contagem passar da tolerância na PRIMEIRA vez, o dia NÃO fecha: responde só "conte de novo" (sem valores)
   * e guarda a 1ª contagem. A 2ª contagem fecha o dia (com "confira com o responsável" se ainda passar).
   * Dono/ADMIN fecha direto, vendo tudo. As duas contagens vão para a auditoria e para o resumo do caixa.
   */
  const closeDay = async (req: any) => {
    const b = parse(z.object({ countedCashCents: z.number().int().min(0).max(100_000_00), note: z.string().trim().max(300).nullable().optional() }), req.body);
    const user = me(req);
    const out = await idempotent(req, 'register.close', () => db.transaction(async (tx) => {
      const reg = await requireOpenRegister(tx, 'fechar');
      const s = await registerSummary(tx, reg.id);
      const diff = b.countedCashCents - s.expectedCashCents;
      const tolerancia = (await lerConfig<number>('tolerancia_caixa', tx)) ?? 500;
      const primeira = reg.primeiraContagemCents;
      if (user.role !== 'ADMIN' && primeira == null && Math.abs(diff) > tolerancia) {
        await tx.update(cashRegisters).set({ primeiraContagemCents: b.countedCashCents }).where(eq(cashRegisters.id, reg.id));
        await audit(tx, {
          userId: user.id, action: 'register.recount', entityType: 'cash_register', entityId: reg.id,
          message: `${user.name} fez a 1ª contagem da gaveta: ${brl(b.countedCashCents)} (esperado ${brl(s.expectedCashCents)}, diferença ${diff > 0 ? '+' : ''}${brl(diff)}, acima da tolerância de ${brl(tolerancia)}). O sistema pediu uma recontagem; o dia continua aberto.`,
        });
        return { id: reg.id, cego: true as const, recontar: true as const };
      }
      const closedAt = new Date();
      const difPrimeira = primeira == null ? null : primeira - s.expectedCashCents;
      await tx.update(cashRegisters).set({
        status: 'CLOSED', closedBy: user.id, closedAt, expectedCashCents: s.expectedCashCents,
        countedCashCents: b.countedCashCents, differenceCents: diff, closingNote: b.note || null,
        summary: { ...s, closedAt, countedCashCents: b.countedCashCents, differenceCents: diff, primeiraContagemCents: primeira, primeiraDiferencaCents: difPrimeira },
      }).where(eq(cashRegisters.id, reg.id));
      const contagens = primeira == null
        ? `contado ${brl(b.countedCashCents)}`
        : `1ª contagem ${brl(primeira)} (diferença ${difPrimeira! > 0 ? '+' : ''}${brl(difPrimeira!)}), 2ª contagem ${brl(b.countedCashCents)}`;
      await audit(tx, {
        userId: user.id, action: 'register.close', entityType: 'cash_register', entityId: reg.id,
        message: `${user.name} encerrou o dia/caixa. Recebido: ${brl(s.receivedCents)}. Dinheiro esperado ${brl(s.expectedCashCents)}, ${contagens}, diferença ${diff > 0 ? '+' : ''}${brl(diff)}.`,
      });
      await setEstablishmentOpen(tx, user, false, 'encerramento do dia');
      const completo = {
        id: reg.id, expectedCashCents: s.expectedCashCents, countedCashCents: b.countedCashCents, differenceCents: diff,
        receivedCents: s.receivedCents, openAccounts: s.openAccountsNow, primeiraContagemCents: primeira, primeiraDiferencaCents: difPrimeira,
      };
      if (user.role === 'ADMIN') return completo;
      // caixa: só "contagem registrada"; diferença acima da tolerância vira um aviso sem valor
      return {
        id: reg.id, cego: true as const, countedCashCents: b.countedCashCents, openAccounts: s.openAccountsNow,
        conferir: Math.abs(diff) > tolerancia, recontado: primeira != null,
      };
    }));
    if ('recontar' in out) { notify.registerChanged(); return out; }
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
      primeiraContagemCents: cashRegisters.primeiraContagemCents,
    }).from(cashRegisters).innerJoin(users, eq(users.id, cashRegisters.openedBy)).orderBy(desc(cashRegisters.id)).limit(120);
  });

  app.get('/api/registers/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const [reg] = await db.select().from(cashRegisters).where(eq(cashRegisters.id, id));
    if (!reg) throw notFound('Caixa não encontrado.');
    return { register: reg, summary: reg.status === 'CLOSED' && reg.summary ? reg.summary : await registerSummary(db, id) };
  });
}
