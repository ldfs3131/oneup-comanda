import type { FastifyRequest } from 'fastify';
import { eq, lt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { idempotencyKeys } from '../db/schema.js';
import { HttpError } from './http.js';

/**
 * Protege criações contra duplicidade (duplo clique, reenvio em rede lenta).
 * O navegador manda um cabeçalho Idempotency-Key único por tentativa de envio.
 * Se a mesma chave chegar de novo, devolve a resposta original sem executar nada.
 */
export async function idempotent<T>(req: FastifyRequest, route: string, fn: () => Promise<T>): Promise<T> {
  const raw = req.headers['idempotency-key'];
  const key = typeof raw === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(raw) ? `${req.user?.id ?? 0}:${raw}` : null;
  if (!key) return fn();

  const inserted = await db.insert(idempotencyKeys).values({ key, userId: req.user?.id ?? null, route, status: 0 })
    .onConflictDoNothing().returning({ key: idempotencyKeys.key });
  if (!inserted.length) {
    const [row] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
    if (row?.status === 200) return row.response as T;
    throw new HttpError(409, 'Este envio já está sendo processado. Aguarde um instante.', 'DUPLICATE_IN_FLIGHT');
  }
  try {
    const result = await fn();
    await db.update(idempotencyKeys).set({ status: 200, response: result as object }).where(eq(idempotencyKeys.key, key));
    return result;
  } catch (e) {
    // falhou: libera a chave para o operador poder tentar de novo (ex.: depois de resolver o estoque)
    await db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, key));
    throw e;
  }
}

/** Limpeza de chaves antigas (roda na inicialização). */
export async function cleanupIdempotency() {
  await db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, new Date(Date.now() - 2 * 86400_000)));
}
