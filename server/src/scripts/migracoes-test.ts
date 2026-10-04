/**
 * Migrações: o Drizzle só aplica uma migração se o "when" dela for MAIOR que o da última aplicada.
 * "when" repetido ou fora de ordem = migração pulada em silêncio em quem atualiza (achado CRÍTICO da auditoria de 04/10).
 * Migração publicada também não se edita: quem já instalou NÃO roda o arquivo de novo, então a mudança nunca chegaria
 * (e instalações novas ficariam diferentes das antigas). Mudança nova = arquivo novo. O teste confere o sha256 de cada
 * migração já publicada contra a lista fixa abaixo.
 *   DATABASE_URL=<banco recém-instalado> node dist/scripts/migracoes-test.js
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
let ok = 0; const falhas: string[] = [];
const check = (l: string, c: unknown, x?: unknown) => { if (c) { ok++; console.log(`  ✔ ${l}`); } else { falhas.push(l); console.log(`  ✘ ${l}`, x === undefined ? '' : JSON.stringify(x)); } };

const j = JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; tag: string; when: number }[] };
const e = j.entries;
check('Índices em sequência (0, 1, 2…)', e.every((x, i) => x.idx === i), e.map((x) => x.idx));
check('"when" estritamente crescente (nenhuma migração é pulada ao atualizar)', e.every((x, i) => i === 0 || x.when > e[i - 1].when), e.map((x) => [x.tag, x.when]));
check('Número do arquivo = índice', e.every((x) => Number(x.tag.slice(0, 4)) === x.idx), e.map((x) => x.tag));
check('Todo arquivo do journal existe', e.every((x) => existsSync(join(DIR, `${x.tag}.sql`))));
check('Tags sem repetição', new Set(e.map((x) => x.tag.slice(0, 4))).size === e.length);

// Migrações publicadas (congeladas). Ao publicar uma migração nova, acrescente o sha256 dela aqui; nunca altere um existente.
// (fim de linha normalizado para \n: um checkout no Windows com CRLF não acusa mudança falsa)
const PUBLICADAS: Record<string, string> = {
  '0000_inicial': '39ce903b9d0af363c92bd8303b051a39c023db40f048242e6f64ef4fcc5c8da5',
  '0001_protecoes': '01ccd9d74c8464edb949a47e9c8bbbbc7c67105529a5b0062398f8c2d54bb8f2',
  '0002_r2': 'b9b463af358dba47ebc1d9779e591055830c87d9d5920c8f9e2bdd68bd21ef8f',
  '0003_r2_protecoes': '43317ef1a3bd32b2bcb976b9446e9547a7b21de5e38804a238da266814fcbffb',
  '0004_imutabilidade': 'c56ac584cc7ca76b63f9ea60225a41364818511eca0f5ecd38e242a2ed7bfb3c',
  '0005_multiempresa': 'cbf6662a5d8bf932164491ddf03bfd7dd116c0d0398dba83a64d8adbf26f3198',
  '0006_personalizacao': 'acb79f5ecb1c23ae859851ce239fd4cc8315ac99072897e71b8de7f6ad5664c8',
  '0007_desempenho': '3da8c4b147ff18bf70b1c25839519235b8cda6a8d83097ae67d210cc23def70b',
  '0008_oneup_taxas': '87e392b9179a5c7e5f12bb3316babcae58a1d075bfb42018e2f104e3d141e171',
  '0009_analise_crm': 'e26523fb0042dbd34a23487da6b5f170dac2d4495776e62e031d78bd27936a64',
  '0010_leva1': '86322449bafec3b92b8d31a93398b48efe7b6b4db31e981b65aa1c02bd6847bb',
  '0011_auditoria': '1afe24003290c5bcdab4add10658895c1d6c249ec5430fd61b199d8effc12e1c',
  '0012_happy_alpha': '90a08ef23bd2173d2df1683028a0ab846397ad2e93f6adba73722d8b398cfe9f',
  '0013_analise': 'b4436ce773b766b936ee9bf9787f32d54f6326d84f182108b31a6106773a832c',
  '0014_crm': '75de3f1e4a44d16c91e929729b42a8a7f34f0a3015b2cfb483a516105d9b5d01',
  '0015_plataforma': '903933fcb3c1442722483bacf7b366729eba875c86ff27f5931aa375213e8bcd',
};
const sha = (tag: string) => {
  const f = join(DIR, `${tag}.sql`);
  return existsSync(f) ? createHash('sha256').update(readFileSync(f, 'utf8').replace(/\r\n/g, '\n')).digest('hex') : null;
};
const alteradas = Object.entries(PUBLICADAS).filter(([tag, h]) => sha(tag) !== h).map(([tag]) => tag);
check(`Migrações publicadas intactas (${Object.keys(PUBLICADAS).length} congeladas; mudança nova = arquivo novo)`, alteradas.length === 0, alteradas);
check('Toda migração publicada continua no journal', Object.keys(PUBLICADAS).every((tag) => e.some((x) => x.tag === tag)));
if (process.env.DATABASE_URL) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const n = Number((await c.query('SELECT count(*) FROM drizzle.__drizzle_migrations')).rows[0].count);
  check(`Instalação nova aplicou todas as ${e.length} migrações`, n === e.length, n);
  const col = await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name='sessions' AND column_name='aparelho_id'`);
  check("Colunas das migrações presentes (sessions.aparelho_id)", col.rowCount === 1);
  await c.end();
}
console.log(`\nResultado migrações: ${ok} verificações OK, ${falhas.length} falhas.`);
if (falhas.length) process.exit(1);
