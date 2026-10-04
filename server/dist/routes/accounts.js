import { respostaCompartilhada } from '../lib/cacheRota.js';
import { z } from 'zod';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { currentContext, db, nextNumber } from '../db/index.js';
import { accounts, cancellations, cashMovements, customers, discounts, orderItems, orders, orderTimeCorrections, paymentMethods, payments, users, } from '../db/schema.js';
import { autorizadoPeloDono, me, requireRole } from '../auth.js';
import { HttpError, bad, brl, centsSchema, conflict, hojeSP, idParam, notFound, parse, reasonSchema } from '../lib/http.js';
import { lerConfig, lerConfiguracoes } from '../services/configuracoes.js';
import { audit } from '../lib/audit.js';
import { idempotent } from '../lib/idempotency.js';
import { notify } from '../realtime.js';
import { accountDetail, accountTotals, assertAccountEditable, assertAccountInScope, currentRegister, getAccount, insertOrder, listAccountsWithTotals, recomputeStatus, requireOpenRegister, requireTakingOrders, stockNeedsForOrder, upsertCustomer, estimateReady, allocateOrders, } from '../services/accounts.js';
import { applyStockForSale, itemHasStock, linkStockToItem, returnStockForItem } from '../services/stock.js';
import { formatarTelefone, mascararTelefone } from '../lib/telefone.js';
/** Busca de clientes do caixa: no máximo 60 buscas por usuário a cada 5 minutos (evita "varrer" a base). */
const LIMITE_BUSCA = { max: 60, janela: 5 * 60_000 };
const buscas = new Map();
setInterval(() => { const t = Date.now(); for (const [k, l] of buscas)
    if (!l.some((x) => t - x < LIMITE_BUSCA.janela))
        buscas.delete(k); }, 10 * 60_000).unref();
function buscaExcedida(userId) {
    const chave = `${currentContext()?.empresaId ?? 0}:${userId}`;
    const t = Date.now();
    const l = (buscas.get(chave) ?? []).filter((x) => t - x < LIMITE_BUSCA.janela);
    if (l.length >= LIMITE_BUSCA.max) {
        buscas.set(chave, l);
        return true;
    }
    l.push(t);
    buscas.set(chave, l);
    return false;
}
export const ORDER_STATUS_PT = {
    NEW: 'Novo', AWAITING_CONFIRMATION: 'Aguardando confirmação', CONFIRMED: 'Novo (cozinha)', IN_PREPARATION: 'Em preparo',
    READY: 'Pronto', DELIVERED: 'Entregue', CANCELLED: 'Cancelado',
};
const ACCOUNT_STATUS_PT = {
    OPEN: 'Aberta', PARTIALLY_PAID: 'Parcialmente paga', PENDING: 'Pendente', PAID: 'Paga', CLOSED: 'Encerrada',
    CANCELLED: 'Cancelada', MERGED: 'Juntada',
};
const itemSchema = z.object({
    productId: z.number().int().positive().nullable().optional(),
    quantity: z.number().int().min(1).max(99),
    optionIds: z.array(z.number().int().positive()).max(20).default([]),
    note: z.string().trim().max(200).nullable().optional(),
    custom: z.object({
        description: z.string().trim().min(2, 'descreva o item').max(80),
        priceCents: centsSchema,
        goesToKitchen: z.boolean().default(false),
    }).nullable().optional(),
}).refine((i) => !!i.productId !== !!i.custom, { message: 'item inválido' });
const itemsSchema = z.array(itemSchema).max(60);
const optText = (n) => z.string().trim().max(n).nullable().optional().transform((v) => v || null);
const consumptionSchema = z.enum(['LOCAL', 'VIAGEM']).default('LOCAL');
const stockDecisionsSchema = z.array(z.union([
    z.object({ productId: z.number().int().positive(), action: z.literal('CORRECT'), newQty: z.number().int().min(0).max(100000) }),
    z.object({ productId: z.number().int().positive(), action: z.literal('RELEASE'), reason: reasonSchema }),
])).max(30).optional();
// Auditoria sem dados pessoais (LGPD): só o número da conta — nunca nome, telefone ou casa do cliente
const label = (a) => `conta #${a.number}`;
async function orderWithAccount(tx, id, lock = false) {
    const q = tx.select().from(orders).where(eq(orders.id, id));
    const [o] = lock ? await q.for('update') : await q;
    if (!o)
        throw notFound('Pedido não encontrado.');
    const acc = await getAccount(tx, o.accountId, lock);
    return { o, acc };
}
async function scoped(user, id) {
    const acc = await getAccount(db, id);
    await assertAccountInScope(db, user, acc);
    return acc;
}
export async function accountRoutes(app) {
    const ops = { preHandler: requireRole('CAIXA') };
    const admin = { preHandler: requireRole('ADMIN') };
    app.get('/api/payment-methods', ops, async (req) => {
        const todas = req.query.todas === '1' && me(req).role === 'ADMIN';
        return db.select().from(paymentMethods).where(todas ? undefined : eq(paymentMethods.active, true)).orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.id));
    });
    // Painel do caixa: contas vivas + prontos + aguardando confirmação (QR)
    app.get('/api/cashier/board', { preHandler: [requireRole('CAIXA'), respostaCompartilhada('board', 'dados', 5000)] }, async () => {
        const live = await listAccountsWithTotals(db, sql `a.status IN ('OPEN','PARTIALLY_PAID','PAID')
      AND (a.origin = 'CAIXA' OR EXISTS (SELECT 1 FROM orders o WHERE o.account_id = a.id AND o.status NOT IN ('AWAITING_CONFIRMATION','CANCELLED')))`, 2000);
        // (antes: só as 200 mais recentes — numa casa cheia, a conta esquecida mais antiga sumia do painel)
        // prontos com os itens resumidos ("2× Jantinha, 1× Coca"); problema de dia anterior não volta para a barra
        // (aparece no "Encerrar o dia")
        const reg0 = await currentRegister(db);
        const desde = reg0 ? sql `${reg0.openedAt}::timestamptz` : sql `date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`;
        const ready = await db.execute(sql `
      SELECT o.id AS "orderId", o.number AS "orderNumber", o.sequence, o.ready_at AS "readyAt", o.problem_note AS "problemNote",
             o.status, o.consumption_type AS "consumptionType", a.id AS "accountId", a.number AS "accountNumber",
             a.customer_name AS "customerName", a.note, a.table_label AS "tableLabel",
             (SELECT string_agg(quantity || '× ' || product_name, ', ' ORDER BY id) FROM order_items WHERE order_id = o.id AND status = 'ACTIVE') AS "itemsText",
             (o.created_at < ${desde}) AS "anterior"
      FROM orders o JOIN accounts a ON a.id = o.account_id
      WHERE o.status = 'READY' OR (o.problem_note IS NOT NULL AND o.status IN ('CONFIRMED','IN_PREPARATION','READY') AND o.created_at >= ${desde})
      ORDER BY o.ready_at NULLS LAST, o.id`);
        const awaiting = await db.execute(sql `
      SELECT o.id AS "orderId", o.number AS "orderNumber", o.note, o.created_at AS "createdAt",
             a.id AS "accountId", a.number AS "accountNumber", a.customer_name AS "customerName", a.note AS "accountNote",
             COALESCE((SELECT SUM(unit_price_cents*quantity) FROM order_items WHERE order_id = o.id AND status='ACTIVE'),0) AS "totalCents"
      FROM orders o JOIN accounts a ON a.id = o.account_id
      WHERE o.status = 'AWAITING_CONFIRMATION' ORDER BY o.id`);
        return { accounts: live, ready: ready.rows, awaiting: awaiting.rows, register: reg0 ? { id: reg0.id, openedAt: reg0.openedAt } : null };
    });
    // Pedidos do dia (desde a abertura do caixa atual; sem caixa aberto: desde a meia-noite)
    app.get('/api/orders/today', { preHandler: [requireRole('CAIXA'), respostaCompartilhada('pedidos-hoje', 'dados', 5000)] }, async () => {
        const reg = await currentRegister(db);
        const since = reg ? sql `${reg.openedAt}::timestamptz` : sql `date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`;
        const rows = (await db.execute(sql `
      SELECT o.id, o.number, o.sequence, o.status, o.origin, o.consumption_type AS "consumptionType", o.created_at AS "createdAt",
             o.ready_at AS "readyAt", o.expected_ready_at AS "expectedReadyAt", o.goes_to_kitchen AS "goesToKitchen",
             a.id AS "accountId", a.number AS "accountNumber", a.customer_name AS "customerName", a.note AS "accountNote",
             a.table_label AS "tableLabel", a.status AS "accountStatus", u.name AS "createdByName",
             COALESCE((SELECT SUM(unit_price_cents*quantity) FROM order_items WHERE order_id = o.id AND status='ACTIVE'),0)::int AS "totalCents",
             (SELECT string_agg(quantity || '× ' || product_name, ', ' ORDER BY id) FROM order_items WHERE order_id = o.id AND status='ACTIVE') AS "itemsText"
      FROM orders o JOIN accounts a ON a.id = o.account_id LEFT JOIN users u ON u.id = o.created_by
      WHERE o.created_at >= ${since}
      ORDER BY o.id DESC LIMIT 500`)).rows;
        // situação por pedido (pago/parcial/pendente) calculada por conta — mesma regra de accountTotals + allocateOrders,
        // mas em 2 consultas agrupadas para todas as contas do dia (antes eram 2 consultas POR conta).
        const accIds = [...new Set(rows.map((r) => Number(r.accountId)))];
        const situation = new Map();
        if (accIds.length) {
            const ids = `{${accIds.join(',')}}`;
            // descontos e pagamentos (não estornados) somados por conta
            const totais = (await db.execute(sql `
        SELECT 'd' AS k, account_id AS "accountId", SUM(amount_cents) AS v FROM discounts
          WHERE account_id = ANY(${ids}::int[]) GROUP BY account_id
        UNION ALL
        SELECT 'p', account_id, SUM(amount_cents) FROM payments
          WHERE account_id = ANY(${ids}::int[]) AND reversed_at IS NULL GROUP BY account_id`)).rows;
            const descontos = new Map(), pagos = new Map();
            for (const t of totais)
                (t.k === 'd' ? descontos : pagos).set(Number(t.accountId), Number(t.v));
            // todos os pedidos dessas contas com o total dos itens ativos, em ordem de conta e de pedido
            const pedidos = (await db.execute(sql `
        SELECT o.id, o.account_id AS "accountId", o.status,
               COALESCE((SELECT SUM(unit_price_cents * quantity) FROM order_items WHERE order_id = o.id AND status = 'ACTIVE'), 0)::int AS total
        FROM orders o
        WHERE o.account_id = ANY(${ids}::int[])
        ORDER BY o.account_id, o.id`)).rows;
            const porConta = new Map();
            for (const o of pedidos) {
                const acc = Number(o.accountId);
                if (!porConta.has(acc))
                    porConta.set(acc, []);
                porConta.get(acc).push({ id: o.id, status: o.status, totalCents: Number(o.total) });
            }
            for (const accId of accIds) {
                const alloc = allocateOrders(porConta.get(accId) ?? [], descontos.get(accId) ?? 0, pagos.get(accId) ?? 0);
                for (const [oid, v] of alloc)
                    situation.set(oid, v.situation);
            }
        }
        return rows.map((r) => ({ ...r, situation: situation.get(r.id) ?? '—' }));
    });
    // Detalhe de um pedido (sem sair da tela)
    app.get('/api/orders/:id', ops, async (req) => {
        const { id } = parse(idParam, req.params);
        const user = me(req);
        const { o, acc } = await orderWithAccount(db, id);
        await assertAccountInScope(db, user, acc);
        const detail = await accountDetail(db, acc.id);
        const order = detail.orders.find((x) => x.id === id);
        const userIds = [o.createdBy, o.confirmedBy, o.startedBy, o.readyBy, o.deliveredBy].filter(Boolean);
        const names = userIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : [];
        const nm = (uid) => names.find((n) => n.id === uid)?.name ?? null;
        const timeline = [
            { step: 'Lançado', at: o.createdAt, by: nm(o.createdBy) },
            ...(o.origin === 'QR_CODE' ? [{ step: 'Confirmado pelo caixa', at: o.confirmedAt, by: nm(o.confirmedBy) }] : []),
            ...(o.goesToKitchen ? [
                { step: 'Enviado à cozinha', at: o.confirmedAt, by: nm(o.confirmedBy) },
                { step: 'Iniciou o preparo', at: o.startedAt, by: nm(o.startedBy) },
                { step: 'Pronto', at: o.readyAt, by: nm(o.readyBy) },
            ] : []),
            { step: 'Entregue', at: o.deliveredAt, by: nm(o.deliveredBy) },
        ];
        let auditRows = [];
        let corrections = [];
        if (user.role === 'ADMIN') {
            auditRows = (await db.execute(sql `
        SELECT l.created_at AS "createdAt", l.message, l.user_role AS "userRole" FROM audit_logs l
        WHERE l.entity_type = 'order' AND l.entity_id = ${id} ORDER BY l.id`)).rows;
            corrections = await db.select().from(orderTimeCorrections).where(eq(orderTimeCorrections.orderId, id)).orderBy(asc(orderTimeCorrections.id));
        }
        return {
            order,
            account: {
                id: detail.id, number: detail.number, customerName: detail.customerName, note: detail.note, contact: detail.contact,
                phone: detail.phone, tableLabel: detail.tableLabel, status: detail.status, totals: detail.totals,
            },
            payments: detail.payments, discounts: detail.discounts,
            timeline, audit: auditRows, corrections,
        };
    });
    // Histórico / busca de contas (caixa: somente escopo do dia)
    app.get('/api/accounts', ops, async (req) => {
        const user = me(req);
        const q = parse(z.object({
            status: z.string().optional(), search: z.string().trim().max(60).optional(),
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        }), req.query);
        const conds = [sql `TRUE`];
        if (user.role !== 'ADMIN') {
            const reg = await currentRegister(db);
            conds.push(reg
                ? sql `(a.status IN ('OPEN','PARTIALLY_PAID','PAID','PENDING') OR a.opened_at >= ${reg.openedAt} OR a.closed_at >= ${reg.openedAt})`
                : sql `a.status IN ('OPEN','PARTIALLY_PAID','PAID','PENDING')`);
        }
        if (q.status) {
            const list = q.status.split(',').filter((s) => ['OPEN', 'PARTIALLY_PAID', 'PENDING', 'PAID', 'CLOSED', 'CANCELLED', 'MERGED'].includes(s));
            if (list.length)
                conds.push(sql `a.status IN (${sql.join(list.map((s) => sql `${s}`), sql `, `)})`);
        }
        if (q.date)
            conds.push(sql `(a.opened_at AT TIME ZONE 'America/Sao_Paulo')::date = ${q.date}::date`);
        if (q.search) {
            const n = Number(q.search.replace('#', ''));
            if (Number.isInteger(n) && n > 0)
                conds.push(sql `a.number = ${n}`);
            else
                conds.push(sql `(unaccent_lower(coalesce(a.customer_name,'')) LIKE unaccent_lower(${'%' + q.search + '%'})
        OR unaccent_lower(coalesce(a.note,'')) LIKE unaccent_lower(${'%' + q.search + '%'})
        OR unaccent_lower(coalesce(a.contact,'')) LIKE unaccent_lower(${'%' + q.search + '%'}))`);
        }
        return listAccountsWithTotals(db, sql.join(conds, sql ` AND `), 300);
    });
    // A receber: etiqueta venceu / hoje / sem data / em dia, ordenado por urgência (o mais atrasado primeiro)
    app.get('/api/accounts/receivable', ops, async () => {
        const hoje = hojeSP();
        const ordem = { venceu: 0, hoje: 1, sem_data: 2, em_dia: 3 };
        const lista = (await listAccountsWithTotals(db, sql `a.status = 'PENDING'`, 500)).map((a) => ({
            ...a,
            situacao: (!a.promisedDate ? 'sem_data' : a.promisedDate < hoje ? 'venceu' : a.promisedDate === hoje ? 'hoje' : 'em_dia'),
        }));
        return lista.sort((x, y) => ordem[x.situacao] - ordem[y.situacao]
            || (x.promisedDate ?? '').localeCompare(y.promisedDate ?? '')
            || String(x.pendingAt ?? '').localeCompare(String(y.pendingAt ?? '')));
    });
    // Cobrança pelo WhatsApp: DESLIGADA por padrão; só a ONE UP liga (por restaurante). Nunca envia sozinho.
    app.get('/api/accounts/receivable/cobranca', ops, async () => {
        const cfg = await lerConfiguracoes();
        return { ligada: cfg.cobranca_whatsapp === true, mensagem: cfg.cobranca_whatsapp === true ? String(cfg.mensagem_cobranca ?? '') : null, restaurante: String(cfg.nome ?? '') };
    });
    app.post('/api/accounts/:id/cobranca', ops, async (req) => {
        const { id } = parse(idParam, req.params);
        const user = me(req);
        if ((await lerConfig('cobranca_whatsapp')) !== true)
            throw new HttpError(403, 'Cobrança pelo WhatsApp não está ligada neste restaurante.', 'COBRANCA_DESLIGADA');
        await db.transaction(async (tx) => {
            const acc = await getAccount(tx, id, true);
            if (acc.status !== 'PENDING')
                throw conflict('Só contas a receber podem ser cobradas.');
            await tx.update(accounts).set({ ultimaCobrancaEm: new Date(), ultimaCobrancaPor: user.id }).where(eq(accounts.id, id));
            await audit(tx, { userId: user.id, action: 'account.cobranca', entityType: 'account', entityId: id, message: `${user.name} abriu a cobrança pelo WhatsApp da conta #${acc.number}.` });
        });
        notify.accountsChanged(id);
        return { ok: true };
    });
    app.get('/api/accounts/:id', ops, async (req) => {
        const { id } = parse(idParam, req.params);
        await scoped(me(req), id);
        return accountDetail(db, id);
    });
    // Sugestão de clientes (cadastro leve) com alerta de pendência.
    // LGPD: 3+ letras, sem anonimizados/juntados, telefone mascarado para o Caixa (o vínculo é pelo id) e limite de buscas.
    app.get('/api/customers/suggest', ops, async (req) => {
        const { q } = parse(z.object({ q: z.string().trim().min(3, 'digite pelo menos 3 letras').max(60) }), req.query);
        const user = me(req);
        if (buscaExcedida(user.id))
            throw new HttpError(429, 'Muitas buscas de clientes em pouco tempo. Aguarde alguns minutos.');
        const like = '%' + q + '%';
        const digitos = q.replace(/\D/g, '');
        const porTelefone = digitos.length >= 3 ? sql `OR regexp_replace(coalesce(c.phone,''), '\\D', '', 'g') LIKE ${'%' + digitos + '%'}` : sql ``;
        const rows = await db.execute(sql `
      SELECT c.id, c.name, c.contact, c.phone,
        COALESCE(p.pending, 0)::int AS "pendingCents", p.since AS "pendingSince", COALESCE(p.n,0)::int AS "pendingCount"
      FROM customers c
      LEFT JOIN LATERAL (
        SELECT SUM(
          COALESCE((SELECT SUM(oi.unit_price_cents*oi.quantity) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.account_id=a.id AND oi.status='ACTIVE'),0)
          - COALESCE((SELECT SUM(amount_cents) FROM discounts WHERE account_id=a.id),0)
          - COALESCE((SELECT SUM(amount_cents) FROM payments WHERE account_id=a.id AND reversed_at IS NULL),0)) AS pending,
          MIN(a.pending_at) AS since, COUNT(*) AS n
        FROM accounts a WHERE a.customer_id = c.id AND a.status = 'PENDING'
      ) p ON TRUE
      WHERE c.anonimizado_em IS NULL AND c.juntado_em IS NULL
        AND (unaccent_lower(c.name) LIKE unaccent_lower(${like}) OR unaccent_lower(coalesce(c.contact,'')) LIKE unaccent_lower(${like})
         ${porTelefone})
      ORDER BY p.pending DESC NULLS LAST, c.name LIMIT 8`);
        const lista = rows.rows;
        return lista.map((c) => ({ ...c, phone: user.role === 'ADMIN' ? formatarTelefone(c.phone) : mascararTelefone(c.phone) }));
    });
    // Nova conta (opcionalmente já com o primeiro pedido)
    app.post('/api/accounts', ops, async (req) => {
        const b = parse(z.object({
            customerName: optText(80), note: optText(200), contact: optText(120), phone: optText(30), tableLabel: optText(20),
            customerId: z.number().int().positive().nullable().optional(),
            items: itemsSchema.default([]), orderNote: optText(200), consumptionType: consumptionSchema,
            stockDecisions: stockDecisionsSchema,
        }), req.body);
        const user = me(req);
        // Campos obrigatórios definidos pelo Dono em Configurações
        const cfg = await lerConfiguracoes();
        const falta = [];
        if (cfg.exigir_nome && !b.customerName)
            falta.push('nome do cliente');
        if (cfg.exigir_telefone && !b.phone)
            falta.push('telefone');
        if (cfg.exigir_mesa && !b.tableLabel)
            falta.push(String(cfg.rotulo_mesa ?? 'mesa').toLowerCase());
        if (falta.length)
            throw bad(`Preencha: ${falta.join(', ')}.`);
        // Toda conta precisa ser identificável: pelo menos um entre nome, telefone, casa, mesa ou observação (2+ letras/números)
        // mesa e telefone: 1 caractere já identifica ("Mesa 5"); nome, casa e observação: 2 ou mais
        const real = (t, min) => (t ?? '').replace(/[^\p{L}\p{N}]/gu, '').length >= min;
        if (!b.customerId && !(real(b.tableLabel, 1) || real(b.phone, 1) || real(b.customerName, 2) || real(b.contact, 2) || real(b.note, 2))) {
            throw bad('Para abrir o pedido, preencha pelo menos um: nome, telefone, mesa ou observação.');
        }
        if (b.customerId) {
            // cliente escolhido na sugestão: a conta leva o nome/telefone do cadastro (o caixa só viu o telefone mascarado)
            const [c] = await db.select({ id: customers.id, name: customers.name, phone: customers.phone, anonimizadoEm: customers.anonimizadoEm, juntadoEm: customers.juntadoEm })
                .from(customers).where(eq(customers.id, b.customerId));
            if (!c || c.anonimizadoEm)
                throw bad('Cliente não encontrado.');
            if (c.juntadoEm)
                b.customerId = c.juntadoEm;
            if (b.phone?.includes('*'))
                b.phone = null;
            if (!b.customerName)
                b.customerName = c.name;
            if (!b.phone && c.phone && !c.juntadoEm)
                b.phone = formatarTelefone(c.phone);
        }
        else if (b.phone?.includes('*'))
            b.phone = null;
        const result = await idempotent(req, 'accounts.create', () => db.transaction(async (tx) => {
            const reg = await requireTakingOrders(tx);
            const customerId = b.customerId ?? await upsertCustomer(tx, b.customerName, b.contact, b.phone);
            const number = await nextNumber(tx, 'account');
            const [acc] = await tx.insert(accounts).values({
                number, customerName: b.customerName, note: b.note, contact: b.contact, phone: b.phone, tableLabel: b.tableLabel,
                customerId, cashRegisterId: reg.id, openedBy: user.id,
            }).returning();
            await audit(tx, { userId: user.id, action: 'account.create', entityType: 'account', entityId: acc.id, message: `${user.name} abriu a ${label(acc)}.` });
            let order = null;
            if (b.items.length) {
                const r = await insertOrder(tx, {
                    accountId: acc.id, items: b.items, note: b.orderNote, userId: user.id, origin: 'CAIXA', cashRegisterId: reg.id,
                    consumptionType: b.consumptionType, stockDecisions: b.stockDecisions,
                });
                order = r.order;
                await audit(tx, {
                    userId: user.id, action: 'order.create', entityType: 'order', entityId: order.id,
                    message: `${user.name} lançou o pedido #${order.number} na ${label(acc)} — ${r.itemCount} item(ns), ${brl(r.totalCents)}${order.consumptionType === 'VIAGEM' ? ', PARA VIAGEM' : ''}${order.goesToKitchen ? ', enviado para a cozinha' : ' (balcão)'}.`,
                });
                await recomputeStatus(tx, acc.id);
            }
            return {
                id: acc.id, number: acc.number, orderNumber: order?.number ?? null, orderId: order?.id ?? null,
                goesToKitchen: order?.goesToKitchen ?? false, expectedReadyAt: order?.expectedReadyAt ?? null,
            };
        }));
        if (result.goesToKitchen)
            notify.kitchenNewOrder({ orderNumber: result.orderNumber, accountNumber: result.number, sequence: 1 });
        notify.ordersChanged();
        notify.accountsChanged(result.id);
        notify.stockMaybeChanged();
        return result;
    });
    app.patch('/api/accounts/:id', ops, async (req) => {
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({
            customerName: optText(80), note: optText(200), contact: optText(120), phone: optText(30), tableLabel: optText(20),
        }), req.body);
        const user = me(req);
        await db.transaction(async (tx) => {
            const acc = await getAccount(tx, id, true);
            await assertAccountInScope(tx, user, acc);
            assertAccountEditable(acc.status);
            const set = {};
            for (const k of ['customerName', 'note', 'contact', 'phone', 'tableLabel'])
                if (b[k] !== undefined)
                    set[k] = b[k];
            const nextName = set.customerName !== undefined ? set.customerName : acc.customerName;
            const nextContact = set.contact !== undefined ? set.contact : acc.contact;
            const nextPhone = set.phone !== undefined ? set.phone : acc.phone;
            if (acc.status === 'PENDING' && (!nextName || (!nextContact && !nextPhone))) {
                throw bad('Conta pendente precisa de nome e casa/telefone.');
            }
            // corrigir o telefone/nome na conta corrige o cliente dela (não cria outro)
            const cid = await upsertCustomer(tx, nextName, nextContact, nextPhone, acc.customerId);
            if (cid)
                set.customerId = cid;
            await tx.update(accounts).set(set).where(eq(accounts.id, id));
            // auditoria sem dados pessoais: diz O QUE mudou, não os valores de nome/telefone/casa
            const NOMES = { customerName: 'nome', note: 'observação', contact: 'contato', phone: 'telefone', tableLabel: 'mesa' };
            const mudou = ['customerName', 'note', 'contact', 'phone', 'tableLabel'].filter((k) => set[k] !== undefined && set[k] !== acc[k]);
            await audit(tx, {
                userId: user.id, action: 'account.update', entityType: 'account', entityId: id,
                message: `${user.name} alterou a identificação da ${label(acc)}${mudou.length ? ` (${mudou.map((k) => NOMES[k]).join(', ')})` : ''}${cid ? ` — cliente #${cid}` : ''}.`,
                data: { campos: mudou, ...(mudou.includes('tableLabel') ? { mesa: { antes: acc.tableLabel, depois: set.tableLabel } } : {}), clienteAntes: acc.customerId, clienteDepois: cid ?? acc.customerId },
            });
        });
        notify.accountsChanged(id);
        notify.ordersChanged();
        return { ok: true };
    });
    // Novo pedido / complemento na mesma conta (a cozinha recebe só este lote)
    app.post('/api/accounts/:id/orders', ops, async (req) => {
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({
            items: itemsSchema.min(1, 'adicione ao menos um produto'), note: optText(200),
            consumptionType: consumptionSchema, stockDecisions: stockDecisionsSchema,
        }), req.body);
        const user = me(req);
        const r = await idempotent(req, 'orders.create', () => db.transaction(async (tx) => {
            const acc = await getAccount(tx, id, true);
            await assertAccountInScope(tx, user, acc);
            assertAccountEditable(acc.status);
            if (acc.status === 'PENDING')
                throw conflict('Conta pendente não recebe novos pedidos. Abra uma nova conta.');
            const reg = await requireTakingOrders(tx);
            const r = await insertOrder(tx, {
                accountId: id, items: b.items, note: b.note, userId: user.id, origin: 'CAIXA', cashRegisterId: reg.id,
                consumptionType: b.consumptionType, stockDecisions: b.stockDecisions,
            });
            const kind = r.order.sequence > 1 ? 'complemento' : 'pedido';
            await audit(tx, {
                userId: user.id, action: 'order.create', entityType: 'order', entityId: r.order.id,
                message: `${user.name} lançou ${kind} #${r.order.number} na ${label(acc)} — ${r.itemCount} item(ns), ${brl(r.totalCents)}${r.order.consumptionType === 'VIAGEM' ? ', PARA VIAGEM' : ''}${r.order.goesToKitchen ? ', enviado para a cozinha (somente estes itens)' : ' (balcão)'}.`,
            });
            await recomputeStatus(tx, id);
            return {
                orderId: r.order.id, orderNumber: r.order.number, accountNumber: acc.number, sequence: r.order.sequence,
                goesToKitchen: r.order.goesToKitchen, expectedReadyAt: r.order.expectedReadyAt,
            };
        }));
        if (r.goesToKitchen)
            notify.kitchenNewOrder({ orderNumber: r.orderNumber, accountNumber: r.accountNumber, sequence: r.sequence });
        notify.ordersChanged();
        notify.accountsChanged(id);
        notify.stockMaybeChanged();
        return r;
    });
    // Alterar tipo de consumo (até ficar pronto)
    app.patch('/api/orders/:id/consumption', ops, async (req) => {
        const { id } = parse(idParam, req.params);
        const { consumptionType } = parse(z.object({ consumptionType: z.enum(['LOCAL', 'VIAGEM']) }), req.body);
        const user = me(req);
        await db.transaction(async (tx) => {
            const { o, acc } = await orderWithAccount(tx, id, true);
            await assertAccountInScope(tx, user, acc);
            if (['READY', 'DELIVERED', 'CANCELLED'].includes(o.status))
                throw conflict('O tipo de consumo só pode mudar antes de o pedido ficar pronto.');
            if (o.consumptionType === consumptionType)
                return;
            await tx.update(orders).set({ consumptionType }).where(eq(orders.id, id));
            await audit(tx, { userId: user.id, action: 'order.consumption', entityType: 'order', entityId: id, message: `${user.name} alterou o pedido #${o.number} para ${consumptionType === 'VIAGEM' ? 'PARA VIAGEM' : 'COMER NO LOCAL'}.` });
        });
        notify.ordersChanged();
        return { ok: true };
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
        const out = await idempotent(req, 'payments.create', () => db.transaction(async (tx) => {
            const acc = await getAccount(tx, id, true);
            await assertAccountInScope(tx, user, acc);
            assertAccountEditable(acc.status);
            const reg = await requireOpenRegister(tx);
            const t = await accountTotals(tx, id);
            const sum = b.payments.reduce((s, p) => s + p.amountCents, 0);
            if (t.balance <= 0)
                throw conflict('Esta conta não tem saldo a pagar.');
            if (sum > t.balance)
                throw bad(`O valor (${brl(sum)}) é maior que o saldo da conta (${brl(t.balance)}). Para dinheiro, informe o valor recebido para calcular o troco.`);
            const methods = await tx.select().from(paymentMethods).where(inArray(paymentMethods.id, b.payments.map((p) => p.methodId)));
            const parts = [];
            for (const p of b.payments) {
                const m = methods.find((x) => x.id === p.methodId && x.active);
                if (!m)
                    throw bad('Forma de pagamento inválida.');
                if (p.tenderedCents != null) {
                    if (!m.isCash)
                        throw bad('Valor recebido/troco só se aplica a dinheiro.');
                    if (p.tenderedCents < p.amountCents)
                        throw bad('O valor recebido em dinheiro é menor que o valor pago.');
                }
                await tx.insert(payments).values({
                    accountId: id, methodId: m.id, amountCents: p.amountCents, tenderedCents: p.tenderedCents ?? null,
                    cashRegisterId: reg.id, userId: user.id, taxaBp: m.taxaBp,
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
            return { status, balance: newBalance, paid: t.paid + sum, total: t.total };
        }));
        notify.accountsChanged(id);
        notify.registerChanged();
        notify.ordersChanged();
        return out;
    });
    app.post('/api/accounts/:id/discounts', ops, async (req) => {
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({ amountCents: centsSchema, reason: reasonSchema }), req.body);
        const user = me(req);
        await idempotent(req, 'account.discount', () => db.transaction(async (tx) => {
            const acc = await getAccount(tx, id, true);
            await assertAccountInScope(tx, user, acc);
            assertAccountEditable(acc.status);
            const t = await accountTotals(tx, id);
            if (b.amountCents > t.balance)
                throw bad(`O desconto não pode ser maior que o saldo em aberto (${brl(t.balance)}).`);
            // perdoar fiado é decisão do Dono: o caixa não "ajusta" conta a receber (o dinheiro sumiria sem diferença no caixa)
            if (user.role !== 'ADMIN' && !autorizadoPeloDono(req) && acc.status === 'PENDING')
                throw new HttpError(403, 'Conta a receber: só o Dono pode dar desconto. Para quitar, use Receber.', 'DESCONTO_FIADO_SO_DONO');
            if (user.role !== 'ADMIN' && !autorizadoPeloDono(req)) {
                const limite = await lerConfig('desconto_max_caixa', tx);
                if (limite != null && t.subtotal > 0) {
                    const jaDados = (await tx.select({ v: discounts.amountCents }).from(discounts).where(eq(discounts.accountId, id))).reduce((s2, x) => s2 + x.v, 0);
                    if ((jaDados + b.amountCents) * 100 > limite * t.subtotal) {
                        throw new HttpError(403, `Desconto acima do limite do caixa (${limite}% da conta). Peça ao Dono.`, 'DESCONTO_ACIMA_LIMITE');
                    }
                }
            }
            const reg = await currentRegister(tx);
            const kind = user.role === 'ADMIN' ? 'DISCOUNT' : 'ADJUSTMENT';
            await tx.insert(discounts).values({
                accountId: id, kind, amountCents: b.amountCents, reason: b.reason, userId: user.id, cashRegisterId: reg?.id ?? null,
                totalBeforeCents: t.total, totalAfterCents: t.total - b.amountCents,
            });
            await audit(tx, {
                userId: user.id, action: 'discount.create', entityType: 'account', entityId: id,
                message: `${user.name} concedeu ${kind === 'DISCOUNT' ? 'desconto' : 'ajuste'} de ${brl(b.amountCents)} na ${label(acc)} (total ${brl(t.total)} → ${brl(t.total - b.amountCents)}). Motivo: ${b.reason}`,
            });
            await recomputeStatus(tx, id);
            return { ok: true };
        }));
        notify.accountsChanged(id);
        notify.registerChanged();
        return { ok: true };
    });
    // Cliente saiu sem pagar → PENDENTE (exige nome + contato)
    app.post('/api/accounts/:id/pending', ops, async (req) => {
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({
            customerName: z.string().trim().min(2, 'informe o nome do cliente').max(80),
            contact: z.string().trim().min(2, 'informe casa ou telefone').max(120),
            note: optText(200),
            promisedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'data inválida').nullable().optional(),
        }), req.body);
        if (b.promisedDate && b.promisedDate < hojeSP())
            throw bad('A data combinada não pode ser no passado.');
        const user = me(req);
        await db.transaction(async (tx) => {
            const acc = await getAccount(tx, id, true);
            await assertAccountInScope(tx, user, acc);
            if (!['OPEN', 'PARTIALLY_PAID'].includes(acc.status))
                throw conflict('Só contas abertas com saldo podem virar pendentes.');
            const t = await accountTotals(tx, id);
            if (t.balance <= 0)
                throw conflict('Esta conta não tem saldo em aberto.');
            const customerId = await upsertCustomer(tx, b.customerName, b.contact, acc.phone, acc.customerId);
            await tx.update(accounts).set({
                status: 'PENDING', customerName: b.customerName, contact: b.contact, note: b.note ?? acc.note, customerId,
                pendingAt: new Date(), pendingBy: user.id, promisedDate: b.promisedDate ?? null,
            }).where(eq(accounts.id, id));
            await audit(tx, {
                userId: user.id, action: 'account.pending', entityType: 'account', entityId: id,
                message: `${user.name} marcou a conta #${acc.number}${customerId ? ` (cliente #${customerId})` : ''} como PENDENTE — saldo ${brl(t.balance)}${b.promisedDate ? `, combinado para ${b.promisedDate.split('-').reverse().join('/')}` : ''}.`,
            });
        });
        notify.accountsChanged(id);
        notify.registerChanged();
        return { ok: true };
    });
    app.post('/api/accounts/:id/close', ops, async (req) => {
        const { id } = parse(idParam, req.params);
        const user = me(req);
        await db.transaction(async (tx) => {
            const acc = await getAccount(tx, id, true);
            await assertAccountInScope(tx, user, acc);
            assertAccountEditable(acc.status);
            const t = await accountTotals(tx, id);
            if (t.subtotal <= 0)
                throw conflict('Conta sem valor. Se nada foi consumido, cancele a conta.');
            if (t.balance !== 0)
                throw conflict(`Ainda há saldo de ${brl(t.balance)}. Receba o pagamento ou marque como pendente.`);
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
            if (!['CLOSED', 'PENDING'].includes(acc.status))
                throw conflict('Só contas encerradas ou pendentes podem ser reabertas.');
            await tx.update(accounts).set({ status: 'OPEN', closedAt: null, closedBy: null }).where(eq(accounts.id, id));
            await recomputeStatus(tx, id);
            await audit(tx, { userId: user.id, action: 'account.reopen', entityType: 'account', entityId: id, message: `${user.name} reabriu a ${label(acc)} (estava ${ACCOUNT_STATUS_PT[acc.status]}). Motivo: ${reason}` });
        });
        notify.accountsChanged(id);
        return { ok: true };
    });
    app.post('/api/accounts/:id/cancel', ops, async (req) => {
        const { id } = parse(idParam, req.params);
        const { reason, returnStock } = parse(z.object({ reason: reasonSchema, returnStock: z.boolean().default(true) }), req.body);
        const user = me(req);
        await db.transaction(async (tx) => {
            const acc = await getAccount(tx, id, true);
            await assertAccountInScope(tx, user, acc);
            assertAccountEditable(acc.status);
            const t = await accountTotals(tx, id);
            if (t.paid > 0)
                throw conflict('Esta conta já tem pagamentos. Peça ao Dono para estornar antes de cancelar.');
            const ords = await tx.select().from(orders).where(eq(orders.accountId, id));
            // a mesma trava do cancelamento de pedido: comida que já saiu da cozinha não some cancelando a conta inteira
            await exigirDonoSeProntoNaCozinha(tx, user, ords.some((o) => o.goesToKitchen && ['READY', 'DELIVERED'].includes(o.status)), req);
            const reg = await currentRegister(tx);
            let lost = false;
            let stockBack = false;
            for (const o of ords) {
                if (o.status === 'CANCELLED')
                    continue;
                if (['IN_PREPARATION', 'READY', 'DELIVERED'].includes(o.status))
                    lost = true;
                const items = await tx.select().from(orderItems).where(and(eq(orderItems.orderId, o.id), eq(orderItems.status, 'ACTIVE')));
                for (const it of items) {
                    if (returnStock)
                        stockBack = (await returnStockForItem(tx, it.id, it.quantity, user.id, `Cancelamento da conta #${acc.number}`)) || stockBack;
                }
                await tx.update(orderItems).set({ status: 'CANCELLED' }).where(and(eq(orderItems.orderId, o.id), eq(orderItems.status, 'ACTIVE')));
                await tx.update(orders).set({ status: 'CANCELLED' }).where(eq(orders.id, o.id));
            }
            await tx.update(accounts).set({ status: 'CANCELLED', closedAt: new Date(), closedBy: user.id }).where(eq(accounts.id, id));
            await tx.insert(cancellations).values({
                target: 'ACCOUNT', accountId: id, description: `Conta #${acc.number}`, amountCents: t.subtotal,
                wasInPreparation: lost, reason, userId: user.id, cashRegisterId: reg?.id ?? null,
                statusBefore: acc.status, statusAfter: 'CANCELLED', stockReturned: stockBack,
            });
            await audit(tx, { userId: user.id, action: 'account.cancel', entityType: 'account', entityId: id, message: `${user.name} cancelou a ${label(acc)} (${brl(t.subtotal)}; ${ACCOUNT_STATUS_PT[acc.status]} → Cancelada). Motivo: ${reason}` });
        });
        notify.kitchenCancelled({ message: 'Uma conta foi cancelada' });
        notify.ordersChanged();
        notify.accountsChanged(id);
        notify.registerChanged();
        notify.stockMaybeChanged();
        return { ok: true };
    });
    // ----- Cancelamentos de item (total ou parcial) e de pedido -----
    const LOSS_STATUSES = ['IN_PREPARATION', 'READY', 'DELIVERED'];
    app.post('/api/order-items/:id/cancel', ops, async (req) => {
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({
            reason: reasonSchema, quantity: z.number().int().positive().optional(), returnStock: z.boolean().default(true),
        }), req.body);
        const user = me(req);
        const info = await db.transaction(async (tx) => {
            const [it] = await tx.select().from(orderItems).where(eq(orderItems.id, id)).for('update');
            if (!it)
                throw notFound('Item não encontrado.');
            if (it.status === 'CANCELLED')
                throw conflict('Item já cancelado.');
            const { o, acc } = await orderWithAccount(tx, it.orderId, true);
            await assertAccountInScope(tx, user, acc);
            assertAccountEditable(acc.status);
            await exigirDonoSeProntoNaCozinha(tx, user, it.goesToKitchen && ['READY', 'DELIVERED'].includes(o.status), req);
            const qty = Math.min(b.quantity ?? it.quantity, it.quantity);
            const partial = qty < it.quantity;
            const value = it.unitPriceCents * qty;
            const t = await accountTotals(tx, acc.id);
            if (t.total - value < t.paid)
                throw conflict('O valor já pago ficaria maior que o total. Peça ao Dono para estornar um pagamento antes.');
            const lost = LOSS_STATUSES.includes(o.status);
            // o item vendido é imutável: cancela a linha inteira e, se parcial, relança o restante com o mesmo preço congelado
            await tx.update(orderItems).set({ status: 'CANCELLED' }).where(eq(orderItems.id, id));
            let stockBack = false;
            if (b.returnStock) {
                stockBack = await returnStockForItem(tx, id, qty, user.id, `Cancelamento de ${qty}× ${it.productName} (pedido #${o.number})`);
            }
            if (partial) {
                const { id: _omit, status: _s, ...rest } = it;
                const [keep] = await tx.insert(orderItems).values({ ...rest, quantity: it.quantity - qty, status: 'ACTIVE' }).returning({ id: orderItems.id });
                await linkStockToItem(tx, id, keep.id, user.id);
            }
            const reg = await currentRegister(tx);
            await tx.insert(cancellations).values({
                target: 'ITEM', accountId: acc.id, orderId: o.id, orderItemId: id, quantity: qty,
                description: partial ? `${qty}× ${it.productName} (de ${it.quantity})` : `${qty}× ${it.productName}`,
                amountCents: value, wasInPreparation: lost, reason: b.reason, userId: user.id, cashRegisterId: reg?.id ?? null,
                statusBefore: ORDER_STATUS_PT[o.status], statusAfter: partial ? `${it.quantity - qty} mantido(s)` : 'Cancelado', stockReturned: stockBack,
            });
            const [{ n }] = (await tx.execute(sql `SELECT COUNT(*)::int AS n FROM order_items WHERE order_id = ${o.id} AND status = 'ACTIVE'`)).rows;
            if (Number(n) === 0)
                await tx.update(orders).set({ status: 'CANCELLED' }).where(eq(orders.id, o.id));
            await audit(tx, {
                userId: user.id, action: 'item.cancel', entityType: 'order', entityId: o.id,
                message: `${user.name} cancelou ${qty}× ${it.productName}${partial ? ` (de ${it.quantity})` : ''} (${brl(value)}) do pedido #${o.number}, ${label(acc)}${lost ? ' — PERDA (já em preparo/entregue)' : ''}${stockBack ? ' — estoque devolvido' : ''}. Motivo: ${b.reason}`,
            });
            await recomputeStatus(tx, acc.id);
            return { o, acc, it, qty };
        });
        if (info.it.goesToKitchen && ['CONFIRMED', 'IN_PREPARATION', 'READY'].includes(info.o.status)) {
            notify.kitchenCancelled({ message: `Pedido #${info.o.number}: ${info.qty}× ${info.it.productName} CANCELADO` });
        }
        notify.ordersChanged();
        notify.accountsChanged(info.acc.id);
        notify.registerChanged();
        notify.stockMaybeChanged();
        return { ok: true };
    });
    app.post('/api/orders/:id/cancel', ops, async (req) => {
        const { id } = parse(idParam, req.params);
        const { reason, returnStock, motivoCliente } = parse(z.object({
            reason: reasonSchema, returnStock: z.boolean().default(true),
            // pedido do cardápio digital: o motivo que o CLIENTE vê vem de uma lista (o texto do caixa fica interno)
            motivoCliente: z.enum(['FALTA', 'FECHANDO', 'DUPLICADO', 'BALCAO']).optional(),
        }), req.body);
        const user = me(req);
        const info = await db.transaction(async (tx) => {
            const { o, acc } = await orderWithAccount(tx, id, true);
            await assertAccountInScope(tx, user, acc);
            assertAccountEditable(acc.status);
            if (o.status === 'CANCELLED')
                throw conflict('Pedido já cancelado.');
            await exigirDonoSeProntoNaCozinha(tx, user, o.goesToKitchen && ['READY', 'DELIVERED'].includes(o.status), req);
            const items = await tx.select().from(orderItems).where(and(eq(orderItems.orderId, id), eq(orderItems.status, 'ACTIVE')));
            const value = items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0);
            const t = await accountTotals(tx, acc.id);
            const counted = o.status === 'AWAITING_CONFIRMATION' ? 0 : value;
            if (t.total - counted < t.paid)
                throw conflict('O valor já pago ficaria maior que o total. Peça ao Dono para estornar um pagamento antes.');
            const lost = LOSS_STATUSES.includes(o.status);
            let stockBack = false;
            if (returnStock && o.status !== 'AWAITING_CONFIRMATION') {
                for (const it of items)
                    stockBack = (await returnStockForItem(tx, it.id, it.quantity, user.id, `Cancelamento do pedido #${o.number}`)) || stockBack;
            }
            await tx.update(orderItems).set({ status: 'CANCELLED' }).where(and(eq(orderItems.orderId, id), eq(orderItems.status, 'ACTIVE')));
            await tx.update(orders).set({ status: 'CANCELLED' }).where(eq(orders.id, id));
            const reg = await currentRegister(tx);
            await tx.insert(cancellations).values({
                target: 'ORDER', accountId: acc.id, orderId: id, motivoCliente: motivoCliente ?? null,
                description: `Pedido #${o.number}: ${items.map((i) => `${i.quantity}× ${i.productName}`).join(', ')}`,
                amountCents: counted, wasInPreparation: lost, reason, userId: user.id, cashRegisterId: reg?.id ?? null,
                statusBefore: ORDER_STATUS_PT[o.status], statusAfter: 'Cancelado', stockReturned: stockBack,
            });
            await audit(tx, {
                userId: user.id, action: 'order.cancel', entityType: 'order', entityId: id,
                message: `${user.name} cancelou o pedido #${o.number} (${brl(value)}; ${ORDER_STATUS_PT[o.status]} → Cancelado) da ${label(acc)}${lost ? ' — PERDA (já em preparo/entregue)' : ''}${stockBack ? ' — estoque devolvido' : ''}. Motivo: ${reason}`,
            });
            if (o.origin === 'QR_CODE' && o.status === 'AWAITING_CONFIRMATION') {
                const [{ n }] = (await tx.execute(sql `SELECT COUNT(*)::int AS n FROM orders WHERE account_id = ${acc.id} AND status <> 'CANCELLED'`)).rows;
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
        notify.ordersChanged();
        notify.accountsChanged(info.acc.id);
        notify.registerChanged();
        notify.stockMaybeChanged();
        return { ok: true };
    });
    // Consulta se o item consumiu estoque (para mostrar "devolver ao estoque")
    app.get('/api/order-items/:id/stock', ops, async (req) => {
        const { id } = parse(idParam, req.params);
        const [it] = await db.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.id, id));
        if (!it)
            throw notFound('Item não encontrado.');
        return { hasStock: await itemHasStock(db, id) };
    });
    app.post('/api/orders/:id/deliver', ops, async (req) => {
        const { id } = parse(idParam, req.params);
        const user = me(req);
        const acc = await db.transaction(async (tx) => {
            const { o, acc } = await orderWithAccount(tx, id, true);
            if (o.status !== 'READY')
                throw conflict('Só pedidos prontos podem ser marcados como entregues.');
            await tx.update(orders).set({ status: 'DELIVERED', deliveredAt: new Date(), deliveredBy: user.id, problemNote: null }).where(eq(orders.id, id));
            await audit(tx, { userId: user.id, action: 'order.deliver', entityType: 'order', entityId: id, message: `${user.name} entregou o pedido #${o.number} da ${label(acc)}.` });
            return acc;
        });
        notify.ordersChanged();
        notify.accountsChanged(acc.id);
        return { ok: true };
    });
    app.post('/api/orders/:id/clear-problem', ops, async (req) => {
        const { id } = parse(idParam, req.params);
        const user = me(req);
        await db.transaction(async (tx) => {
            const { o, acc } = await orderWithAccount(tx, id, true);
            if (!o.problemNote)
                return;
            await tx.update(orders).set({ problemNote: null }).where(eq(orders.id, id));
            await audit(tx, { userId: user.id, action: 'order.problem.clear', entityType: 'order', entityId: id, message: `${user.name} resolveu o problema do pedido #${o.number} (${label(acc)}): "${o.problemNote}".` });
        });
        notify.ordersChanged();
        return { ok: true };
    });
    // Confirmação de pedido vindo do QR Code (baixa o estoque neste momento)
    app.post('/api/orders/:id/confirm', ops, async (req) => {
        const { id } = parse(idParam, req.params);
        const { stockDecisions } = parse(z.object({ stockDecisions: stockDecisionsSchema }), req.body ?? {});
        const user = me(req);
        const r = await db.transaction(async (tx) => {
            const { o, acc } = await orderWithAccount(tx, id, true);
            if (o.status !== 'AWAITING_CONFIRMATION')
                throw conflict('Este pedido não está aguardando confirmação.');
            // quem já pediu é atendido mesmo com a casa pausada para pedidos novos: basta o caixa aberto
            const reg = await requireOpenRegister(tx);
            const now = new Date();
            const status = o.goesToKitchen ? 'CONFIRMED' : 'DELIVERED';
            const { needs, itemIds } = await stockNeedsForOrder(tx, id);
            await applyStockForSale(tx, needs, itemIds, stockDecisions, user.id, `Pedido #${o.number} (QR Code)`);
            await tx.update(orders).set({
                status, confirmedAt: now, confirmedBy: user.id, cashRegisterId: reg.id,
                expectedReadyAt: o.goesToKitchen && o.expectedMinutes ? await estimateReady(tx, o.expectedMinutes) : null,
                deliveredAt: status === 'DELIVERED' ? now : null, deliveredBy: status === 'DELIVERED' ? user.id : null,
            }).where(eq(orders.id, id));
            if (!acc.cashRegisterId)
                await tx.update(accounts).set({ cashRegisterId: reg.id, openedBy: user.id }).where(eq(accounts.id, acc.id));
            await audit(tx, { userId: user.id, action: 'order.confirm', entityType: 'order', entityId: id, message: `${user.name} confirmou o pedido #${o.number} (QR Code) da ${label(acc)}.` });
            await recomputeStatus(tx, acc.id);
            return { o, acc };
        });
        if (r.o.goesToKitchen)
            notify.kitchenNewOrder({ orderNumber: r.o.number, accountNumber: r.acc.number, sequence: r.o.sequence });
        notify.ordersChanged();
        notify.accountsChanged(r.acc.id);
        notify.stockMaybeChanged();
        return { ok: true };
    });
    // Juntar contas: a conta de origem passa para a de destino (sem contar como cancelamento)
    app.post('/api/accounts/:id/merge', ops, async (req) => {
        const { id } = parse(idParam, req.params);
        const { targetId } = parse(z.object({ targetId: z.number().int().positive() }), req.body);
        if (targetId === id)
            throw bad('Escolha outra conta de destino.');
        const user = me(req);
        const r = await db.transaction(async (tx) => {
            const [first, second] = id < targetId ? [id, targetId] : [targetId, id];
            await getAccount(tx, first, true);
            await getAccount(tx, second, true); // trava na mesma ordem
            const src = await getAccount(tx, id);
            const dst = await getAccount(tx, targetId);
            for (const a of [src, dst]) {
                await assertAccountInScope(tx, user, a);
                if (!['OPEN', 'PARTIALLY_PAID', 'PAID'].includes(a.status))
                    throw conflict(`A conta #${a.number} não está aberta.`);
            }
            const t = await accountTotals(tx, id);
            await tx.update(orders).set({ accountId: targetId }).where(eq(orders.accountId, id));
            await tx.update(payments).set({ accountId: targetId }).where(eq(payments.accountId, id));
            await tx.update(discounts).set({ accountId: targetId }).where(eq(discounts.accountId, id));
            await tx.update(cancellations).set({ accountId: targetId }).where(eq(cancellations.accountId, id));
            await tx.execute(sql `UPDATE orders SET sequence = s.rn FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn FROM orders WHERE account_id = ${targetId}) s WHERE orders.id = s.id`);
            await tx.update(accounts).set({ status: 'MERGED', mergedInto: targetId, closedAt: new Date(), closedBy: user.id }).where(eq(accounts.id, id));
            if (!dst.customerName && src.customerName)
                await tx.update(accounts).set({ customerName: src.customerName }).where(eq(accounts.id, targetId));
            await recomputeStatus(tx, targetId);
            await audit(tx, {
                userId: user.id, action: 'account.merge', entityType: 'account', entityId: targetId,
                message: `${user.name} juntou a ${label(src)} (${brl(t.total)}, pago ${brl(t.paid)}) à ${label(dst)}.`,
            });
            return { src, dst };
        });
        notify.accountsChanged(id);
        notify.accountsChanged(targetId);
        notify.ordersChanged();
        return { ok: true, targetId: r.dst.id };
    });
    // Transferir um pedido para outra conta
    app.post('/api/orders/:id/transfer', ops, async (req) => {
        const { id } = parse(idParam, req.params);
        const { targetAccountId } = parse(z.object({ targetAccountId: z.number().int().positive() }), req.body);
        const user = me(req);
        const r = await db.transaction(async (tx) => {
            const [o0] = await tx.select().from(orders).where(eq(orders.id, id));
            if (!o0)
                throw notFound('Pedido não encontrado.');
            if (o0.accountId === targetAccountId)
                throw bad('O pedido já está nesta conta.');
            const [first, second] = o0.accountId < targetAccountId ? [o0.accountId, targetAccountId] : [targetAccountId, o0.accountId];
            await getAccount(tx, first, true);
            await getAccount(tx, second, true);
            const { o, acc: src } = await orderWithAccount(tx, id, true);
            const dst = await getAccount(tx, targetAccountId);
            for (const a of [src, dst]) {
                await assertAccountInScope(tx, user, a);
                if (!['OPEN', 'PARTIALLY_PAID', 'PAID'].includes(a.status))
                    throw conflict(`A conta #${a.number} não está aberta.`);
            }
            if (o.status === 'CANCELLED' || o.status === 'AWAITING_CONFIRMATION')
                throw conflict('Este pedido não pode ser transferido.');
            const value = Number((await tx.execute(sql `SELECT COALESCE(SUM(unit_price_cents*quantity),0)::int AS v FROM order_items WHERE order_id = ${id} AND status='ACTIVE'`)).rows[0].v);
            const t = await accountTotals(tx, src.id);
            if (t.total - value < t.paid)
                throw conflict('A conta de origem já recebeu mais do que ficaria de total. Peça ao Dono para estornar um pagamento antes.');
            const [{ n }] = (await tx.execute(sql `SELECT COUNT(*)::int AS n FROM orders WHERE account_id = ${dst.id}`)).rows;
            await tx.update(orders).set({ accountId: dst.id, sequence: Number(n) + 1 }).where(eq(orders.id, id));
            await recomputeStatus(tx, src.id);
            await recomputeStatus(tx, dst.id);
            await audit(tx, { userId: user.id, action: 'order.transfer', entityType: 'order', entityId: id, message: `${user.name} transferiu o pedido #${o.number} (${brl(value)}) da ${label(src)} para a ${label(dst)}.` });
            return { src, dst };
        });
        notify.accountsChanged(r.src.id);
        notify.accountsChanged(r.dst.id);
        notify.ordersChanged();
        return { ok: true };
    });
    // Estorno de pagamento (somente admin)
    app.post('/api/payments/:id/reverse', ops, async (req) => {
        const { id } = parse(idParam, req.params);
        const { reason } = parse(z.object({ reason: reasonSchema }), req.body);
        const user = me(req);
        const autorizou = user.role === 'ADMIN' ? null : autorizadoPeloDono(req);
        if (user.role !== 'ADMIN' && !autorizou)
            throw new HttpError(403, 'Estorno de pagamento: precisa da autorização do Dono.', 'AUTORIZACAO_DONO');
        const accId = await db.transaction(async (tx) => {
            const [p] = await tx.select().from(payments).where(eq(payments.id, id)).for('update');
            if (!p)
                throw notFound('Pagamento não encontrado.');
            if (p.reversedAt)
                throw conflict('Pagamento já estornado.');
            const acc = await getAccount(tx, p.accountId, true);
            if (acc.status === 'CLOSED')
                throw conflict('Reabra a conta antes de estornar um pagamento.');
            const [m] = await tx.select().from(paymentMethods).where(eq(paymentMethods.id, p.methodId));
            const reg = await currentRegister(tx);
            // dinheiro recebido num dia já fechado e devolvido hoje: sai da gaveta de hoje (sangria automática), senão o caixa fecha com falta que não é dele
            let devolucao = '';
            if (m?.isCash && reg && reg.id !== p.cashRegisterId) {
                await tx.insert(cashMovements).values({ cashRegisterId: reg.id, type: 'SANGRIA', amountCents: p.amountCents, reason: `Devolução do estorno (conta #${acc.number})`, userId: user.id });
                devolucao = ' — dinheiro devolvido da gaveta de hoje (sangria automática)';
            }
            else if (m?.isCash && !reg && p.cashRegisterId) {
                throw conflict('Abra o dia para devolver o dinheiro deste estorno pela gaveta.');
            }
            await tx.update(payments).set({ reversedAt: new Date(), reversedBy: user.id, reversalReason: reason }).where(eq(payments.id, id));
            await audit(tx, { userId: user.id, action: 'payment.reverse', entityType: 'account', entityId: acc.id, message: `${user.name} estornou o pagamento de ${brl(p.amountCents)} da ${label(acc)}${autorizou ? ` com autorização de ${autorizou.name}` : ''}${devolucao}. Motivo: ${reason}` });
            await recomputeStatus(tx, acc.id);
            return acc.id;
        });
        notify.accountsChanged(accId);
        notify.registerChanged();
        return { ok: true };
    });
    // Forma de pagamento lançada errada (Cartão em vez de PIX…): o caixa troca enquanto o dia está aberto, com motivo.
    // O pagamento original é estornado e um novo, do mesmo valor, entra na forma certa — o esperado da gaveta fica certo.
    app.post('/api/payments/:id/forma', ops, async (req) => {
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({ methodId: z.number().int().positive(), reason: reasonSchema }), req.body);
        const user = me(req);
        const accId = await idempotent(req, 'payment.forma', () => db.transaction(async (tx) => {
            const [p] = await tx.select().from(payments).where(eq(payments.id, id)).for('update');
            if (!p)
                throw notFound('Pagamento não encontrado.');
            if (p.reversedAt)
                throw conflict('Este pagamento já foi estornado.');
            const reg = await currentRegister(tx);
            if (!reg || reg.id !== p.cashRegisterId)
                throw conflict('Só dá para trocar a forma de um pagamento do dia que está aberto. Para dias anteriores, fale com o Dono.');
            const [velha] = await tx.select().from(paymentMethods).where(eq(paymentMethods.id, p.methodId));
            const [nova] = await tx.select().from(paymentMethods).where(eq(paymentMethods.id, b.methodId));
            if (!nova || !nova.active)
                throw bad('Forma de pagamento inválida.');
            if (nova.id === p.methodId)
                throw bad('O pagamento já está nessa forma.');
            const acc = await getAccount(tx, p.accountId, true);
            await tx.update(payments).set({ reversedAt: new Date(), reversedBy: user.id, reversalReason: `Troca de forma: ${velha?.name ?? '?'} → ${nova.name}. ${b.reason}` }).where(eq(payments.id, id));
            await tx.insert(payments).values({ accountId: p.accountId, methodId: nova.id, amountCents: p.amountCents, tenderedCents: null, cashRegisterId: reg.id, userId: user.id, taxaBp: nova.taxaBp });
            await audit(tx, { userId: user.id, action: 'payment.forma', entityType: 'account', entityId: acc.id, message: `${user.name} trocou a forma de um pagamento de ${brl(p.amountCents)} da ${label(acc)}: ${velha?.name ?? '?'} → ${nova.name}. Motivo: ${b.reason}` });
            return acc.id;
        }));
        notify.accountsChanged(accId);
        notify.registerChanged();
        return { ok: true };
    });
}
/** Configuração do Dono: comida que já saiu da cozinha só o Dono cancela (é perda). */
async function exigirDonoSeProntoNaCozinha(tx, user, prontoNaCozinha, req) {
    if (!prontoNaCozinha || user.role === 'ADMIN' || autorizadoPeloDono(req))
        return;
    if (await lerConfig('cancelar_pronto_so_dono', tx)) {
        throw new HttpError(403, 'Este item já saiu da cozinha: só o Dono pode cancelar.', 'CANCELAR_SO_DONO');
    }
}
