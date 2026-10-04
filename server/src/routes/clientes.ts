/**
 * Tela "Clientes" do Dono (LGPD): buscar, corrigir, parar ofertas, juntar duplicados, apagar dados e exportar.
 * Só o Dono (ADMIN). Cada ação vai para a auditoria SEM dados pessoais ("cliente #12: ofertas revogadas").
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { me, requireRole } from '../auth.js';
import { audit } from '../lib/audit.js';
import { idParam, parse } from '../lib/http.js';
import { formatarTelefone } from '../lib/telefone.js';
import { anonimizarCliente, corrigirCliente, dadosDoCliente, dadosEmCsv, juntarClientes, revogarOfertas } from '../services/clientes.js';

const saldoConta = sql`(
  COALESCE((SELECT SUM(oi.unit_price_cents * oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.account_id = a.id AND oi.status = 'ACTIVE' AND o.status <> 'AWAITING_CONFIRMATION'), 0)
  - COALESCE((SELECT SUM(amount_cents) FROM discounts WHERE account_id = a.id), 0)
  - COALESCE((SELECT SUM(amount_cents) FROM payments WHERE account_id = a.id AND reversed_at IS NULL), 0))`;

export async function clientesRoutes(app: FastifyInstance) {
  const dono = { preHandler: requireRole('ADMIN') };

  // Lista: sem busca, os 100 com pedido mais recente; com busca, 3+ letras (nome, contato ou dígitos do telefone)
  app.get('/api/clientes', dono, async (req) => {
    const { q } = parse(z.object({ q: z.string().trim().max(60).optional().refine((v) => !v || v.length >= 3, 'digite pelo menos 3 letras') }), req.query);
    let filtro = sql``;
    if (q) {
      const like = '%' + q + '%';
      const dig = q.replace(/\D/g, '');
      filtro = sql`AND (unaccent_lower(c.name) LIKE unaccent_lower(${like}) OR unaccent_lower(coalesce(c.contact, '')) LIKE unaccent_lower(${like})
        ${dig.length >= 3 ? sql`OR regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g') LIKE ${'%' + dig + '%'}` : sql``}
        ${/^\d+$/.test(q) ? sql`OR c.id = ${Number(q)}` : sql``})`;
    }
    const r = await db.execute(sql`
      SELECT c.id, c.name AS nome, c.phone AS telefone, c.contact AS contato,
        c.aceita_ofertas AS "aceitaOfertas", c.aceita_ofertas_em AS "aceiteEm", c.aceita_ofertas_texto AS "textoDoAceite",
        c.ofertas_revogadas_em AS "ofertasRevogadasEm", c.created_at AS "cadastradoEm",
        COALESCE(x.contas, 0)::int AS contas, x.ultimo AS "ultimoPedido", COALESCE(x.receber, 0)::int AS "aReceberCents",
        COALESCE(x.abertas, 0)::int AS "contasAbertas"
      FROM customers c
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS contas, MAX(a.opened_at) AS ultimo,
          SUM(CASE WHEN a.status = 'PENDING' THEN ${saldoConta} ELSE 0 END) AS receber,
          COUNT(*) FILTER (WHERE a.status IN ('OPEN', 'PARTIALLY_PAID', 'PAID', 'PENDING')) AS abertas
        FROM accounts a WHERE a.customer_id = c.id
      ) x ON TRUE
      WHERE c.juntado_em IS NULL AND c.anonimizado_em IS NULL ${filtro}
      ORDER BY x.ultimo DESC NULLS LAST, c.id DESC
      LIMIT 100`);
    return (r.rows as { telefone: string | null }[]).map((c) => ({ ...c, telefone: formatarTelefone(c.telefone) }));
  });

  // Corrigir nome/telefone/contato
  app.patch('/api/clientes/:id', dono, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(z.object({
      nome: z.string().trim().min(2, 'informe o nome').max(80).optional(),
      telefone: z.string().trim().max(30).nullable().optional(),
      contato: z.string().trim().max(120).nullable().optional(),
    }), req.body);
    return db.transaction((tx) => corrigirCliente(tx, id, b, me(req).id));
  });

  // Parar ofertas (o cliente pediu para não receber mais)
  app.post('/api/clientes/:id/parar-ofertas', dono, async (req) => {
    const { id } = parse(idParam, req.params);
    await db.transaction((tx) => revogarOfertas(tx, id, me(req).id));
    return { ok: true };
  });

  // Juntar duplicados: :id fica; `outroId` some das listas e as contas dele passam para :id
  app.post('/api/clientes/:id/juntar', dono, async (req) => {
    const { id } = parse(idParam, req.params);
    const { outroId } = parse(z.object({ outroId: z.number().int().positive() }), req.body);
    return db.transaction((tx) => juntarClientes(tx, id, outroId, me(req).id));
  });

  // Apagar dados (anonimizar): as vendas continuam
  app.post('/api/clientes/:id/apagar', dono, async (req) => {
    const { id } = parse(idParam, req.params);
    return db.transaction((tx) => anonimizarCliente(tx, id, me(req).id));
  });

  // Exportar os dados de um cliente (pedido do titular): JSON ou CSV
  app.get('/api/clientes/:id/exportar', dono, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const { formato } = parse(z.object({ formato: z.enum(['json', 'csv']).default('json') }), req.query);
    const dados = await db.transaction(async (tx) => {
      const d = await dadosDoCliente(tx, id);
      await audit(tx, { userId: me(req).id, action: 'cliente.exportado', entityType: 'customer', entityId: id, message: `cliente #${id}: dados exportados (${formato.toUpperCase()}) a pedido do titular.` });
      return d;
    });
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Disposition', `attachment; filename="cliente-${id}.${formato}"`);
    if (formato === 'csv') return reply.type('text/csv; charset=utf-8').send(dadosEmCsv(dados));
    return dados;
  });
}
