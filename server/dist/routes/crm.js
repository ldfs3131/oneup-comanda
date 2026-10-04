import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { COOKIE, me, userFromToken } from '../auth.js';
import { HttpError, bad, idParam, parse, reasonSchema } from '../lib/http.js';
import { RESULTADOS, anexarComprovante, anotar, apagarComprovante, comprovante, encerrarPerdido, ficha, filaHoje, funil, insights, lerCrmConfig, listarFichas, mimeComprovante, naoCobrar, registrarContato, registrarResultado, relatorio, relogio, retomar, salvarCrmConfig, servicoLigado, sincronizar, CONFIG_PADRAO, } from '../services/crm.js';
/**
 * Recuperação de vendas (CRM de cobrança do fiado) — SÓ a ONE UP.
 * Dono, Caixa e Cozinha recebem 404 (para eles a rota "não existe" — inclusive Caixa e Cozinha, que em outras rotas
 * de gestão recebem 403). Com o serviço desligado no restaurante, a ONE UP recebe 403
 * (exceto /estado, que diz se está ligado).
 */
/** Só o usuário ONE UP. Sem sessão: 401 (pede login). Qualquer outro perfil: 404. */
async function requireOneup(req) {
    const user = await userFromToken(req.cookies[COOKIE]);
    if (!user)
        throw new HttpError(401, 'Sessão expirada. Faça login novamente.');
    if (!user.oneup || user.role !== 'ADMIN')
        throw new HttpError(404, 'Recurso não disponível.');
    req.user = user;
}
export async function crmRoutes(app) {
    const ligado = async (_req, _reply) => {
        if (!(await servicoLigado())) {
            throw new HttpError(403, 'O serviço de recuperação de vendas está desligado neste restaurante. Ligue em Configurações › ONE UP (só com o contrato assinado).', 'CRM_DESLIGADO');
        }
    };
    const so = { preHandler: [requireOneup] };
    const on = { preHandler: [requireOneup, ligado] };
    const dataSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'data inválida');
    app.get('/api/oneup/crm/estado', so, async () => {
        const r = relogio();
        return { ligado: await servicoLigado(), hoje: r.dia, hora: `${String(r.hora).padStart(2, '0')}:${String(r.minuto).padStart(2, '0')}` };
    });
    app.post('/api/oneup/crm/sincronizar', on, async () => ({ resumo: await sincronizar({ forcar: true }) }));
    // as telas sincronizam ao abrir (com folga de 15 s entre uma e outra)
    app.get('/api/oneup/crm/hoje', on, async () => { await sincronizar(); return filaHoje(); });
    app.get('/api/oneup/crm/funil', on, async () => { await sincronizar(); return funil(); });
    app.get('/api/oneup/crm/fichas', on, async (req) => {
        const q = parse(z.object({ status: z.string().max(200).optional(), busca: z.string().trim().max(60).optional() }), req.query);
        await sincronizar();
        return listarFichas(q);
    });
    app.get('/api/oneup/crm/fichas/:id', on, async (req) => ficha(parse(idParam, req.params).id));
    app.post('/api/oneup/crm/fichas/:id/contato', on, async (req) => {
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({ canal: z.enum(['WHATSAPP', 'LIGACAO', 'PESSOAL']), nota: z.string().trim().max(500).nullable().optional() }), req.body);
        return registrarContato(id, b, me(req));
    });
    app.post('/api/oneup/crm/fichas/:id/resultado', on, async (req) => {
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({ resultado: z.enum(RESULTADOS), data: dataSchema.nullable().optional(), nota: z.string().trim().max(500).nullable().optional() }), req.body);
        return registrarResultado(id, b, me(req));
    });
    app.post('/api/oneup/crm/fichas/:id/nao-cobrar', on, async (req) => {
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({ motivo: reasonSchema }), req.body);
        return naoCobrar(id, b.motivo, me(req));
    });
    app.post('/api/oneup/crm/fichas/:id/retomar', on, async (req) => {
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({ nota: z.string().trim().max(300).nullable().optional() }), req.body ?? {});
        return retomar(id, b.nota || null, me(req));
    });
    app.post('/api/oneup/crm/fichas/:id/encerrar', on, async (req) => {
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({ motivo: reasonSchema }), req.body);
        return encerrarPerdido(id, b.motivo, me(req));
    });
    app.post('/api/oneup/crm/fichas/:id/nota', on, async (req) => {
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({ nota: z.string().trim().min(2, 'escreva a nota').max(500) }), req.body);
        return anotar(id, b.nota, me(req));
    });
    // Comprovante: foto/PDF até 5 MB. Dado bancário — só a ONE UP baixa e pode apagar.
    app.post('/api/oneup/crm/fichas/:id/comprovante', on, async (req) => {
        const { id } = parse(idParam, req.params);
        const max = 5 * 1024 * 1024;
        const file = await req.file({ limits: { fileSize: max } });
        if (!file)
            throw bad('Envie a foto ou o PDF do comprovante.');
        const buf = await file.toBuffer().catch(() => { throw bad('Arquivo muito grande (máximo 5 MB).'); });
        if (file.file.truncated)
            throw bad('Arquivo muito grande (máximo 5 MB).');
        return anexarComprovante(id, buf, me(req));
    });
    app.get('/api/oneup/crm/comprovantes/:id', on, async (req, reply) => {
        const c = await comprovante(parse(idParam, req.params).id);
        const st = await stat(c.caminho).catch(() => null);
        if (!st?.isFile())
            throw new HttpError(404, 'Arquivo do comprovante não encontrado.');
        reply.header('content-type', mimeComprovante(c.tipo));
        reply.header('content-length', st.size);
        reply.header('cache-control', 'private, no-store');
        reply.header('content-disposition', `inline; filename="comprovante-${c.cobrancaId}.${c.tipo}"`);
        reply.header('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
        return reply.send(createReadStream(c.caminho));
    });
    app.delete('/api/oneup/crm/comprovantes/:id', on, async (req) => apagarComprovante(parse(idParam, req.params).id, me(req)));
    app.get('/api/oneup/crm/relatorio', on, async (req) => {
        const q = parse(z.object({ mes: z.string().regex(/^\d{4}-\d{2}$/, 'mês inválido').optional() }), req.query);
        await sincronizar();
        return relatorio(q.mes ?? relogio().dia.slice(0, 7));
    });
    app.get('/api/oneup/crm/insights', on, async () => { await sincronizar(); return insights(); });
    app.get('/api/oneup/crm/config', on, async () => ({ config: await lerCrmConfig(), padrao: CONFIG_PADRAO }));
    app.put('/api/oneup/crm/config', on, async (req) => {
        const b = parse(z.object({ config: z.unknown() }), req.body);
        return { config: await salvarCrmConfig(b.config, me(req)) };
    });
}
