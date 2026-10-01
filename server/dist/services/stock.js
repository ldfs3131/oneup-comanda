import { marcarEstoqueMudou } from '../lib/cache.js';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { products, stockMovements } from '../db/schema.js';
import { HttpError, bad } from '../lib/http.js';
/**
 * Baixa o estoque de uma venda confirmada. Nunca deixa negativo.
 * - estoque suficiente: baixa normal (VENDA);
 * - insuficiente sem decisão: VENDE assim mesmo e registra DIVERGÊNCIA automática (regra do produto: no caixa a falta
 *   de estoque nunca trava a venda; o Dono vê "ajustar estoque" no painel e corrige a contagem);
 * - CORRECT: registra AJUSTE para a contagem informada e vende;
 * - RELEASE: vende o que houver e registra DIVERGÊNCIA com o que faltou.
 */
export async function applyStockForSale(tx, needs, itemIds, decisions, userId, label) {
    if (!needs.length)
        return;
    const ids = [...new Set(needs.map((n) => n.productId))].sort((a, b) => a - b);
    // trava as linhas na mesma ordem sempre (evita deadlock entre dois caixas)
    const rows = await tx.select().from(products).where(inArray(products.id, ids)).orderBy(asc(products.id)).for('update');
    const byId = new Map(rows.map((r) => [r.id, { ...r }]));
    const totals = new Map();
    for (const n of needs)
        totals.set(n.productId, (totals.get(n.productId) ?? 0) + n.qty);
    const shortages = [];
    for (const [pid, qty] of totals) {
        const p = byId.get(pid);
        if (!p.trackStock)
            continue;
        if (p.stockQty >= qty)
            continue;
        const d = decisions?.find((x) => x.productId === pid);
        if (!d)
            continue; // sem decisão do operador: vende e registra a divergência (abaixo)
        if (d.action === 'CORRECT') {
            if (!Number.isInteger(d.newQty) || d.newQty < 0 || d.newQty > 100000)
                throw bad('Contagem de estoque inválida.');
            if (d.newQty < qty) {
                shortages.push({ productId: pid, name: p.name, stock: d.newQty, requested: qty });
                continue;
            }
            await tx.insert(stockMovements).values({
                productId: pid, type: 'AJUSTE', quantity: d.newQty - p.stockQty, before: p.stockQty, after: d.newQty,
                reason: `Contagem corrigida na venda (${label})`, userId,
            });
            await tx.update(products).set({ stockQty: d.newQty }).where(eq(products.id, pid));
            marcarEstoqueMudou();
            p.stockQty = d.newQty;
        }
        else {
            if (!d.reason || d.reason.trim().length < 3)
                throw bad('Informe o motivo para liberar a venda sem estoque.');
        }
    }
    if (shortages.length) {
        throw new HttpError(409, 'Estoque insuficiente para: ' + shortages.map((s) => `${s.name} (registrado ${s.stock}, pedido ${s.requested})`).join('; '), 'STOCK_INSUFFICIENT', shortages);
    }
    for (const n of needs) {
        const p = byId.get(n.productId);
        if (!p.trackStock)
            continue;
        const take = Math.min(p.stockQty, n.qty);
        const missing = n.qty - take;
        const before = p.stockQty;
        p.stockQty -= take;
        const d = decisions?.find((x) => x.productId === n.productId);
        await tx.insert(stockMovements).values({
            productId: n.productId,
            type: missing > 0 ? 'DIVERGENCIA' : 'VENDA',
            quantity: -take, before, after: p.stockQty, missing,
            reason: missing > 0
                ? (d && d.action === 'RELEASE'
                    ? `Venda liberada sem estoque registrado (${label}). Motivo: ${d.reason.trim()}`
                    : `Vendido sem estoque registrado no sistema (${label}). Ajustar a contagem.`)
                : label,
            orderItemId: itemIds[n.itemIndex] ?? null, userId,
        });
        await tx.update(products).set({ stockQty: p.stockQty }).where(eq(products.id, n.productId));
        marcarEstoqueMudou();
    }
}
/** Produtos de estoque vinculados a um item vendido (o próprio produto e/ou produtos de opções). */
async function stockProductsOfItem(tx, orderItemId) {
    const r = await tx.execute(sql `SELECT DISTINCT product_id FROM stock_movements WHERE order_item_id = ${orderItemId} AND type IN ('VENDA','DIVERGENCIA')`);
    return r.rows.map((x) => Number(x.product_id)).sort((a, b) => a - b);
}
/** Devolve ao estoque as unidades de um item cancelado (1 unidade de cada produto vinculado por unidade cancelada). */
export async function returnStockForItem(tx, orderItemId, qty, userId, label) {
    let returned = false;
    for (const pid of await stockProductsOfItem(tx, orderItemId)) {
        const [p] = await tx.select().from(products).where(eq(products.id, pid)).for('update');
        if (!p || !p.trackStock || qty <= 0)
            continue;
        await tx.insert(stockMovements).values({
            productId: p.id, type: 'CANCELAMENTO', quantity: qty, before: p.stockQty, after: p.stockQty + qty,
            reason: label, orderItemId, userId,
        });
        await tx.update(products).set({ stockQty: p.stockQty + qty }).where(eq(products.id, p.id));
        marcarEstoqueMudou();
        returned = true;
    }
    return returned;
}
/** Após cancelamento parcial, o restante (nova linha) herda o vínculo de estoque, sem nova baixa. */
export async function linkStockToItem(tx, fromItemId, toItemId, userId) {
    for (const pid of await stockProductsOfItem(tx, fromItemId)) {
        const [p] = await tx.select().from(products).where(eq(products.id, pid));
        if (!p)
            continue;
        await tx.insert(stockMovements).values({
            productId: pid, type: 'VENDA', quantity: 0, before: p.stockQty, after: p.stockQty,
            reason: 'Vínculo do restante após cancelamento parcial', orderItemId: toItemId, userId,
        });
    }
}
/** O item consumiu estoque? (para mostrar "devolver ao estoque" no cancelamento) */
export async function itemHasStock(tx, orderItemId) {
    const r = await tx.execute(sql `SELECT 1 FROM stock_movements WHERE order_item_id = ${orderItemId} AND type IN ('VENDA','DIVERGENCIA') LIMIT 1`);
    return r.rows.length > 0;
}
