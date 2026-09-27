import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { eq } from 'drizzle-orm';
import { db, ensureBaseData, pool, runMigrations, waitForDatabase } from '../db/index.js';
import { roles, users } from '../db/schema.js';
import { hashPassword } from '../auth.js';
import { audit } from '../lib/audit.js';
import { seedMenu } from '../seed/menu.js';

/**
 * Configuração inicial da produção (roda uma vez na instalação):
 *  - aplica as migrações do banco
 *  - cria os usuários iniciais (admin, caixa, cozinha)
 *  - cadastra o cardápio oficial
 * Pode ser executado de novo sem duplicar nada.
 */
async function main() {
  await waitForDatabase(5);
  await runMigrations();
  await ensureBaseData();

  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
  const rl = createInterface({ input: stdin, output: stdout });
  const ask = async (q: string, def?: string) => {
    const a = (await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim();
    return a || def || '';
  };
  const askPass = async (q: string) => {
    for (;;) {
      const p = await ask(q);
      if (p.length >= 4) return p;
      console.log('  A senha precisa ter pelo menos 4 caracteres.');
    }
  };

  console.log('\n=== HAPPY ALPHA — configuração inicial ===\n');
  const roleRows = await db.select().from(roles);
  const roleId = (c: string) => roleRows.find((r) => r.code === c)!.id;

  const initial = [
    { code: 'ADMIN', label: 'Administrador', user: args['admin-user'] ?? 'admin', name: args['admin-name'], pass: args['admin-pass'] },
    { code: 'CAIXA', label: 'Caixa', user: args['caixa-user'] ?? 'caixa', name: 'Caixa', pass: args['caixa-pass'] },
    { code: 'COZINHA', label: 'Cozinha', user: args['cozinha-user'] ?? 'cozinha', name: 'Cozinha', pass: args['cozinha-pass'] },
  ];

  for (const u of initial) {
    const exists = await db.select().from(users).where(eq(users.username, u.user));
    if (exists.length) { console.log(`- Usuário "${u.user}" já existe, mantido.`); continue; }
    console.log(`\n${u.label}:`);
    const name = u.name ?? (u.code === 'ADMIN' ? await ask('  Nome do administrador', 'Administrador') : u.label);
    const pass = u.pass ?? await askPass(`  Senha para o login "${u.user}" (mín. 4 caracteres)`);
    const [created] = await db.insert(users).values({ name, username: u.user, passwordHash: await hashPassword(pass), roleId: roleId(u.code) }).returning();
    await audit(db, { action: 'setup.user', entityType: 'user', entityId: created.id, message: `Instalação criou o usuário ${name} (${u.code}).` });
    console.log(`  ✔ Criado: login "${u.user}"`);
  }
  rl.close();

  const seeded = await seedMenu();
  console.log(seeded ? `\n✔ Cardápio oficial cadastrado/atualizado (${seeded} produto(s)). Monster: ative no painel os sabores que vocês têm.` : '\n- Cardápio já estava completo, mantido.');
  console.log('  Lembrete: faça a contagem inicial do estoque em Caixa > Estoque antes de abrir.');
  console.log('\nPronto. Inicie o sistema e acesse http://localhost:3010\n');
  await pool.end();
}

main().catch(async (e) => { console.error('Erro na configuração:', e); await pool.end(); process.exit(1); });
