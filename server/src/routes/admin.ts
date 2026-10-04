import { respostaCompartilhada } from '../lib/cacheRota.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { networkInterfaces } from 'node:os';
import { db, empresaAtual } from '../db/index.js';
import { deliverySettings, excludedDays, referenciasExternas, restaurantSettings } from '../db/schema.js';
import { me, requireOneup, requireRole } from '../auth.js';
import { bad, parse, reasonSchema } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { aplicarConfiguracoes, configuracoesVisiveis, lerConfiguracoes } from '../services/configuracoes.js';
import { notify } from '../realtime.js';
import { runBackupAndRecord } from '../services/backup.js';
import { setEstablishmentOpen } from '../services/day.js';
import { computeInsights } from '../services/insights.js';
import { config } from '../config.js';

const n = (v: unknown) => Number(v ?? 0);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TZ = 'America/Sao_Paulo';

export function todayLocal() {
  // só para demonstração e prints (nunca em produção): fixa o "hoje"
  if (process.env.ONEUP_HOJE && process.env.NODE_ENV !== 'production' && /^\d{4}-\d{2}-\d{2}$/.test(process.env.ONEUP_HOJE)) return process.env.ONEUP_HOJE;
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function lanUrls() {
  return Object.values(networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i!.address}:${config.port}`);
}
/** Período local [from, to] (datas inclusivas). */
export function rangeOf(q: { from?: string; to?: string; date?: string }) {
  const from = q.from ?? q.date ?? todayLocal();
  const to = q.to ?? q.date ?? from;
  if (from > to) throw bad('Período inválido.');
  return { from, to };
}
const inRange = (col: string, r: { from: string; to: string }) =>
  // intervalo de horário no fuso do restaurante (usa o índice empresa+data)
  sql`${sql.raw(col)} >= (${r.from}::date::timestamp AT TIME ZONE ${TZ}) AND ${sql.raw(col)} < ((${r.to}::date + 1)::timestamp AT TIME ZONE ${TZ})`;

export async function adminRoutes(app: FastifyInstance) {
  const admin = { preHandler: requireRole('ADMIN') };
  // Insights: primeiro confere o perfil (Caixa/Cozinha continuam recebendo 403); com o recurso desligado, responde 404.
  // A leitura dos números é serviço da ONE UP: aparece para o usuário da ONE UP (ou com INSIGHTS_ENABLED na instalação própria).
  const insightsOn = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.insightsEnabled && !me(req).oneup) return reply.code(404).send({ error: 'Recurso não disponível.' });
  };
  const insightsAdmin = { preHandler: [requireRole('ADMIN'), insightsOn] };
  const anyUser = { preHandler: requireRole() };

  // ---------- Dashboard por período ----------
  app.get('/api/dashboard', { preHandler: [requireRole('ADMIN'), respostaCompartilhada('painel', 'dados', 15000)] }, async (req) => {
    const r = rangeOf(parse(z.object({ from: dateSchema.optional(), to: dateSchema.optional(), date: dateSchema.optional() }), req.query));
    const q = async (s: ReturnType<typeof sql>) => (await db.execute(s)).rows as any[];
    const liveOrders = sql`o.status NOT IN ('AWAITING_CONFIRMATION','CANCELLED')`;

    const [sales] = await q(sql`
      SELECT COALESCE(SUM(oi.unit_price_cents*oi.quantity),0) AS cents, COALESCE(SUM(oi.quantity),0) AS items,
             COUNT(DISTINCT o.id) AS orders, COUNT(DISTINCT o.account_id) AS accounts
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE ${inRange('o.created_at', r)} AND oi.status='ACTIVE' AND ${liveOrders}`);
    const [disc] = await q(sql`SELECT COALESCE(SUM(amount_cents),0) AS cents, COUNT(*) AS count FROM discounts WHERE ${inRange('created_at', r)} AND NOT EXISTS (SELECT 1 FROM accounts ca WHERE ca.id = discounts.account_id AND ca.status = 'CANCELLED')`);
    const discByUser = await q(sql`
      SELECT u.name, SUM(d.amount_cents) AS cents, COUNT(*) AS count FROM discounts d JOIN users u ON u.id=d.user_id
      WHERE ${inRange('d.created_at', r)} GROUP BY u.name ORDER BY cents DESC`);
    const [canc] = await q(sql`
      SELECT COALESCE(SUM(amount_cents),0) AS cents, COUNT(*) AS count, COALESCE(SUM(amount_cents) FILTER (WHERE was_in_preparation),0) AS loss
      FROM cancellations WHERE ${inRange('created_at', r)}`);
    const byMethod = await q(sql`
      SELECT pm.code, pm.name, COALESCE(SUM(p.amount_cents),0) AS cents, COUNT(p.id) AS count,
             COALESCE(ROUND(SUM(p.amount_cents::bigint * COALESCE(p.taxa_bp, pm.taxa_bp) / 10000.0)),0) AS fees
      FROM payment_methods pm LEFT JOIN payments p ON p.method_id=pm.id AND p.reversed_at IS NULL AND ${inRange('p.created_at', r)}
      GROUP BY pm.id ORDER BY pm.sort_order`);
    const [accs] = await q(sql`
      SELECT COUNT(*) FILTER (WHERE status IN ('OPEN','PARTIALLY_PAID','PAID')) AS open_now,
             COUNT(*) FILTER (WHERE status = 'PENDING') AS pending_now,
             COUNT(*) FILTER (WHERE status = 'CLOSED' AND ${inRange('closed_at', r)}) AS closed_in_range
      FROM accounts`);
    const [pendingSum] = await q(sql`
      SELECT COALESCE(SUM(
        COALESCE((SELECT SUM(oi.unit_price_cents*oi.quantity) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.account_id=a.id AND oi.status='ACTIVE'),0)
        - COALESCE((SELECT SUM(amount_cents) FROM discounts WHERE account_id=a.id),0)
        - COALESCE((SELECT SUM(amount_cents) FROM payments WHERE account_id=a.id AND reversed_at IS NULL),0)),0) AS cents
      FROM accounts a WHERE a.status='PENDING'`);
    const [kitchen] = await q(sql`
      SELECT COUNT(*) FILTER (WHERE status='CONFIRMED') AS new, COUNT(*) FILTER (WHERE status='IN_PREPARATION') AS preparing,
             COUNT(*) FILTER (WHERE status='READY') AS ready, COUNT(*) FILTER (WHERE status='AWAITING_CONFIRMATION') AS awaiting
      FROM orders`);
    const topProducts = await q(sql`
      SELECT oi.product_name AS name, SUM(oi.quantity) AS qty, SUM(oi.unit_price_cents*oi.quantity) AS cents
      FROM orders o JOIN order_items oi ON oi.order_id=o.id
      WHERE ${inRange('o.created_at', r)} AND oi.status='ACTIVE' AND ${liveOrders}
      GROUP BY oi.product_name ORDER BY qty DESC LIMIT 8`);
    const byCategory = await q(sql`
      SELECT COALESCE(c.name, 'Outros') AS name, SUM(oi.unit_price_cents*oi.quantity) AS cents, SUM(oi.quantity) AS qty
      FROM orders o JOIN order_items oi ON oi.order_id=o.id LEFT JOIN products p ON p.id = oi.product_id LEFT JOIN categories c ON c.id = p.category_id
      WHERE ${inRange('o.created_at', r)} AND oi.status='ACTIVE' AND ${liveOrders}
      GROUP BY 1 ORDER BY cents DESC`);
    const byHour = await q(sql`
      SELECT EXTRACT(HOUR FROM o.created_at AT TIME ZONE ${TZ})::int AS h, COUNT(*) AS orders
      FROM orders o WHERE ${inRange('o.created_at', r)} AND ${liveOrders} GROUP BY 1 ORDER BY 1`);
    const [times] = await q(sql`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (ready_at-confirmed_at))/60) AS kitchen,
             COUNT(*) AS n
      FROM orders WHERE goes_to_kitchen AND ready_at IS NOT NULL AND confirmed_at IS NOT NULL AND ${inRange('created_at', r)}
        AND EXTRACT(EPOCH FROM (ready_at-confirmed_at))/60 <= 3*COALESCE(expected_minutes,15)`);
    const lowStock = await q(sql`SELECT id, name, stock_qty AS qty, low_stock_at AS lim FROM products WHERE track_stock AND active AND stock_qty <= low_stock_at ORDER BY stock_qty, name LIMIT 10`);
    // vendido sem estoque registrado (o caixa não trava): o Dono corrige a contagem
    const semEstoque = await q(sql`
      SELECT p.id, p.name, SUM(m.missing) AS faltou, COUNT(*) AS vezes FROM stock_movements m JOIN products p ON p.id = m.product_id
      WHERE m.type = 'DIVERGENCIA' AND m.missing > 0 AND ${inRange('m.created_at', r)}
      GROUP BY p.id, p.name ORDER BY faltou DESC LIMIT 10`);
    const [s] = await db.select().from(restaurantSettings).limit(1);
    // faturamento do ano (só com o controle de MEI ligado; usa o índice por data)
    const ano = { from: `${r.to.slice(0, 4)}-01-01`, to: `${r.to.slice(0, 4)}-12-31` };
    const [year] = s.meiEnabled ? await q(sql`
      SELECT COALESCE(SUM(oi.unit_price_cents*oi.quantity),0)
             - COALESCE((SELECT SUM(amount_cents) FROM discounts WHERE ${inRange('created_at', ano)} AND NOT EXISTS (SELECT 1 FROM accounts ca WHERE ca.id = discounts.account_id AND ca.status = 'CANCELLED')),0) AS cents
      FROM orders o JOIN order_items oi ON oi.order_id=o.id
      WHERE oi.status='ACTIVE' AND ${liveOrders} AND ${inRange('o.created_at', ano)}`) : [{ cents: 0 }];

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
      payments: byMethod.map((m) => ({ code: m.code, name: m.name, cents: n(m.cents), count: n(m.count), feesCents: n(m.fees) })),
      receivedCents: byMethod.reduce((acc, m) => acc + n(m.cents), 0),
      feesCents: byMethod.reduce((acc, m) => acc + n(m.fees), 0),
      // ranking ("mais vendidos") e movimento por hora são leitura da ONE UP: o Dono vê números, não interpretação
      topProducts: me(req).oneup ? topProducts.map((t) => ({ name: t.name, qty: n(t.qty), cents: n(t.cents) })) : [],
      byCategory: byCategory.map((c) => ({ name: c.name, cents: n(c.cents), qty: n(c.qty) })),
      byHour: me(req).oneup ? byHour.map((h) => ({ hour: n(h.h), orders: n(h.orders) })) : [],
      // tempo de cozinha é leitura da ONE UP (mapa de demora): o Dono não recebe
      kitchenMedianMin: !me(req).oneup || times?.kitchen == null ? null : Math.round(Number(times.kitchen)), kitchenSamples: me(req).oneup ? n(times?.n) : 0,
      lowStock: lowStock.map((l) => ({ id: l.id, name: l.name, qty: n(l.qty), lim: n(l.lim) })),
      semEstoque: semEstoque.map((x) => ({ id: x.id, name: x.name, faltou: n(x.faltou), vezes: n(x.vezes) })),
      // instalação própria mostra o aviso de backup; online o backup é da plataforma (sem aviso para o restaurante)
      backup: config.backupDirs.length ? { at: s.lastBackupAt, ok: s.lastBackupOk, info: s.lastBackupInfo, stale: backupAgeH == null || backupAgeH > 48 || s.lastBackupOk === false, configured: true } : null,
      mei: s.meiEnabled ? { yearRevenueCents: n(year.cents), limitCents: s.meiLimitCents } : null,
    };
  });

  // ---------- Insights ----------
  app.get('/api/insights', insightsAdmin, async () => computeInsights(db));

  // ---------- Lembrete de backup externo a cada 30 dias (só ONE UP) ----------
  app.get('/api/oneup/lembretes', { preHandler: requireOneup() }, async () => {
    const cfg = await lerConfiguracoes();
    const ultimo = String(cfg.backup_externo_em ?? ''); const adiado = String(cfg.backup_externo_adiado ?? '');
    const vencido = !ultimo || Date.now() - Date.parse(ultimo) > 30 * 86400_000;
    const mostrar = vencido && (!adiado || Date.parse(adiado) <= Date.now());
    return { backupExterno: { mostrar, ultimoEm: ultimo || null } };
  });
  app.post('/api/oneup/lembretes/backup', { preHandler: requireOneup() }, async (req) => {
    const { acao } = parse(z.object({ acao: z.enum(['feito', 'amanha']) }), req.body);
    const agora = new Date();
    if (acao === 'feito') await aplicarConfiguracoes({ backup_externo_em: agora.toISOString(), backup_externo_adiado: '' }, me(req), 'ONEUP');
    else await aplicarConfiguracoes({ backup_externo_adiado: new Date(agora.getTime() + 20 * 3600_000).toISOString() }, me(req), 'ONEUP');
    return { ok: true };
  });

  // ---------- Base de comparação (só ONE UP): vendas de antes do sistema × período atual ----------
  app.get('/api/oneup/referencias', { preHandler: requireOneup() }, async (req) => {
    const q0 = parse(z.object({ from: dateSchema.optional(), to: dateSchema.optional() }), req.query);
    const hoje = todayLocal();
    const to = q0.to ?? hoje;
    const from = q0.from ?? new Date(Date.parse(`${to}T12:00:00Z`) - 29 * 86400_000).toISOString().slice(0, 10);
    const r = rangeOf({ from, to });
    const dias = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400_000) + 1;
    const refs = await db.select().from(referenciasExternas).orderBy(referenciasExternas.inicio);
    const [s] = (await db.execute(sql`
      SELECT COALESCE(SUM(p.amount_cents),0) AS total,
             COALESCE(SUM(p.amount_cents) FILTER (WHERE NOT pm.is_cash),0) AS sem_dinheiro,
             COUNT(p.id) FILTER (WHERE NOT pm.is_cash) AS vendas_sem_dinheiro,
             COUNT(DISTINCT p.account_id) AS contas,
             COALESCE(ROUND(SUM(p.amount_cents::bigint * COALESCE(p.taxa_bp, pm.taxa_bp) / 10000.0)),0) AS taxas,
             MIN((p.created_at AT TIME ZONE ${TZ})::date)::text AS primeiro
      FROM payments p JOIN payment_methods pm ON pm.id = p.method_id
      WHERE p.reversed_at IS NULL AND ${inRange('p.created_at', r)}`)).rows as any[];
    // dias com o sistema em uso: do primeiro recebimento do período até o fim (sem diluir antes da implantação)
    const inicioUso = s.primeiro && s.primeiro > r.from ? s.primeiro : r.from;
    const fimUso = r.to < hoje ? r.to : hoje;
    const diasUso = s.primeiro ? Math.max(1, dias(inicioUso, fimUso)) : 0;
    const total = n(s.total), semDinheiro = n(s.sem_dinheiro), contas = n(s.contas);
    return {
      referencias: refs.map((x) => {
        const d = dias(x.inicio, x.fim);
        return {
          id: x.id, titulo: x.titulo, origem: x.origem, inicio: x.inicio, fim: x.fim, dias: d, observacao: x.observacao,
          totalCents: x.totalCents, vendas: x.vendas, taxasCents: x.taxasCents, porForma: x.porForma,
          diariaCents: Math.round(x.totalCents / d), mensalCents: Math.round((x.totalCents / d) * 30),
          ticketCents: x.vendas ? Math.round(x.totalCents / x.vendas) : 0,
          vendasPorDia: Math.round((x.vendas / d) * 10) / 10,
          taxaEfetiva: x.totalCents ? x.taxasCents / x.totalCents : 0,
        };
      }),
      atual: {
        from: r.from, to: r.to, diasUso, inicioUso: s.primeiro ? inicioUso : null,
        recebidoCents: total, semDinheiroCents: semDinheiro, vendasSemDinheiro: n(s.vendas_sem_dinheiro), contas, taxasCents: n(s.taxas),
        diariaCents: diasUso ? Math.round(total / diasUso) : 0,
        diariaSemDinheiroCents: diasUso ? Math.round(semDinheiro / diasUso) : 0,
        ticketCents: contas ? Math.round(total / contas) : 0,
      },
    };
  });

  app.get('/api/excluded-days', insightsAdmin, async () =>
    (await db.execute(sql`SELECT to_char(day,'YYYY-MM-DD') AS day, reason FROM excluded_days ORDER BY day DESC`)).rows);
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
    const conds = [sql`TRUE`];
    if (f.date) conds.push(sql`(l.created_at AT TIME ZONE ${TZ})::date = ${f.date}::date`);
    if (f.search) conds.push(sql`unaccent_lower(l.message) LIKE unaccent_lower(${'%' + f.search + '%'})`);
    if (f.before) conds.push(sql`l.id < ${f.before}`);
    const rows = await db.execute(sql`
      SELECT l.id, l.created_at AS "createdAt", l.action, l.entity_type AS "entityType", l.entity_id AS "entityId", l.message,
             u.name AS "userName", l.user_role AS "userRole"
      FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
      WHERE ${sql.join(conds, sql` AND `)} ORDER BY l.id DESC LIMIT 200`);
    return rows.rows;
  });

  app.get('/api/cancellations', admin, async (req) => {
    const f = parse(z.object({ date: dateSchema.optional(), from: dateSchema.optional(), to: dateSchema.optional() }), req.query);
    const hasRange = f.date || f.from || f.to;
    const r = hasRange ? rangeOf(f) : null;
    const rows = await db.execute(sql`
      SELECT c.id, c.created_at AS "createdAt", c.target, c.description, c.amount_cents AS "amountCents", c.reason,
             c.was_in_preparation AS "wasInPreparation", c.status_before AS "statusBefore", c.status_after AS "statusAfter",
             c.stock_returned AS "stockReturned", u.name AS "userName", a.number AS "accountNumber", a.id AS "accountId"
      FROM cancellations c JOIN users u ON u.id = c.user_id JOIN accounts a ON a.id = c.account_id
      WHERE ${r ? inRange('c.created_at', r) : sql`TRUE`}
      ORDER BY c.id DESC LIMIT 300`);
    return rows.rows;
  });

  // ---------- Configurações ----------
  app.get('/api/settings', anyUser, async (req) => {
    const [r] = await db.select().from(restaurantSettings).limit(1);
    const [d] = await db.select().from(deliverySettings).limit(1);
    return {
      restaurant: {
        name: r.name, tagline: r.tagline, isOpen: r.isOpen, qrEnabled: r.qrEnabled, whatsappNumber: r.whatsappNumber,
        meiEnabled: r.meiEnabled, meiLimitCents: r.meiLimitCents,
      },
      delivery: { isOpen: d.isOpen },
      // valores efetivos do catálogo de personalização (o que muda o comportamento das telas)
      config: await configuracoesVisiveis(me(req)),
      // detalhes do servidor só em instalação própria (online, cada empresa não precisa nem deve ver)
      backupDirs: config.baseDomain ? [] : config.backupDirs, demoMode: config.demoMode, lanUrls: config.baseDomain ? [] : lanUrls(),
      publicPort: config.baseDomain ? null : config.publicPort, version: config.version, insightsEnabled: config.insightsEnabled || me(req).oneup,
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
    const map: Record<string, string> = { qrEnabled: 'cardapio_digital_ligado', whatsappNumber: 'whatsapp', name: 'nome', tagline: 'subtitulo', deliveryOpen: 'delivery_aberto', meiEnabled: 'mei_ligado', meiLimitCents: 'mei_limite' };
    const valores: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(b)) if (map[k] && v !== undefined) valores[map[k]] = v;
    if (Object.keys(valores).length) await aplicarConfiguracoes(valores, user);
    if (b.isOpen !== undefined) await db.transaction((tx) => setEstablishmentOpen(tx, user, b.isOpen!, 'configurações'));
    notify.settingsChanged();
    return { ok: true };
  });

  app.post('/api/backup', admin, async (req) => {
    if (!config.backupDirs.length) throw bad('No ONE UP online o backup do banco é automático e diário, feito pela ONE UP.');
    return { results: await runBackupAndRecord(me(req).id, 'backup.manual') };
  });
}
