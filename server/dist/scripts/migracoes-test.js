/**
 * Migrações: o Drizzle só aplica uma migração se o "when" dela for MAIOR que o da última aplicada.
 * "when" repetido ou fora de ordem = migração pulada em silêncio em quem atualiza (achado CRÍTICO da auditoria de 04/10).
 *   DATABASE_URL=<banco recém-instalado> node dist/scripts/migracoes-test.js
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
let ok = 0;
const falhas = [];
const check = (l, c, x) => { if (c) {
    ok++;
    console.log(`  ✔ ${l}`);
}
else {
    falhas.push(l);
    console.log(`  ✘ ${l}`, x === undefined ? '' : JSON.stringify(x));
} };
const j = JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8'));
const e = j.entries;
check('Índices em sequência (0, 1, 2…)', e.every((x, i) => x.idx === i), e.map((x) => x.idx));
check('"when" estritamente crescente (nenhuma migração é pulada ao atualizar)', e.every((x, i) => i === 0 || x.when > e[i - 1].when), e.map((x) => [x.tag, x.when]));
check('Número do arquivo = índice', e.every((x) => Number(x.tag.slice(0, 4)) === x.idx), e.map((x) => x.tag));
check('Todo arquivo do journal existe', e.every((x) => existsSync(join(DIR, `${x.tag}.sql`))));
check('Tags sem repetição', new Set(e.map((x) => x.tag.slice(0, 4))).size === e.length);
if (process.env.DATABASE_URL) {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const n = Number((await c.query('SELECT count(*) FROM drizzle.__drizzle_migrations')).rows[0].count);
    check(`Instalação nova aplicou todas as ${e.length} migrações`, n === e.length, n);
    const col = await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name='sessions' AND column_name='aparelho_id'`);
    check('Última migração presente no banco (sessions.aparelho_id)', col.rowCount === 1);
    await c.end();
}
console.log(`\nResultado migrações: ${ok} verificações OK, ${falhas.length} falhas.`);
if (falhas.length)
    process.exit(1);
