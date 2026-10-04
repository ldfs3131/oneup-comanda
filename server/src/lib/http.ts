import type { FastifyReply, FastifyRequest } from 'fastify';
import { z, type ZodType } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: unknown) { super(message); }
}
export const bad = (msg: string) => new HttpError(400, msg);
export const notFound = (msg = 'Registro não encontrado.') => new HttpError(404, msg);
export const forbidden = (msg = 'Sem permissão para esta ação.') => new HttpError(403, msg);
export const conflict = (msg: string) => new HttpError(409, msg);

// mensagens de validação em português (antes saíam em inglês para o Dono e o caixa)
z.config(z.locales.ptBR());
const CAMPOS: Record<string, string> = {
  name: 'nome', username: 'login', password: 'senha', next: 'nova senha', current: 'senha atual', role: 'perfil',
  priceCents: 'preço', costCents: 'custo', amountCents: 'valor', tenderedCents: 'valor recebido', customerName: 'nome do cliente',
  customerPhone: 'telefone', reason: 'motivo', description: 'descrição', quantity: 'quantidade', note: 'observação',
  table: 'mesa', categoryId: 'categoria', items: 'itens', payments: 'pagamentos', date: 'data', from: 'data inicial', to: 'data final',
  taxaPct: 'taxa', openingCashCents: 'troco inicial', countedCashCents: 'valor contado',
};
const campo = (path: PropertyKey[]) => path.filter((p) => typeof p === 'string').map((p) => CAMPOS[p as string] ?? String(p)).join(' › ');

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    const path = first ? campo(first.path) : '';
    throw bad(`Confira ${path ? `o campo "${path}"` : 'os campos'}: ${first?.message ?? 'valor inválido'}`);
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
  if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, code: err.code, details: err.details });
  const e = err as { statusCode?: number; message?: string; code?: string };
  if (e?.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.message ?? 'Requisição inválida.' });
  // Violações das travas do banco viram mensagem legível
  // (o Drizzle embrulha o erro do PostgreSQL em "cause")
  const pgErr = (e?.code ? e : (err as { cause?: { code?: string; message?: string } })?.cause) ?? {};
  if (pgErr.code === 'P0001') return reply.status(409).send({ error: pgErr.message });
  if (pgErr.code === '40P01' || pgErr.code === '40001') return reply.status(409).send({ error: 'Outra pessoa alterou esta conta no mesmo instante. Confira a tela e tente de novo.', code: 'CONCORRENCIA' });
  if (pgErr.code === '23505') return reply.status(409).send({ error: 'Registro duplicado.' });
  if (pgErr.code === '23503') return reply.status(400).send({ error: 'Referência inválida: registro não encontrado.' });
  if (pgErr.code === '42501') return reply.status(403).send({ error: 'Operação não permitida.' });
  _req.log.error(err);
  return reply.status(500).send({ error: 'Erro interno. Tente novamente.' });
}

/** Data de hoje (AAAA-MM-DD) no fuso do restaurante (America/Sao_Paulo). */
export function hojeSP(offsetDias = 0): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() + offsetDias * 86400_000));
}
