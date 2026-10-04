import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pendenciasResolvidas } from '../db/schema.js';
import { me, requireRole } from '../auth.js';
import { parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
/*
 * PENDÊNCIAS (Dono e Administrador): três listas que se resolvem e somem. Nada aqui bloqueia a operação.
 *  1) Avulsos repetidos ("＋ Outro" vendido 2+ vezes com o mesmo nome) → virar produto ou ignorar
 *  2) Vendas com estoque divergente (vendeu sem estoque registrado) → conferido
 *  3) Produtos sem custo (o lucro pode estar maior que o real) → some quando o custo é preenchido
 */
const chaveAvulso = (nome) => nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
export async function listarPendencias() {
    const resolvidas = (await db.select({ tipo: pendenciasResolvidas.tipo, chave: pendenciasResolvidas.chave }).from(pendenciasResolvidas))
        .reduce((m, r) => m.add(`${r.tipo}:${r.chave}`), new Set());
    const avulsosBrutos = (await db.execute(sql `
    SELECT oi.product_name AS nome, oi.unit_price_cents AS preco, oi.quantity AS qtd, oi.goes_to_kitchen AS cozinha, o.created_at AS em
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE oi.is_custom AND oi.status = 'ACTIVE' AND o.status <> 'CANCELLED' AND o.created_at >= now() - interval '90 days'
    ORDER BY o.created_at DESC`)).rows;
    const grupos = new Map();
    for (const a of avulsosBrutos) {
        const chave = chaveAvulso(a.nome);
        const g = grupos.get(chave) ?? { chave, nome: a.nome, vezes: 0, unidades: 0, precos: [], cozinha: a.cozinha, ultima: a.em };
        g.vezes++;
        g.unidades += a.qtd;
        g.precos.push(a.preco);
        grupos.set(chave, g);
    }
    const avulsos = [...grupos.values()].filter((g) => g.vezes >= 2 && !resolvidas.has(`avulso:${g.chave}`)).map((g) => {
        const ord = [...g.precos].sort((x, y) => x - y);
        return { chave: g.chave, nome: g.nome, vezes: g.vezes, unidades: g.unidades, precoSugeridoCents: ord[Math.floor(ord.length / 2)], cozinha: g.cozinha, ultima: g.ultima };
    }).sort((x, y) => y.vezes - x.vezes);
    const divergencias = (await db.execute(sql `
    SELECT m.id, p.name AS "productName", m.missing, m.reason, m.created_at AS "createdAt", u.name AS "userName"
    FROM stock_movements m JOIN products p ON p.id = m.product_id LEFT JOIN users u ON u.id = m.user_id
    WHERE m.type = 'DIVERGENCIA' ORDER BY m.id DESC LIMIT 300`)).rows
        .filter((d) => !resolvidas.has(`divergencia:${d.id}`));
    const semCusto = (await db.execute(sql `
    SELECT p.id, p.name, p.price_cents AS "priceCents", c.name AS "categoryName", COALESCE(v.qtd, 0)::int AS "vendidos30"
    FROM products p JOIN categories c ON c.id = p.category_id
    LEFT JOIN (
      -- vendas de 30 dias somadas por produto numa passada só (antes: uma subconsulta por produto); mesmo desenho da
      -- sugestão de compra: pedidos da janela pelo índice de data, itens pelo índice do pedido (OFFSET 0 mantém o plano)
      SELECT oi.product_id, SUM(oi.quantity) AS qtd
      FROM orders o
      CROSS JOIN LATERAL (SELECT product_id, quantity FROM order_items
                          WHERE order_id = o.id AND status = 'ACTIVE' AND product_id IS NOT NULL OFFSET 0) oi
      WHERE o.created_at >= now() - interval '30 days' AND o.status <> 'CANCELLED'
      GROUP BY oi.product_id
    ) v ON v.product_id = p.id
    WHERE p.active AND p.cost_cents IS NULL
    ORDER BY "vendidos30" DESC, p.name`)).rows;
    return { avulsos, divergencias, semCusto, total: avulsos.length + divergencias.length + semCusto.length };
}
export async function pendenciasRoutes(app) {
    const dono = { preHandler: requireRole('ADMIN') };
    app.get('/api/pendencias', dono, async () => listarPendencias());
    app.get('/api/pendencias/contagem', dono, async () => ({ total: (await listarPendencias()).total }));
    app.post('/api/pendencias/resolver', dono, async (req) => {
        const b = parse(z.object({
            tipo: z.enum(['avulso', 'divergencia']),
            chave: z.string().trim().min(1).max(120),
            acao: z.enum(['virou_produto', 'ignorado', 'conferido']),
        }), req.body);
        const user = me(req);
        const chave = b.tipo === 'avulso' ? chaveAvulso(b.chave) : b.chave;
        await db.transaction(async (tx) => {
            await tx.insert(pendenciasResolvidas).values({ tipo: b.tipo, chave, acao: b.acao, userId: user.id }).onConflictDoNothing();
            const oQue = b.tipo === 'avulso' ? `o avulso "${b.chave}"` : `a divergência de estoque #${chave}`;
            const como = { virou_produto: 'virou produto', ignorado: 'ignorado', conferido: 'conferido' }[b.acao];
            await audit(tx, { userId: user.id, action: 'pendencia.resolver', entityType: 'pendencia', message: `${user.name} resolveu ${oQue} (${como}).` });
        });
        return { ok: true };
    });
}
