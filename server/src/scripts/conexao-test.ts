/**
 * Segurança das conexões por empresa (requisição cancelada no meio de uma transação).
 *   DATABASE_URL=... node dist/scripts/conexao-test.js   (banco com as empresas alfa e beta)
 */
import { sql } from 'drizzle-orm';
import { appPool, closePools, db, releaseContext, runAsSystem, type DbContext } from '../db/index.js';
import { AsyncLocalStorage } from 'node:async_hooks';

let ok = 0; const fails: string[] = [];
const check = (l: string, c: unknown, x?: unknown) => { if (c) { ok++; console.log(`  ✔ ${l}`); } else { fails.push(l); console.log(`  ✘ ${l}`, x ?? ''); } };

async function main() {
  const ids = await runAsSystem(async () => Object.fromEntries(((await db.execute(sql`SELECT slug, id FROM empresas`)).rows as { slug: string; id: number }[]).map((r) => [r.slug, r.id])));
  const { bindContext } = await import('../db/index.js');
  const run = <T,>(ctx: DbContext, fn: () => Promise<T>) => new Promise<T>((res, rej) => bindContext(ctx, () => { fn().then(res, rej); }));
  void AsyncLocalStorage;

  console.log('\n[1] Requisição cancelada no meio de uma transação');
  const a: DbContext = { kind: 'app', empresaId: ids.alfa };
  let pidA = 0;
  let txErro: unknown = null;
  const tx = run(a, () => db.transaction(async (t) => {
    pidA = Number(((await t.execute(sql`SELECT pg_backend_pid() AS p`)).rows[0] as { p: number }).p);
    await new Promise((r) => setTimeout(r, 300)); // "aparelho cai" aqui
    await t.execute(sql`SELECT 1`);
  })).catch((e) => { txErro = e; });
  await new Promise((r) => setTimeout(r, 100));
  const antes = appPool.totalCount;
  await releaseContext(a, { abortada: true });
  await tx;
  const msgs = (e: any): string => (e ? `${e.message ?? e} ${msgs(e.cause)}` : '');
  check('Depois de devolvida, a transação antiga NÃO consegue mais usar a conexão', txErro && /devolvida/.test(msgs(txErro)), msgs(txErro));
  check('Conexão cancelada no meio foi DESCARTADA (não volta para o pool)', appPool.totalCount === antes - 1, { antes, depois: appPool.totalCount });

  console.log('\n[2] A próxima requisição (outra empresa) recebe conexão limpa');
  const b: DbContext = { kind: 'app', empresaId: ids.beta };
  const r = await run(b, async () => (await db.execute(sql`SELECT pg_backend_pid() AS p, current_setting('app.empresa_id') AS e, now() <> statement_timestamp() AS emtx`)).rows[0] as { p: number; e: string; emtx: boolean });
  await releaseContext(b);
  check('Não é a mesma conexão da transação cancelada', Number(r.p) !== pidA, r);
  check('Empresa da conexão é a Beta e não há transação aberta', r.e === String(ids.beta) && r.emtx === false, r);

  console.log('\n[3] Devolução normal com transação esquecida aberta');
  const c: DbContext = { kind: 'app', empresaId: ids.alfa };
  await run(c, async () => { await db.execute(sql`BEGIN`); await db.execute(sql`SELECT 1`); });
  const n0 = appPool.totalCount;
  await releaseContext(c);
  check('Conexão ainda em transação é descartada, mesmo sem cancelamento', appPool.totalCount === n0 - 1, { n0, depois: appPool.totalCount });

  console.log('\n[4] Devolução normal reaproveita a conexão limpa');
  const d: DbContext = { kind: 'app', empresaId: ids.alfa };
  const p1 = await run(d, async () => Number(((await db.execute(sql`SELECT pg_backend_pid() AS p`)).rows[0] as { p: number }).p));
  const n1 = appPool.totalCount; await releaseContext(d);
  check('Conexão limpa volta para o pool (sem desperdício)', appPool.totalCount === n1, { n1, depois: appPool.totalCount });
  const e: DbContext = { kind: 'app', empresaId: ids.beta };
  const r2 = await run(e, async () => (await db.execute(sql`SELECT pg_backend_pid() AS p, current_setting('app.empresa_id') AS e`)).rows[0] as { p: number; e: string });
  await releaseContext(e);
  check('Reaproveitada por outra empresa, já com a empresa certa', Number(r2.p) === p1 ? r2.e === String(ids.beta) : r2.e === String(ids.beta), r2);

  console.log(`\nResultado conexões: ${ok} OK, ${fails.length} falhas.`);
  if (fails.length) process.exitCode = 1;
}
main().then(closePools).catch(async (e) => { console.error(e); await closePools(); process.exit(1); });
