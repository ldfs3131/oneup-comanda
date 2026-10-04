import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { currentContext } from '../db/index.js';
import { dataVersion, menuVersion } from './cache.js';

/*
 * RESPOSTA COMPARTILHADA DE TELAS DE LEITURA (painel do caixa, cozinha, painel do dono, cardápio)
 * Quando um pedido muda, todas as telas abertas da empresa buscam de novo ao mesmo tempo. Em vez de cada
 * uma recalcular tudo no banco, a primeira calcula e as outras recebem a MESMA resposta (por versão dos dados).
 * Uso: preHandler: [requireRole('CAIXA'), respostaCompartilhada('board', 'dados', 5000)] — sempre DEPOIS do login.
 */
type Entrada = { versao: number; ate: number; payload?: string; pendente?: Promise<string | null>; resolver?: (p: string | null) => void };
const guardadas = new Map<string, Entrada>();
declare module 'fastify' {
  interface FastifyRequest { cacheRota?: { chave: string; versao: number; ttl: number; resolver: (p: string | null) => void } }
}

export function respostaCompartilhada(nome: string, tipo: 'dados' | 'menu', ttlMs: number) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const versao = tipo === 'menu' ? menuVersion() : dataVersion();
    const chave = `${currentContext()?.empresaId ?? 0}:${nome}:${req.user?.role ?? '-'}${req.user?.oneup ? '+oneup' : ''}:${req.url}`;
    const e = guardadas.get(chave);
    if (e && e.versao === versao) {
      if (e.payload !== undefined && e.ate > Date.now()) return enviar(reply, e.payload);
      if (e.pendente) {
        const p = await Promise.race([e.pendente, new Promise<null>((r) => setTimeout(() => r(null), 10_000))]);
        if (p !== null) return enviar(reply, p);
      }
    }
    let resolver!: (p: string | null) => void;
    const pendente = new Promise<string | null>((r) => { resolver = r; });
    if (guardadas.size > 20_000) guardadas.clear();
    guardadas.set(chave, { versao, ate: 0, pendente, resolver });
    req.cacheRota = { chave, versao, ttl: ttlMs, resolver };
  };
}

function enviar(reply: FastifyReply, payload: string) {
  reply.header('content-type', 'application/json; charset=utf-8');
  reply.header('x-resposta', 'compartilhada');
  return reply.send(payload);
}

function concluir(req: FastifyRequest, payload: string | null) {
  const c = req.cacheRota;
  if (!c) return;
  req.cacheRota = undefined;
  const atual = guardadas.get(c.chave);
  if (payload !== null) {
    if (!atual || atual.versao <= c.versao) guardadas.set(c.chave, { versao: c.versao, ate: Date.now() + c.ttl, payload });
  } else if (atual?.resolver === c.resolver) guardadas.delete(c.chave);
  c.resolver(payload);
}

export function registrarRespostaCompartilhada(app: FastifyInstance) {
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.cacheRota) concluir(req, reply.statusCode === 200 && typeof payload === 'string' ? payload : null);
    return payload;
  });
  app.addHook('onRequestAbort', async (req) => concluir(req, null));
  app.addHook('onError', async (req) => concluir(req, null));
}
