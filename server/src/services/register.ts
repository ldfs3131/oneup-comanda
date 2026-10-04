import { sql } from 'drizzle-orm';
import type { Executor } from '../db/index.js';

const n = (v: unknown) => Number(v ?? 0);

/** Resumo completo de um caixa (usado ao vivo e congelado no fechamento). */
export async function registerSummary(tx: Executor, registerId: number) {
  const q = async (s: ReturnType<typeof sql>) => (await tx.execute(s)).rows as any[];

  const [reg] = await q(sql`SELECT * FROM cash_registers WHERE id = ${registerId}`);
  const [sales] = await q(sql`
    SELECT COALESCE(SUM(oi.unit_price_cents * oi.quantity), 0) AS cents, COUNT(DISTINCT o.id) AS orders, COUNT(DISTINCT o.account_id) AS accounts
    FROM orders o JOIN order_items oi ON oi.order_id = o.id
    WHERE o.cash_register_id = ${registerId} AND oi.status = 'ACTIVE' AND o.status <> 'AWAITING_CONFIRMATION'`);
  const byMethod = await q(sql`
    SELECT pm.code, pm.name, pm.is_cash, COALESCE(SUM(p.amount_cents), 0) AS cents, COUNT(p.id) AS count
    FROM payment_methods pm LEFT JOIN payments p ON p.method_id = pm.id AND p.cash_register_id = ${registerId} AND p.reversed_at IS NULL
    GROUP BY pm.id ORDER BY pm.sort_order`);
  const [fromPrevious] = await q(sql`
    SELECT COALESCE(SUM(p.amount_cents), 0) AS cents, COUNT(*) AS count
    FROM payments p JOIN accounts a ON a.id = p.account_id
    WHERE p.cash_register_id = ${registerId} AND p.reversed_at IS NULL AND (a.cash_register_id IS DISTINCT FROM ${registerId})`);
  const [partials] = await q(sql`
    SELECT COALESCE(SUM(p.amount_cents), 0) AS cents, COUNT(DISTINCT p.account_id) AS accounts
    FROM payments p JOIN accounts a ON a.id = p.account_id
    WHERE p.cash_register_id = ${registerId} AND p.reversed_at IS NULL AND a.status IN ('PARTIALLY_PAID','PENDING')`);
  const [disc] = await q(sql`SELECT COALESCE(SUM(amount_cents),0) AS cents, COUNT(*) AS count FROM discounts WHERE cash_register_id = ${registerId} AND NOT EXISTS (SELECT 1 FROM accounts ca WHERE ca.id = discounts.account_id AND ca.status = 'CANCELLED')`);
  const discByUser = await q(sql`
    SELECT u.name, COALESCE(SUM(d.amount_cents),0) AS cents, COUNT(*) AS count
    FROM discounts d JOIN users u ON u.id = d.user_id WHERE d.cash_register_id = ${registerId} AND NOT EXISTS (SELECT 1 FROM accounts ca WHERE ca.id = d.account_id AND ca.status = 'CANCELLED') GROUP BY u.name ORDER BY cents DESC`);
  const [canc] = await q(sql`
    SELECT COALESCE(SUM(amount_cents),0) AS cents, COUNT(*) AS count,
           COALESCE(SUM(amount_cents) FILTER (WHERE was_in_preparation),0) AS loss_cents
    FROM cancellations WHERE cash_register_id = ${registerId}`);
  const pendingList = await q(sql`
    SELECT a.id, a.number, a.customer_name, a.contact,
      (COALESCE((SELECT SUM(oi.unit_price_cents*oi.quantity) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.account_id=a.id AND oi.status='ACTIVE'),0)
       - COALESCE((SELECT SUM(amount_cents) FROM discounts WHERE account_id=a.id),0)
       - COALESCE((SELECT SUM(amount_cents) FROM payments WHERE account_id=a.id AND reversed_at IS NULL),0)) AS balance
    FROM accounts a
    WHERE a.status = 'PENDING' AND a.pending_at >= ${reg.opened_at} AND (${reg.closed_at}::timestamptz IS NULL OR a.pending_at <= ${reg.closed_at})`);
  // "contas abertas" = só as que ainda devem algo (paga não encerrada e conta vazia não contam)
  const [stillOpen] = await q(sql`
    SELECT COUNT(*) AS count FROM accounts a
    WHERE a.status IN ('OPEN','PARTIALLY_PAID','PAID')
      AND (COALESCE((SELECT SUM(oi.unit_price_cents*oi.quantity) FROM order_items oi JOIN orders o ON o.id=oi.order_id
                     WHERE o.account_id=a.id AND oi.status='ACTIVE' AND o.status <> 'AWAITING_CONFIRMATION'),0)
           - COALESCE((SELECT SUM(amount_cents) FROM discounts WHERE account_id=a.id),0)
           - COALESCE((SELECT SUM(amount_cents) FROM payments WHERE account_id=a.id AND reversed_at IS NULL),0)) > 0`);
  const movements = await q(sql`
    SELECT m.type, m.amount_cents, m.reason, m.created_at, u.name AS user_name
    FROM cash_movements m JOIN users u ON u.id = m.user_id WHERE m.cash_register_id = ${registerId} ORDER BY m.id`);

  const cashIn = byMethod.filter((m) => m.is_cash).reduce((s, m) => s + n(m.cents), 0);
  const suprimentos = movements.filter((m) => m.type === 'SUPRIMENTO').reduce((s, m) => s + n(m.amount_cents), 0);
  const sangrias = movements.filter((m) => m.type === 'SANGRIA').reduce((s, m) => s + n(m.amount_cents), 0);
  const received = byMethod.reduce((s, m) => s + n(m.cents), 0);

  return {
    registerId,
    openedAt: reg.opened_at,
    closedAt: reg.closed_at,
    openingCashCents: n(reg.opening_cash_cents),
    primeiraContagemCents: reg.primeira_contagem_cents == null ? null : n(reg.primeira_contagem_cents),
    salesCents: n(sales.cents),
    ordersCount: n(sales.orders),
    accountsCount: n(sales.accounts),
    receivedCents: received,
    byMethod: byMethod.map((m) => ({ code: m.code, name: m.name, cents: n(m.cents), count: n(m.count) })),
    fromPreviousPendingCents: n(fromPrevious.cents),
    fromPreviousPendingCount: n(fromPrevious.count),
    partialPaymentsCents: n(partials.cents),
    partialAccounts: n(partials.accounts),
    pendingCreated: pendingList.map((p) => ({ id: p.id, number: p.number, customerName: p.customer_name, contact: p.contact, balance: n(p.balance) })),
    pendingCreatedCents: pendingList.reduce((s, p) => s + n(p.balance), 0),
    discountsCents: n(disc.cents),
    discountsCount: n(disc.count),
    discountsByUser: discByUser.map((d) => ({ name: d.name, cents: n(d.cents), count: n(d.count) })),
    cancellationsCents: n(canc.cents),
    cancellationsCount: n(canc.count),
    lossCents: n(canc.loss_cents),
    openAccountsNow: n(stillOpen.count),
    movements: movements.map((m) => ({ type: m.type, amountCents: n(m.amount_cents), reason: m.reason, createdAt: m.created_at, userName: m.user_name })),
    suprimentosCents: suprimentos,
    sangriasCents: sangrias,
    cashReceivedCents: cashIn,
    expectedCashCents: n(reg.opening_cash_cents) + cashIn + suprimentos - sangrias,
  };
}

/**
 * Fechamento às cegas: o que o CAIXA pode ver do próprio dia. Nada de dinheiro esperado, diferença, PIX, cartão
 * nem total (com eles daria para deduzir o esperado). Fica: abertura da gaveta, o que ele mesmo tirou/colocou,
 * contagens e as contas que viraram fiado (quem deve).
 */
export function resumoCego(s: Awaited<ReturnType<typeof registerSummary>>) {
  return {
    ...s,
    salesCents: null, receivedCents: null, byMethod: [], fromPreviousPendingCents: null, partialPaymentsCents: null,
    discountsCents: null, discountsByUser: [], cancellationsCents: null, lossCents: null, pendingCreatedCents: null,
    cashReceivedCents: null, expectedCashCents: null, primeiraContagemCents: null, cego: true as const,
  };
}

/**
 * O que ainda está pendurado antes de encerrar o dia (mostrado ANTES da contagem da gaveta):
 * contas com saldo, contas pagas não encerradas, contas vazias, pedidos na cozinha/prontos sem entrega,
 * pedidos do QR esperando confirmação e problemas da cozinha em aberto. Sem valores do caixa (só o saldo de cada conta,
 * que o caixa já vê no painel).
 */
export async function pendenciasDoFechamento(tx: Executor) {
  const q = async (s: ReturnType<typeof sql>) => (await tx.execute(s)).rows as any[];
  const contas = await q(sql`
    SELECT a.id, a.number, a.customer_name, a.table_label, a.note, a.status,
           t.subtotal, t.paid, (t.subtotal - t.discounts - t.paid) AS balance,
           (SELECT COUNT(*) FROM order_items oi JOIN orders o ON o.id = oi.order_id
             WHERE o.account_id = a.id AND oi.status = 'ACTIVE') AS itens
    FROM accounts a
    CROSS JOIN LATERAL (
      SELECT
        COALESCE((SELECT SUM(oi.unit_price_cents*oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                  WHERE o.account_id = a.id AND oi.status = 'ACTIVE' AND o.status <> 'AWAITING_CONFIRMATION'), 0) AS subtotal,
        COALESCE((SELECT SUM(amount_cents) FROM discounts d WHERE d.account_id = a.id), 0) AS discounts,
        COALESCE((SELECT SUM(amount_cents) FROM payments p WHERE p.account_id = a.id AND p.reversed_at IS NULL), 0) AS paid
    ) t
    WHERE a.status IN ('OPEN','PARTIALLY_PAID','PAID')
    ORDER BY a.number`);
  const conta = (r: any) => ({ id: r.id, number: r.number, customerName: r.customer_name, tableLabel: r.table_label, note: r.note, balance: n(r.balance) });
  const comSaldo = contas.filter((r) => n(r.balance) > 0).map(conta);
  const pagas = contas.filter((r) => n(r.balance) <= 0 && n(r.subtotal) > 0).map(conta);
  // vazia = nenhum item ativo (nem esperando confirmação) e nenhum pagamento
  const vazias = contas.filter((r) => n(r.itens) === 0 && n(r.paid) === 0).map(conta);
  const pedidos = await q(sql`
    SELECT o.id, o.number, o.status, o.problem_note, o.created_at, a.id AS account_id, a.number AS account_number,
           a.customer_name, a.table_label,
           (SELECT string_agg(quantity || '× ' || product_name, ', ' ORDER BY id) FROM order_items WHERE order_id = o.id AND status = 'ACTIVE') AS itens
    FROM orders o JOIN accounts a ON a.id = o.account_id
    WHERE o.status IN ('CONFIRMED','IN_PREPARATION','READY','AWAITING_CONFIRMATION') OR (o.problem_note IS NOT NULL AND o.status <> 'CANCELLED' AND o.status <> 'DELIVERED')
    ORDER BY o.id`);
  const pedido = (r: any) => ({
    id: r.id, number: r.number, status: r.status, problemNote: r.problem_note, createdAt: r.created_at, accountId: r.account_id,
    accountNumber: r.account_number, customerName: r.customer_name, tableLabel: r.table_label, itemsText: r.itens,
  });
  return {
    comSaldo, pagas, vazias,
    naCozinha: pedidos.filter((r) => ['CONFIRMED', 'IN_PREPARATION', 'READY'].includes(r.status)).map(pedido),
    aguardando: pedidos.filter((r) => r.status === 'AWAITING_CONFIRMATION').map(pedido),
    problemas: pedidos.filter((r) => r.problem_note).map(pedido),
  };
}
