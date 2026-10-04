import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, runAsSystem } from '../db/index.js';
import { empresas, users } from '../db/schema.js';
import { me, requireOneup } from '../auth.js';
import { bad, idParam, parse } from '../lib/http.js';
import { LICENCA_STATUS } from '../lib/licenca.js';
import { normalizarWhatsapp } from './public.js';
import { alterarRestaurante, carteiraDe, criarRestaurante, historicoDe, listarRestaurantes, prepararCobranca, registrarCobranca, registrarPagamento, validarSlugNovo, } from '../services/plataforma.js';
/*
 * PLATAFORMA ONE UP — Central de comando (só o usuário ONE UP; para os outros a rota "não existe": 404).
 * Lê e grava o cadastro de empresas pelo pool de sistema. Nada daqui aparece para Dono, Caixa ou Cozinha.
 */
const data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'data no formato AAAA-MM-DD');
const texto = (max) => z.string().trim().max(max).nullable().optional().transform((v) => (v === undefined ? undefined : v || null));
const whatsapp = z.string().trim().max(30).nullable().optional().transform((v, ctx) => {
    if (v === undefined)
        return undefined;
    if (!v)
        return null;
    const d = normalizarWhatsapp(v);
    if (!d) {
        ctx.addIssue({ code: 'custom', message: 'WhatsApp do Dono inválido: use DDD + número, por exemplo (11) 91234-5678.' });
        return z.NEVER;
    }
    return d;
});
const centavos = z.number().int().min(0).max(100_000_00);
export async function plataformaRoutes(app) {
    const oneup = { preHandler: requireOneup() };
    const quem = (req) => `${me(req).name} (${me(req).username})`;
    app.get('/api/plataforma/restaurantes', oneup, async () => {
        const lista = await listarRestaurantes();
        return { carteira: carteiraDe(lista), restaurantes: lista };
    });
    app.get('/api/plataforma/slug/:slug', oneup, async (req) => {
        const { slug } = parse(z.object({ slug: z.string().trim().toLowerCase().max(60) }), req.params);
        const motivo = validarSlugNovo(slug);
        if (motivo)
            return { ok: false, motivo };
        const [e] = await runAsSystem(() => db.select({ id: empresas.id }).from(empresas).where(eq(empresas.slug, slug)));
        return e ? { ok: false, motivo: `O endereço "${slug}" já é de outro restaurante.` } : { ok: true };
    });
    app.post('/api/plataforma/restaurantes', oneup, async (req) => {
        const b = parse(z.object({
            nome: z.string().trim().min(2, 'informe o nome do restaurante').max(60),
            slug: z.string().trim().toLowerCase().min(1).max(40),
            donoNome: z.string().trim().min(2, 'informe o nome do Dono').max(60),
            donoLogin: z.string().trim().toLowerCase().max(30).optional().transform((v) => v || undefined),
            donoWhatsapp: whatsapp,
            cardapio: z.enum(['exemplo', 'vazio']).default('exemplo'),
            mensalidadeCents: centavos.default(0),
            plano: texto(40),
            licencaVenceEm: data.nullable().optional(),
        }), req.body);
        const [eu] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, me(req).id));
        if (!eu)
            throw bad('Seu acesso ONE UP não foi encontrado.');
        return criarRestaurante({ ...b, donoWhatsapp: b.donoWhatsapp ?? null, plano: b.plano ?? null, licencaVenceEm: b.licencaVenceEm ?? null }, { nome: me(req).name, login: me(req).username, passwordHash: eu.passwordHash });
    });
    app.patch('/api/plataforma/restaurantes/:id', oneup, async (req) => {
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({
            licencaStatus: z.enum(LICENCA_STATUS).optional(),
            licencaVenceEm: data.nullable().optional(),
            mensalidadeCents: centavos.optional(),
            plano: texto(40), donoNome: texto(60), donoWhatsapp: whatsapp, observacao: texto(500),
            nome: z.string().trim().min(2).max(60).optional(),
        }), req.body);
        return alterarRestaurante(id, b, quem(req));
    });
    app.get('/api/plataforma/restaurantes/:id/historico', oneup, async (req) => {
        const { id } = parse(idParam, req.params);
        return historicoDe(id);
    });
    // Cobrar no WhatsApp: GET prepara a mensagem (editável); POST registra o envio e devolve o link com o texto final
    app.get('/api/plataforma/restaurantes/:id/cobranca', oneup, async (req) => {
        const { id } = parse(idParam, req.params);
        return prepararCobranca(id);
    });
    app.post('/api/plataforma/restaurantes/:id/cobranca', oneup, async (req) => {
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({ mensagem: z.string().trim().min(10, 'mensagem muito curta').max(1500) }), req.body);
        return registrarCobranca(id, b.mensagem, quem(req));
    });
    app.post('/api/plataforma/restaurantes/:id/pagamento', oneup, async (req) => {
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({ novoVencimento: data.optional() }), req.body);
        return registrarPagamento(id, b.novoVencimento, quem(req));
    });
}
