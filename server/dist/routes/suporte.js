import { z } from 'zod';
import { and, desc, gt, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { suporteLiberacoes } from '../db/schema.js';
import { me, requireRole } from '../auth.js';
import { HttpError, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { lerConfig } from '../services/configuracoes.js';
/*
 * "PERMITIR SUPORTE" — a ONE UP (operadora) só vê nome e telefone de clientes quando o Dono (controlador) libera,
 * por 30 min, 2 h ou 24 h. Fora da janela, toda resposta para o acesso ONE UP sai com telefone/contato mascarados e
 * o nome do cliente só com as iniciais. Exceção: a Recuperação de vendas, quando contratada (acesso delegado).
 */
export async function suporteAtivo() {
    const [l] = await db.select().from(suporteLiberacoes)
        .where(and(gt(suporteLiberacoes.ate, new Date()), isNull(suporteLiberacoes.encerradoEm))).orderBy(desc(suporteLiberacoes.ate)).limit(1);
    return l ?? null;
}
const mascTel = (v) => { const d = v.replace(/\D/g, ''); return d.length >= 8 ? `${d.slice(0, 2)} ****-${d.slice(-4)}` : '••••'; };
const iniciais = (v) => v.trim().split(/\s+/).filter(Boolean).map((p) => `${p[0].toUpperCase()}.`).join(' ').slice(0, 12) || '•';
const CHAVES_TEL = new Set(['phone', 'contact', 'telefone', 'contato', 'customerPhone', 'customerContact']);
const CHAVES_NOME = new Set(['customerName', 'cliente', 'clienteNome', 'nomeCliente']);
export function mascarar(v, nomesTambem, depth = 0) {
    if (depth > 12 || v == null)
        return v;
    if (Array.isArray(v))
        return v.map((x) => mascarar(x, nomesTambem, depth + 1));
    if (typeof v === 'object' && !(v instanceof Date)) {
        const o = {};
        for (const [k, x] of Object.entries(v)) {
            if (typeof x === 'string' && x && CHAVES_TEL.has(k))
                o[k] = mascTel(x);
            else if (typeof x === 'string' && x && (CHAVES_NOME.has(k) || (nomesTambem && (k === 'name' || k === 'nome'))))
                o[k] = iniciais(x);
            else
                o[k] = mascarar(x, nomesTambem, depth + 1);
        }
        return o;
    }
    return v;
}
/** Hook: aplica o mascaramento às respostas para o acesso ONE UP sem liberação do Dono. */
export function mascaramentoSuporte(app) {
    app.addHook('preSerialization', async (req, _reply, payload) => {
        if (!req.user?.oneup || !req.url.startsWith('/api/') || payload == null || typeof payload !== 'object')
            return payload;
        const url = req.url.split('?')[0];
        if (url.startsWith('/api/auth') || url === '/api/meta' || url.startsWith('/api/suporte') || url.startsWith('/api/plataforma'))
            return payload;
        if (url.startsWith('/api/crm') && (await lerConfig('servico_recuperacao').catch(() => false)) === true)
            return payload;
        if (await suporteAtivo())
            return payload;
        return mascarar(payload, url.startsWith('/api/clientes') || url.startsWith('/api/customers'));
    });
}
export async function suporteRoutes(app) {
    const dono = { preHandler: requireRole('ADMIN') };
    app.get('/api/suporte', dono, async () => {
        const l = await suporteAtivo();
        return { ativo: !!l, ate: l?.ate ?? null };
    });
    app.post('/api/suporte/liberar', dono, async (req) => {
        const user = me(req);
        if (user.oneup)
            throw new HttpError(403, 'Quem libera o suporte é o Dono do restaurante.', 'SO_DONO');
        const { minutos } = parse(z.object({ minutos: z.union([z.literal(30), z.literal(120), z.literal(1440)]) }), req.body);
        const ate = new Date(Date.now() + minutos * 60_000);
        await db.transaction(async (tx) => {
            await tx.update(suporteLiberacoes).set({ encerradoEm: new Date(), encerradoPor: user.id }).where(isNull(suporteLiberacoes.encerradoEm));
            await tx.insert(suporteLiberacoes).values({ ate, criadoPor: user.id });
            const rot = minutos === 30 ? '30 minutos' : minutos === 120 ? '2 horas' : '24 horas';
            await audit(tx, { userId: user.id, action: 'suporte.liberar', message: `${user.name} permitiu o suporte da ONE UP ver dados de clientes por ${rot}.` });
        });
        return { ativo: true, ate };
    });
    app.post('/api/suporte/encerrar', dono, async (req) => {
        const user = me(req);
        if (user.oneup)
            throw new HttpError(403, 'Quem encerra o suporte é o Dono do restaurante.', 'SO_DONO');
        const r = await db.update(suporteLiberacoes).set({ encerradoEm: new Date(), encerradoPor: user.id }).where(isNull(suporteLiberacoes.encerradoEm)).returning({ id: suporteLiberacoes.id });
        if (r.length)
            await audit(db, { userId: user.id, action: 'suporte.encerrar', message: `${user.name} encerrou a permissão de suporte da ONE UP.` });
        return { ativo: false };
    });
}
