import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { products, stockMovements } from '../db/schema.js';
import { me, requireRole } from '../auth.js';
import { bad, idParam, notFound, parse, reasonSchema } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { notify } from '../realtime.js';

export async function stockRoutes(app: FastifyInstance) {
  const ops = { preHandler: requireRole('CAIXA') };

  app.get('/api/stock', ops, async () => {
    const rows = await db.execute(sql`
      SELECT p.id, p.name, p.stock_qty AS "stockQty", p.low_stock_at AS "lowStockAt", p.active, p.available,
             c.name AS "categoryName",
             (SELECT MAX(created_at) FROM stock_movements m WHERE m.product_id = p.id AND m.type IN ('ENTRADA','AJUSTE')) AS "lastCountAt",
             (SELECT COUNT(*) FROM stock_movements m WHERE m.product_id = p.id)::int AS "movements"
      FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.track_stock
      ORDER BY p.active DESC, c.sort_order, p.sort_order, p.id`);
    return rows.rows;
  });

  app.get('/api/stock/:id/movements', ops, async (req) => {
    const { id } = parse(idParam, req.params);
    const rows = await db.execute(sql`
      SELECT m.id, m.type, m.quantity, m.before, m.after, m.missing, m.reason, m.created_at AS "createdAt", u.name AS "userName"
      FROM stock_movements m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.product_id = ${id} AND NOT (m.type = 'VENDA' AND m.quantity = 0)
      ORDER BY m.id DESC LIMIT 200`);
    return rows.rows;
  });

  app.get('/api/stock/divergences', ops, async () => {
    const rows = await db.execute(sql`
      SELECT m.id, p.name AS "productName", m.missing, m.before, m.reason, m.created_at AS "createdAt", u.name AS "userName"
      FROM stock_movements m JOIN products p ON p.id = m.product_id LEFT JOIN users u ON u.id = m.user_id
      WHERE m.type = 'DIVERGENCIA' ORDER BY m.id DESC LIMIT 200`);
    return rows.rows;
  });

  /** Entrada (reposição) ou ajuste por contagem. Caixa e admin. Sempre com motivo. */
  app.post('/api/stock/:id', ops, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({
      type: z.enum(['ENTRADA', 'AJUSTE']),
      quantity: z.number().int().min(1).max(100000).optional(), // entrada: +n
      newQty: z.number().int().min(0).max(100000).optional(),   // ajuste: contagem
      reason: reasonSchema,
    }), req.body);
    const user = me(req);
    const res = await db.transaction(async (tx) => {
      const [p] = await tx.select().from(products).where(eq(products.id, id)).for('update');
      if (!p) throw notFound('Produto não encontrado.');
      if (!p.trackStock) throw bad('Este produto não controla estoque.');
      let after: number;
      if (b.type === 'ENTRADA') {
        if (!b.quantity) throw bad('Informe a quantidade que entrou.');
        after = p.stockQty + b.quantity;
      } else {
        if (b.newQty == null) throw bad('Informe a quantidade contada.');
        after = b.newQty;
      }
      await tx.insert(stockMovements).values({ productId: id, type: b.type, quantity: after - p.stockQty, before: p.stockQty, after, reason: b.reason, userId: user.id });
      await tx.update(products).set({ stockQty: after }).where(eq(products.id, id));
      await audit(tx, {
        userId: user.id, action: b.type === 'ENTRADA' ? 'stock.entry' : 'stock.adjust', entityType: 'product', entityId: id,
        message: `${user.name} ${b.type === 'ENTRADA' ? `deu entrada de +${b.quantity}` : 'ajustou por contagem'} no estoque de "${p.name}": ${p.stockQty} → ${after}. Motivo: ${b.reason}`,
      });
      return { before: p.stockQty, after };
    });
    notify.menuChanged();
    return res;
  });

  /** Contagem em lote (contagem inicial ou inventário). */
  app.post('/api/stock/count', ops, async (req) => {
    const b = parse(z.object({
      items: z.array(z.object({ productId: z.number().int().positive(), qty: z.number().int().min(0).max(100000) })).min(1).max(300),
      reason: reasonSchema,
    }), req.body);
    const user = me(req);
    let changed = 0;
    await db.transaction(async (tx) => {
      for (const it of [...b.items].sort((x, y) => x.productId - y.productId)) {
        const [p] = await tx.select().from(products).where(eq(products.id, it.productId)).for('update');
        if (!p || !p.trackStock || p.stockQty === it.qty) continue;
        await tx.insert(stockMovements).values({ productId: p.id, type: 'AJUSTE', quantity: it.qty - p.stockQty, before: p.stockQty, after: it.qty, reason: b.reason, userId: user.id });
        await tx.update(products).set({ stockQty: it.qty }).where(eq(products.id, p.id));
        changed++;
      }
      await audit(tx, { userId: user.id, action: 'stock.count', message: `${user.name} registrou contagem de estoque (${changed} produto(s) ajustado(s)). Motivo: ${b.reason}` });
    });
    notify.menuChanged();
    return { changed };
  });


}
