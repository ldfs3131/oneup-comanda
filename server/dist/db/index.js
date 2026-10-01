import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';
import { config } from '../config.js';
// Datas vêm como timestamptz; inteiros grandes (count/sum) viram number
pg.types.setTypeParser(20, (v) => Number(v)); // int8
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric
const als = new AsyncLocalStorage();
export const systemPool = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });
export const appPool = new pg.Pool({
    connectionString: config.appDatabaseUrl ?? config.databaseUrl,
    max: config.dbPoolSize,
    options: `-c role=${config.appDbRole}`,
});
// Queda momentânea do PostgreSQL não derruba o servidor: a conexão é refeita na próxima consulta
for (const p of [systemPool, appPool])
    p.on('error', (e) => console.error('[banco] conexão perdida:', e.message));
/** Compatibilidade: código antigo que usava `pool` direto passa a usar o pool de sistema. */
export const pool = systemPool;
class ContextError extends Error {
}
async function acquire(ctx) {
    if (ctx.client)
        return ctx.client;
    if (ctx.released)
        throw new ContextError('Conexão do banco já devolvida: tarefa rodando depois da resposta. Use runAsEmpresa().');
    if (!ctx.pending) {
        ctx.pending = (async () => {
            const c = await (ctx.kind === 'system' ? systemPool : appPool).connect();
            const onError = () => { ctx.broken = true; };
            c.on('error', onError);
            ctx.offError = () => c.off('error', onError);
            if (ctx.kind === 'app') {
                try {
                    await c.query("SELECT set_config('app.empresa_id', $1, false)", [ctx.empresaId == null ? '' : String(ctx.empresaId)]);
                }
                catch (e) {
                    c.release(true);
                    throw e;
                }
            }
            ctx.client = c;
            return c;
        })();
        ctx.pending.catch(() => { ctx.pending = undefined; });
    }
    return ctx.pending;
}
export async function releaseContext(ctx) {
    if (!ctx || ctx.released)
        return;
    ctx.released = true;
    let c = ctx.client;
    if (!c && ctx.pending)
        c = await ctx.pending.catch(() => undefined);
    if (!c)
        return;
    if (ctx.kind === 'app' && !ctx.broken) {
        try {
            await c.query("SELECT set_config('app.empresa_id', '', false)");
        }
        catch {
            ctx.broken = true;
        }
    }
    ctx.offError?.();
    c.release(ctx.broken ? true : undefined);
}
/** "Cliente" que o Drizzle usa: encaminha cada consulta para a conexão do contexto atual. */
class ConexaoDaEmpresa {
    query(config, values) {
        const ctx = als.getStore();
        if (!ctx)
            return Promise.reject(new ContextError('Consulta ao banco fora de contexto de empresa (recusada por segurança).'));
        return acquire(ctx).then((c) => c.query(config, values));
    }
}
export const db = drizzle(new ConexaoDaEmpresa(), { schema });
export function runInContext(ctx, fn) {
    return als.run(ctx, async () => {
        try {
            return await fn();
        }
        finally {
            await releaseContext(ctx);
        }
    });
}
/** Executa como a empresa indicada (RLS ligado). Use em tarefas de fundo, scripts e Socket.IO. */
export const runAsEmpresa = (empresaId, fn) => runInContext({ kind: 'app', empresaId }, fn);
/** Executa como a plataforma (sem RLS). Só para migrações, cadastro de empresas e tarefas da ONE UP. */
export const runAsSystem = (fn) => runInContext({ kind: 'system', empresaId: null }, fn);
/** Liga o contexto à continuação atual (usado pelo hook da requisição). */
export const bindContext = (ctx, fn) => als.run(ctx, fn);
export const currentContext = () => als.getStore();
/** Empresa da requisição/tarefa atual. Falha se não houver (nunca "adivinha"). */
export function empresaAtual() {
    const id = als.getStore()?.empresaId;
    if (!id)
        throw new ContextError('Empresa não definida no contexto.');
    return id;
}
/** Espera o PostgreSQL ficar disponível (ex.: logo após ligar o servidor). */
export async function waitForDatabase(maxTries = 60) {
    for (let i = 1;; i++) {
        try {
            await systemPool.query('SELECT 1');
            return;
        }
        catch (e) {
            if (i >= maxTries)
                throw e;
            if (i === 1 || i % 10 === 0)
                console.log(`Aguardando o banco de dados... (${e.message})`);
            await new Promise((r) => setTimeout(r, 3000));
        }
    }
}
export async function runMigrations() {
    await runAsSystem(() => migrate(db, { migrationsFolder: config.migrationsDir }));
}
/** Próximo número sequencial (conta, pedido) da empresa atual, dentro da transação. */
export async function nextNumber(tx, name) {
    const r = await tx.execute(sql `
    INSERT INTO counters (name, value) VALUES (${name}, 1)
    ON CONFLICT (empresa_id, name) DO UPDATE SET value = counters.value + 1
    RETURNING value`);
    return Number(r.rows[0].value);
}
/** Dados globais da plataforma (sistema). */
export async function ensurePlatformData() {
    await runAsSystem(async () => {
        await db.insert(schema.roles).values([
            { code: 'ADMIN', name: 'Administrador' },
            { code: 'CAIXA', name: 'Caixa' },
            { code: 'COZINHA', name: 'Cozinha' },
        ]).onConflictDoNothing();
    });
}
const CATEGORIAS_DESPESA = ['Funcionários', 'Combustível', 'Energia', 'Água', 'Taxas', 'Compras', 'Limpeza', 'Manutenção', 'Embalagens', 'Entrega', 'Comunicação', 'Outros'];
/** Dados mínimos de UMA empresa (idempotente). Deve rodar dentro do contexto da empresa. */
export async function ensureEmpresaBase() {
    await db.insert(schema.paymentMethods).values([
        { code: 'PIX', name: 'PIX', isCash: false, sortOrder: 1 },
        { code: 'DINHEIRO', name: 'Dinheiro', isCash: true, sortOrder: 2 },
        { code: 'CARTAO', name: 'Cartão', isCash: false, sortOrder: 3 },
    ]).onConflictDoNothing();
    const [emp] = await db.select().from(schema.empresas).limit(1);
    // menuSeedVersion atual: empresa nova nunca recebe atualização automática de cardápio de exemplo
    await db.insert(schema.restaurantSettings).values({ name: emp?.nome ?? 'Meu restaurante', menuSeedVersion: 2 }).onConflictDoNothing();
    await db.insert(schema.deliverySettings).values({}).onConflictDoNothing();
    const cats = await db.select({ id: schema.expenseCategories.id }).from(schema.expenseCategories).limit(1);
    if (!cats.length) {
        await db.insert(schema.expenseCategories).values(CATEGORIAS_DESPESA.map((name, i) => ({ name, sortOrder: i + 1 }))).onConflictDoNothing();
    }
}
/** Compatibilidade com scripts antigos: plataforma + empresa do contexto. */
export async function ensureBaseData() {
    await ensurePlatformData();
    await ensureEmpresaBase();
}
/** Fecha as conexões (fim de scripts). */
export async function closePools() {
    await appPool.end().catch(() => undefined);
    await systemPool.end().catch(() => undefined);
}
