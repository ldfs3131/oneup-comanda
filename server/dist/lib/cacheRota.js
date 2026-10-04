import { currentContext } from '../db/index.js';
import { dataVersion, menuVersion } from './cache.js';
const guardadas = new Map();
export function respostaCompartilhada(nome, tipo, ttlMs) {
    return async (req, reply) => {
        const versao = tipo === 'menu' ? menuVersion() : dataVersion();
        const chave = `${currentContext()?.empresaId ?? 0}:${nome}:${req.user?.role ?? '-'}${req.user?.oneup ? '+oneup' : ''}:${req.url}`;
        const e = guardadas.get(chave);
        if (e && e.versao === versao) {
            if (e.payload !== undefined && e.ate > Date.now())
                return enviar(reply, e.payload);
            if (e.pendente) {
                const p = await Promise.race([e.pendente, new Promise((r) => setTimeout(() => r(null), 10_000))]);
                if (p !== null)
                    return enviar(reply, p);
            }
        }
        let resolver;
        const pendente = new Promise((r) => { resolver = r; });
        if (guardadas.size > 20_000)
            guardadas.clear();
        guardadas.set(chave, { versao, ate: 0, pendente, resolver });
        req.cacheRota = { chave, versao, ttl: ttlMs, resolver };
    };
}
function enviar(reply, payload) {
    reply.header('content-type', 'application/json; charset=utf-8');
    reply.header('x-resposta', 'compartilhada');
    return reply.send(payload);
}
function concluir(req, payload) {
    const c = req.cacheRota;
    if (!c)
        return;
    req.cacheRota = undefined;
    const atual = guardadas.get(c.chave);
    if (payload !== null) {
        if (!atual || atual.versao <= c.versao)
            guardadas.set(c.chave, { versao: c.versao, ate: Date.now() + c.ttl, payload });
    }
    else if (atual?.resolver === c.resolver)
        guardadas.delete(c.chave);
    c.resolver(payload);
}
export function registrarRespostaCompartilhada(app) {
    app.addHook('onSend', async (req, reply, payload) => {
        if (req.cacheRota)
            concluir(req, reply.statusCode === 200 && typeof payload === 'string' ? payload : null);
        return payload;
    });
    app.addHook('onRequestAbort', async (req) => concluir(req, null));
    app.addHook('onError', async (req) => concluir(req, null));
}
