import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db, empresaAtual } from '../db/index.js';
import { analiseRelatorios, restaurantSettings } from '../db/schema.js';
import { me, requireRole } from '../auth.js';
import { HttpError, bad, conflict, parse } from '../lib/http.js';
import { dataVersion } from '../lib/cache.js';
import { todayLocal } from './admin.js';
import { somarMeses } from '../services/ritmo.js';
import { pacoteDoMes, roteiroReuniao, textoWhatsapp, nomeMes } from '../services/analise.js';
const mesSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'mês no formato AAAA-MM');
const acaoSchema = z.object({
    id: z.string().min(1).max(120),
    texto: z.string().trim().min(3).max(400),
    meta: z.string().trim().max(300).default(''),
    semana: z.number().int().min(1).max(4).default(1),
    esperadoCents: z.number().int().nullable().default(null),
    premissa: z.string().max(500).nullable().default(null),
    dono: z.string().max(40).nullable().default(null),
    metrica: z.object({ chave: z.string().max(120), antes: z.union([z.number(), z.record(z.string(), z.number())]).nullable(), unidade: z.enum(['BRL', 'PCT', 'MIN', 'UN', 'DIAS', 'PRODUTO']) }).nullable().default(null),
    status: z.enum(['PENDENTE', 'FEITO', 'NAO_FEITO']).default('PENDENTE'),
});
/** Guarda: qualquer perfil logado que não seja da ONE UP recebe 404 (Caixa e Cozinha também). */
async function soOneup(req, reply) {
    await requireRole()(req, reply);
    if (!me(req).oneup)
        throw new HttpError(404, 'Recurso não disponível.');
}
// cache por empresa + mês + versão dos dados (o pacote faz dezenas de consultas)
const cache = new Map();
async function relatorioDe(mes) {
    const [r] = await db.select().from(analiseRelatorios).where(eq(analiseRelatorios.mes, mes));
    return r ?? null;
}
async function pacote(mes) {
    const hoje = todayLocal();
    if (mes > hoje.slice(0, 7))
        throw bad('Esse mês ainda não começou.');
    const rel = await relatorioDe(mes);
    if (rel?.status === 'FINALIZADO' && rel.retrato)
        return { ...rel.retrato, congelado: true };
    const key = `${empresaAtual()}:${mes}:${hoje}:${dataVersion()}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 60_000)
        return hit.v;
    const anterior = await relatorioDe(somarMeses(mes, -1));
    const v = await pacoteDoMes(db, { mes, hoje, acoesMesAnterior: anterior ? anterior.acoes : null, mesAnteriorStatus: anterior?.status ?? null });
    if (cache.size > 200)
        cache.clear();
    cache.set(key, { at: Date.now(), v });
    return v;
}
const vistaRelatorio = (mes, r, p) => r
    ? { mes, salvo: true, status: r.status, parecer: r.parecer, acoes: r.acoes, finalizadoEm: r.finalizadoEm, atualizadoEm: r.updatedAt }
    : { mes, salvo: false, status: 'RASCUNHO', parecer: '', acoes: p.plano, finalizadoEm: null, atualizadoEm: null };
export async function analiseRoutes(app) {
    const g = { preHandler: soOneup };
    /** Meses disponíveis (do primeiro pedido até hoje) e a situação do relatório de cada um. */
    app.get('/api/oneup/analise/meses', g, async () => {
        const hoje = todayLocal().slice(0, 7);
        const [p] = (await db.execute(sql `SELECT to_char(MIN(created_at AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM') AS mes FROM orders`)).rows;
        const rels = await db.select({ mes: analiseRelatorios.mes, status: analiseRelatorios.status }).from(analiseRelatorios);
        const st = new Map(rels.map((r) => [r.mes, r.status]));
        const ini = p?.mes && p.mes < hoje ? p.mes : hoje;
        const meses = [];
        for (let k = hoje; k >= ini && meses.length < 36; k = somarMeses(k, -1))
            meses.push({ mes: k, nome: nomeMes(k), status: st.get(k) ?? null });
        return { meses };
    });
    /** Pacote completo do mês (mês atual até hoje por padrão). Mês finalizado devolve o retrato congelado. */
    app.get('/api/oneup/analise', g, async (req) => {
        const q = parse(z.object({ mes: mesSchema.optional() }), req.query);
        const mes = q.mes ?? todayLocal().slice(0, 7);
        const p = await pacote(mes);
        const r = await relatorioDe(mes);
        return { ...p, relatorio: vistaRelatorio(mes, r, p) };
    });
    app.get('/api/oneup/analise/relatorio/:mes', g, async (req) => {
        const { mes } = parse(z.object({ mes: mesSchema }), req.params);
        const p = await pacote(mes);
        const r = await relatorioDe(mes);
        const [s] = await db.select({ name: restaurantSettings.name }).from(restaurantSettings).limit(1);
        return { restaurante: s?.name ?? '', relatorio: vistaRelatorio(mes, r, p), pacote: p };
    });
    /** Salva o parecer e as ações (com status feito / não feito). Finalizado não muda. */
    app.put('/api/oneup/analise/relatorio/:mes', g, async (req) => {
        const { mes } = parse(z.object({ mes: mesSchema }), req.params);
        const b = parse(z.object({ parecer: z.string().max(8000).optional(), acoes: z.array(acaoSchema).max(10).optional() }), req.body);
        if (mes > todayLocal().slice(0, 7))
            throw bad('Esse mês ainda não começou.');
        const r = await relatorioDe(mes);
        if (r?.status === 'FINALIZADO')
            throw conflict('Relatório finalizado: não pode mais ser alterado.');
        if (r) {
            await db.update(analiseRelatorios).set({
                ...(b.parecer !== undefined ? { parecer: b.parecer } : {}), ...(b.acoes !== undefined ? { acoes: b.acoes } : {}),
                userId: me(req).id, updatedAt: new Date(),
            }).where(and(eq(analiseRelatorios.mes, mes), sql `status <> 'FINALIZADO'`));
        }
        else {
            const acoes = b.acoes ?? (await pacote(mes)).plano;
            await db.insert(analiseRelatorios).values({ mes, parecer: b.parecer ?? '', acoes, userId: me(req).id });
        }
        const atual = (await relatorioDe(mes));
        return { ok: true, relatorio: { mes, salvo: true, status: atual.status, parecer: atual.parecer, acoes: atual.acoes, finalizadoEm: atual.finalizadoEm, atualizadoEm: atual.updatedAt } };
    });
    /** Rascunho → Revisão → Finalizado (ao finalizar, congela o retrato com o pacote; depois disso nada muda). */
    app.post('/api/oneup/analise/relatorio/:mes/status', g, async (req) => {
        const { mes } = parse(z.object({ mes: mesSchema }), req.params);
        const { status } = parse(z.object({ status: z.enum(['RASCUNHO', 'REVISAO', 'FINALIZADO']) }), req.body);
        let r = await relatorioDe(mes);
        if (!r) {
            const p = await pacote(mes);
            await db.insert(analiseRelatorios).values({ mes, acoes: p.plano, userId: me(req).id });
            r = (await relatorioDe(mes));
        }
        if (r.status === 'FINALIZADO')
            throw conflict('Relatório já finalizado: não muda mais.');
        const permitido = { RASCUNHO: ['REVISAO'], REVISAO: ['RASCUNHO', 'FINALIZADO'] };
        if (!permitido[r.status]?.includes(status))
            throw conflict(status === 'FINALIZADO' ? 'Passe o relatório para "em revisão" antes de finalizar.' : 'Mudança de situação não permitida.');
        if (status === 'FINALIZADO') {
            if (mes >= todayLocal().slice(0, 7))
                throw conflict('Só dá para finalizar um mês encerrado.');
            cache.clear();
            const retrato = await pacote(mes);
            const upd = await db.update(analiseRelatorios).set({ status, retrato, finalizadoEm: new Date(), userId: me(req).id, updatedAt: new Date() })
                .where(and(eq(analiseRelatorios.mes, mes), eq(analiseRelatorios.status, 'REVISAO'))).returning({ id: analiseRelatorios.id });
            if (!upd.length)
                throw conflict('O relatório mudou enquanto você finalizava. Atualize a tela.');
        }
        else {
            await db.update(analiseRelatorios).set({ status, userId: me(req).id, updatedAt: new Date() }).where(eq(analiseRelatorios.mes, mes));
        }
        return { ok: true, status };
    });
    /** Resumo para WhatsApp (até 10 linhas: nota, dinheiro na mesa, top 3 ações). */
    app.get('/api/oneup/analise/relatorio/:mes/whatsapp', g, async (req) => {
        const { mes } = parse(z.object({ mes: mesSchema }), req.params);
        const [s] = await db.select({ name: restaurantSettings.name }).from(restaurantSettings).limit(1);
        return { texto: textoWhatsapp(await pacote(mes), s?.name ?? '') };
    });
    /** Roteiro da reunião mensal (1 página, só para a ONE UP). */
    app.get('/api/oneup/analise/relatorio/:mes/roteiro', g, async (req) => {
        const { mes } = parse(z.object({ mes: mesSchema }), req.params);
        return roteiroReuniao(await pacote(mes));
    });
}
