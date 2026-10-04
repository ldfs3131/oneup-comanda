import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { products, stockMovements } from '../db/schema.js';
import { me, requireRole } from '../auth.js';
import { bad, brl, idParam, notFound, parse, reasonSchema } from '../lib/http.js';
import { lerConfig } from '../services/configuracoes.js';
import { audit } from '../lib/audit.js';
import { notify } from '../realtime.js';

export async function stockRoutes(app: FastifyInstance) {
  const ops = { preHandler: requireRole('CAIXA') };

  const dono = { preHandler: requireRole('ADMIN') };

  // Estoque atual: Dono vê quantidades e valores; Caixa vê só o aviso "acabou / acabando" (sem quantidade nem valor)
  app.get('/api/stock', ops, async (req) => {
    const rows = (await db.execute(sql`
      SELECT p.id, p.name, p.stock_qty AS "stockQty", p.low_stock_at AS "lowStockAt", p.active, p.available, p.cost_cents AS "costCents",
             c.name AS "categoryName",
             (SELECT MAX(created_at) FROM stock_movements m WHERE m.product_id = p.id AND m.type IN ('ENTRADA','AJUSTE')) AS "lastCountAt",
             (SELECT COUNT(*) FROM stock_movements m WHERE m.product_id = p.id)::int AS "movements"
      FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.track_stock
      ORDER BY p.active DESC, c.sort_order, p.sort_order, p.id`)).rows as any[];
    const comSituacao = rows.map((r) => ({ ...r, situacao: r.stockQty <= 0 ? 'acabou' : r.stockQty <= r.lowStockAt ? 'acabando' : 'ok' }));
    if (me(req).role === 'ADMIN') return comSituacao;
    return comSituacao.filter((r) => r.active && r.situacao !== 'ok').map((r) => ({ id: r.id, name: r.name, categoryName: r.categoryName, situacao: r.situacao }));
  });

  // Últimas movimentações de todos os produtos (histórico imutável; só acrescenta)
  app.get('/api/stock/historico', dono, async () => {
    const rows = await db.execute(sql`
      SELECT m.id, p.name AS "productName", m.type, m.quantity, m.before, m.after, m.reason, m.unit_cost_cents AS "unitCostCents",
             m.fornecedor, m.created_at AS "createdAt", u.name AS "userName"
      FROM stock_movements m JOIN products p ON p.id = m.product_id LEFT JOIN users u ON u.id = m.user_id
      WHERE NOT (m.type = 'VENDA' AND m.quantity = 0)
      ORDER BY m.id DESC LIMIT 150`);
    return rows.rows;
  });

  // Sugestão do que comprar: conta aberta, nunca opinião. Média diária dos últimos 30 dias × dias de cobertura − estoque.
  app.get('/api/stock/sugestao', dono, async () => {
    const dias = (await lerConfig<number>('estoque_dias_cobertura')) ?? 7;
    const [{ primeira }] = (await db.execute(sql`SELECT MIN(created_at) AS primeira FROM orders WHERE status <> 'CANCELLED'`)).rows as { primeira: Date | null }[];
    const diasDeDados = primeira ? Math.floor((Date.now() - new Date(primeira).getTime()) / 86400_000) + 1 : 0;
    if (diasDeDados < 14) return { suficiente: false, diasDeDados, diasMinimos: 14, diasCobertura: dias, itens: [] };
    const janela = Math.min(30, diasDeDados);
    const rows = (await db.execute(sql`
      SELECT p.id, p.name, p.stock_qty AS "stockQty",
        COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                  WHERE oi.product_id = p.id AND oi.status = 'ACTIVE' AND o.status NOT IN ('CANCELLED','AWAITING_CONFIRMATION')
                    AND o.created_at >= now() - make_interval(days => ${janela})), 0)::int AS vendidos
      FROM products p WHERE p.track_stock AND p.active ORDER BY p.name`)).rows as { id: number; name: string; stockQty: number; vendidos: number }[];
    const itens = rows.map((r) => {
      const media = r.vendidos / janela;
      const precisa = Math.ceil(media * dias);
      const comprar = Math.max(0, precisa - Math.max(0, r.stockQty));
      const fmt = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
      return {
        id: r.id, name: r.name, estoque: r.stockQty, vendidos: r.vendidos, mediaDia: Math.round(media * 10) / 10, precisa, comprar,
        conta: r.vendidos === 0 ? `não vendeu nos últimos ${janela} dias` : `vende ${fmt(media)}/dia × ${dias} dias = ${precisa}; tem ${Math.max(0, r.stockQty)}; ${comprar ? `comprar ${comprar}` : 'não precisa comprar'}`,
      };
    }).sort((a, b) => b.comprar - a.comprar || a.name.localeCompare(b.name, 'pt-BR'));
    return { suficiente: true, diasDeDados, janela, diasCobertura: dias, itens };
  });

  // Mínimo por produto (quando passa a "acabando")
  app.post('/api/stock/:id/minimo', dono, async (req) => {
    const { id } = parse(idParam, req.params);
    const { lowStockAt } = parse(z.object({ lowStockAt: z.number().int().min(0).max(100000) }), req.body);
    const user = me(req);
    await db.transaction(async (tx) => {
      const [p] = await tx.select().from(products).where(eq(products.id, id)).for('update');
      if (!p) throw notFound('Produto não encontrado.');
      await tx.update(products).set({ lowStockAt }).where(eq(products.id, id));
      await audit(tx, { userId: user.id, action: 'stock.minimo', entityType: 'product', entityId: id, message: `${user.name} mudou o estoque mínimo de "${p.name}": ${p.lowStockAt} → ${lowStockAt}.` });
    });
    notify.menuChanged();
    return { ok: true };
  });

  app.get('/api/stock/:id/movements', dono, async (req) => {
    const { id } = parse(idParam, req.params);
    const [p] = await db.select({ id: products.id }).from(products).where(eq(products.id, id));
    if (!p) throw notFound('Produto não encontrado.');
    const rows = await db.execute(sql`
      SELECT m.id, m.type, m.quantity, m.before, m.after, m.missing, m.reason, m.created_at AS "createdAt", u.name AS "userName"
      FROM stock_movements m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.product_id = ${id} AND NOT (m.type = 'VENDA' AND m.quantity = 0)
      ORDER BY m.id DESC LIMIT 200`);
    return rows.rows;
  });

  app.get('/api/stock/divergences', dono, async () => {
    const rows = await db.execute(sql`
      SELECT m.id, p.name AS "productName", m.missing, m.before, m.reason, m.created_at AS "createdAt", u.name AS "userName"
      FROM stock_movements m JOIN products p ON p.id = m.product_id LEFT JOIN users u ON u.id = m.user_id
      WHERE m.type = 'DIVERGENCIA' ORDER BY m.id DESC LIMIT 200`);
    return rows.rows;
  });

  /** Entrada de compra (custo e fornecedor opcionais) ou ajuste com motivo obrigatório. Só Dono/Administrador. */
  const MOTIVOS = { contagem: 'Contagem', quebra: 'Quebra', consumo_interno: 'Consumo interno', outro: 'Outro' } as const;
  app.post('/api/stock/:id', dono, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({
      type: z.enum(['ENTRADA', 'AJUSTE']),
      quantity: z.number().int().min(1).max(100000).optional(), // entrada: +n
      newQty: z.number().int().min(0).max(100000).optional(),   // ajuste: contagem
      unitCostCents: z.number().int().min(0).max(100_000_00).nullable().optional(),
      fornecedor: z.string().trim().max(80).nullable().optional().transform((v) => v || null),
      motivo: z.enum(['contagem', 'quebra', 'consumo_interno', 'outro']).optional(),
      reason: z.string().trim().max(200).optional().transform((v) => v || null),
    }), req.body);
    const user = me(req);
    let reason: string;
    if (b.type === 'ENTRADA') reason = b.reason ?? `Compra${b.fornecedor ? ` — ${b.fornecedor}` : ''}`;
    else {
      const motivo = b.motivo ?? (b.reason ? 'outro' : null);
      if (!motivo) throw bad('Escolha o motivo do ajuste: contagem, quebra, consumo interno ou outro.');
      if (motivo === 'outro' && (!b.reason || b.reason.length < 3)) throw bad('Explique o motivo do ajuste (mínimo 3 letras).');
      reason = motivo === 'outro' ? b.reason! : b.reason ? `${MOTIVOS[motivo]}: ${b.reason}` : MOTIVOS[motivo];
    }
    const res = await db.transaction(async (tx) => {
      const [p] = await tx.select().from(products).where(eq(products.id, id)).for('update');
      if (!p) throw notFound('Produto não encontrado.');
      if (!p.trackStock) throw bad('Este produto não controla estoque.');
      let after: number;
      if (b.type === 'ENTRADA') {
        if (!b.quantity) throw bad('Informe a quantidade que entrou.');
        after = Math.max(0, p.stockQty) + b.quantity;
      } else {
        if (b.newQty == null) throw bad('Informe a quantidade contada.');
        after = b.newQty;
      }
      await tx.insert(stockMovements).values({
        productId: id, type: b.type, quantity: after - p.stockQty, before: p.stockQty, after, reason, userId: user.id,
        unitCostCents: b.type === 'ENTRADA' ? b.unitCostCents ?? null : null, fornecedor: b.type === 'ENTRADA' ? b.fornecedor : null,
      });
      await tx.update(products).set({ stockQty: after }).where(eq(products.id, id));
      await audit(tx, {
        userId: user.id, action: b.type === 'ENTRADA' ? 'stock.entry' : 'stock.adjust', entityType: 'product', entityId: id,
        message: `${user.name} ${b.type === 'ENTRADA' ? `deu entrada de +${b.quantity}${b.unitCostCents != null ? ` a ${brl(b.unitCostCents)} cada` : ''}` : 'ajustou'} o estoque de "${p.name}": ${p.stockQty} → ${after}. ${b.type === 'ENTRADA' ? '' : 'Motivo: '}${reason}`,
      });
      // Custo da compra diferente do cadastrado: só PERGUNTA (o sistema nunca muda o custo sozinho)
      const custoDiferente = b.type === 'ENTRADA' && b.unitCostCents != null && b.unitCostCents !== p.costCents
        ? { atual: p.costCents, novo: b.unitCostCents } : null;
      return { before: p.stockQty, after, custoDiferente };
    });
    notify.menuChanged();
    return res;
  });

  /** Contagem em lote (contagem inicial ou inventário). */
  app.post('/api/stock/count', dono, async (req) => {
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
