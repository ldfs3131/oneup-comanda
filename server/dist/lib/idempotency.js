import { eq, lt } from 'drizzle-orm';
import { db, runAsEmpresa, runAsSystem } from '../db/index.js';
import { empresas, idempotencyKeys } from '../db/schema.js';
import { HttpError } from './http.js';
/**
 * Protege criações contra duplicidade (duplo clique, reenvio em rede lenta).
 * O navegador manda um cabeçalho Idempotency-Key único por tentativa de envio.
 * Se a mesma chave chegar de novo, devolve a resposta original sem executar nada.
 */
export async function idempotent(req, route, fn) {
    const raw = req.headers['idempotency-key'];
    const key = typeof raw === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(raw) ? `${req.user?.id ?? 0}:${raw}` : null;
    if (!key)
        return fn();
    const inserted = await db.insert(idempotencyKeys).values({ key, userId: req.user?.id ?? null, route, status: 0 })
        .onConflictDoNothing().returning({ key: idempotencyKeys.key });
    if (!inserted.length) {
        const [row] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
        if (row && row.route !== route)
            throw new HttpError(409, 'Este envio pertence a outra ação. Atualize a tela e tente de novo.', 'IDEMPOTENCY_ROUTE');
        if (row?.status === 200)
            return row.response;
        throw new HttpError(409, 'Este envio já está sendo processado. Aguarde um instante.', 'DUPLICATE_IN_FLIGHT');
    }
    try {
        const result = await fn();
        await db.update(idempotencyKeys).set({ status: 200, response: result }).where(eq(idempotencyKeys.key, key));
        return result;
    }
    catch (e) {
        // falhou: libera a chave para o operador poder tentar de novo (ex.: depois de resolver o estoque)
        await db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, key));
        throw e;
    }
}
/** Limpeza de chaves antigas da empresa do contexto atual (roda na inicialização e uma vez por dia). */
export async function cleanupIdempotency() {
    await db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, new Date(Date.now() - 2 * 86400_000)));
}
/** Limpeza diária, empresa por empresa (servidor que fica semanas no ar sem reiniciar não acumula chaves). */
export function iniciarLimpezaIdempotency(intervaloMs = 24 * 3600_000) {
    const rodar = async () => {
        try {
            const lista = await runAsSystem(() => db.select({ id: empresas.id, status: empresas.status }).from(empresas));
            for (const e of lista.filter((x) => x.status !== 'CANCELADA')) {
                await runAsEmpresa(e.id, cleanupIdempotency).catch((err) => console.warn(`  Limpeza de chaves de repetição (empresa ${e.id}): ${err.message}`));
            }
        }
        catch (err) {
            console.warn('  Limpeza de chaves de repetição: ' + err.message);
        }
    };
    setInterval(rodar, intervaloMs).unref();
}
