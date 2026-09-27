import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';
import { config } from '../config.js';

// Datas vêm como timestamptz; inteiros grandes (count/sum) viram number
pg.types.setTypeParser(20, (v) => Number(v)); // int8
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
// Queda momentânea do PostgreSQL não derruba o servidor: a conexão é refeita na próxima consulta
pool.on('error', (e) => console.error('[banco] conexão perdida:', e.message));

/** Espera o PostgreSQL ficar disponível (ex.: logo após ligar o computador). */
export async function waitForDatabase(maxTries = 60) {
  for (let i = 1; ; i++) {
    try { await pool.query('SELECT 1'); return; } catch (e) {
      if (i >= maxTries) throw e;
      if (i === 1 || i % 10 === 0) console.log(`Aguardando o banco de dados... (${(e as Error).message})`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
export const db = drizzle(pool, { schema });
export type DB = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
export type Executor = DB | Tx;

export async function runMigrations() {
  await migrate(db, { migrationsFolder: config.migrationsDir });
}

/** Próximo número sequencial (conta, pedido) dentro da transação. */
export async function nextNumber(tx: Executor, name: 'account' | 'order'): Promise<number> {
  const r = await tx.execute(sql`
    INSERT INTO counters (name, value) VALUES (${name}, 1)
    ON CONFLICT (name) DO UPDATE SET value = counters.value + 1
    RETURNING value`);
  return Number((r.rows[0] as { value: number }).value);
}

/** Dados obrigatórios que o sistema precisa para funcionar (idempotente). */
export async function ensureBaseData() {
  await db.insert(schema.roles).values([
    { code: 'ADMIN', name: 'Administrador' },
    { code: 'CAIXA', name: 'Caixa' },
    { code: 'COZINHA', name: 'Cozinha' },
  ]).onConflictDoNothing();
  await db.insert(schema.paymentMethods).values([
    { code: 'PIX', name: 'PIX', isCash: false, sortOrder: 1 },
    { code: 'DINHEIRO', name: 'Dinheiro', isCash: true, sortOrder: 2 },
    { code: 'CARTAO', name: 'Cartão', isCash: false, sortOrder: 3 },
  ]).onConflictDoNothing();
  await db.insert(schema.restaurantSettings).values({ id: 1 }).onConflictDoNothing();
  await db.insert(schema.deliverySettings).values({ id: 1 }).onConflictDoNothing();
}
