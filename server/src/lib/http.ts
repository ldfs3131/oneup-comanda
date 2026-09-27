import type { FastifyReply, FastifyRequest } from 'fastify';
import { z, type ZodType } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const bad = (msg: string) => new HttpError(400, msg);
export const notFound = (msg = 'Registro não encontrado.') => new HttpError(404, msg);
export const forbidden = (msg = 'Sem permissão para esta ação.') => new HttpError(403, msg);
export const conflict = (msg: string) => new HttpError(409, msg);

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    const path = first?.path?.join('.') ?? '';
    throw bad(`Dados inválidos${path ? ` (${path})` : ''}: ${first?.message ?? 'verifique os campos'}`);
  }
  return r.data;
}

export const idParam = z.object({ id: z.coerce.number().int().positive() });

export function brl(cents: number): string {
  const neg = cents < 0;
  const [int, dec] = (Math.abs(cents) / 100).toFixed(2).split('.');
  return `${neg ? '-' : ''}R$ ${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`;
}

export const reasonSchema = z.string().trim().min(3, 'Informe o motivo (mínimo 3 letras)').max(300);
export const centsSchema = z.number().int().positive().max(100_000_00);

export function errorHandler(err: unknown, _req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
  const e = err as { statusCode?: number; message?: string; code?: string };
  if (e?.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.message ?? 'Requisição inválida.' });
  // Violações das travas do banco viram mensagem legível
  if (e?.code === 'P0001') return reply.status(409).send({ error: e.message });
  if (e?.code === '23505') return reply.status(409).send({ error: 'Registro duplicado.' });
  _req.log.error(err);
  return reply.status(500).send({ error: 'Erro interno. Tente novamente.' });
}
