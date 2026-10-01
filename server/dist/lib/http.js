import { z } from 'zod';
export class HttpError extends Error {
    status;
    code;
    details;
    constructor(status, message, code, details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}
export const bad = (msg) => new HttpError(400, msg);
export const notFound = (msg = 'Registro não encontrado.') => new HttpError(404, msg);
export const forbidden = (msg = 'Sem permissão para esta ação.') => new HttpError(403, msg);
export const conflict = (msg) => new HttpError(409, msg);
export function parse(schema, data) {
    const r = schema.safeParse(data);
    if (!r.success) {
        const first = r.error.issues[0];
        const path = first?.path?.join('.') ?? '';
        throw bad(`Dados inválidos${path ? ` (${path})` : ''}: ${first?.message ?? 'verifique os campos'}`);
    }
    return r.data;
}
export const idParam = z.object({ id: z.coerce.number().int().positive() });
export function brl(cents) {
    const neg = cents < 0;
    const [int, dec] = (Math.abs(cents) / 100).toFixed(2).split('.');
    return `${neg ? '-' : ''}R$ ${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`;
}
export const reasonSchema = z.string().trim().min(3, 'Informe o motivo (mínimo 3 letras)').max(300);
export const centsSchema = z.number().int().positive().max(100_000_00);
export function errorHandler(err, _req, reply) {
    if (err instanceof HttpError)
        return reply.status(err.status).send({ error: err.message, code: err.code, details: err.details });
    const e = err;
    if (e?.statusCode && e.statusCode < 500)
        return reply.status(e.statusCode).send({ error: e.message ?? 'Requisição inválida.' });
    // Violações das travas do banco viram mensagem legível
    // (o Drizzle embrulha o erro do PostgreSQL em "cause")
    const pgErr = (e?.code ? e : err?.cause) ?? {};
    if (pgErr.code === 'P0001')
        return reply.status(409).send({ error: pgErr.message });
    if (pgErr.code === '40P01' || pgErr.code === '40001')
        return reply.status(409).send({ error: 'Outra pessoa alterou esta conta no mesmo instante. Confira a tela e tente de novo.', code: 'CONCORRENCIA' });
    if (pgErr.code === '23505')
        return reply.status(409).send({ error: 'Registro duplicado.' });
    if (pgErr.code === '23503')
        return reply.status(400).send({ error: 'Referência inválida: registro não encontrado.' });
    if (pgErr.code === '42501')
        return reply.status(403).send({ error: 'Operação não permitida.' });
    _req.log.error(err);
    return reply.status(500).send({ error: 'Erro interno. Tente novamente.' });
}
