import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { eq } from 'drizzle-orm';
import { closePools, db, ensureEmpresaBase, ensurePlatformData, runAsEmpresa, runMigrations, waitForDatabase } from '../db/index.js';
import { restaurantSettings, roles, users } from '../db/schema.js';
import { hashPassword } from '../auth.js';
import { audit } from '../lib/audit.js';
import { obterOuCriarEmpresa, semearCardapioInicial } from '../services/plataforma.js';
import { config } from '../config.js';
import { slugValido } from '../lib/empresa.js';
/**
 * Configura UMA empresa (cria se não existir) — pode rodar de novo sem duplicar nada.
 *   node dist/scripts/setup.js --empresa=<slug> --nome="Nome do restaurante"
 *     --admin-name=... --admin-pass=... --caixa-pass=... --cozinha-pass=...
 *     [--cardapio=exemplo|vazio|piloto]  (padrão: exemplo na empresa nº 1 / instalação única; vazio nas demais)
 *     exemplo = cardápio genérico de restaurante fictício · piloto = cardápio do restaurante piloto (só testes/demonstração)
 * Sem as senhas na linha de comando, pergunta no terminal.
 */
async function main() {
    const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=')]; }));
    const slug = (args.empresa || config.defaultEmpresa || 'empresa-1').toLowerCase();
    if (!slugValido(slug))
        throw new Error(`Endereço da empresa inválido: "${slug}" (use letras minúsculas, números e hífen).`);
    await waitForDatabase(5);
    await runMigrations();
    await ensurePlatformData();
    // 1) Empresa (plataforma)
    const emp = await obterOuCriarEmpresa(slug, args.nome || undefined);
    console.log(`\n=== ${config.productName} — empresa "${emp.slug}" (nº ${emp.id}) ===\n`);
    // 2) Dados da empresa (RLS ligado: tudo cai nesta empresa)
    await runAsEmpresa(emp.id, async () => {
        await ensureEmpresaBase();
        if (args.nome)
            await db.update(restaurantSettings).set({ name: args.nome }).where(eq(restaurantSettings.id, emp.id));
        // Sem terminal (servidor, Coolify, scripts): nunca espera teclado. Nome usa o padrão; senha faltando é erro.
        const interativo = !!stdin.isTTY;
        const rl = interativo ? createInterface({ input: stdin, output: stdout }) : null;
        const ask = async (q, def) => (rl ? ((await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim() || def || '') : def || '');
        const askPass = async (q) => {
            if (!rl)
                throw new Error(`Falta a senha (${q.trim()}). Sem terminal, informe --admin-pass, --caixa-pass e --cozinha-pass.`);
            for (;;) {
                const p = await ask(q);
                if (p.length >= 4)
                    return p;
                console.log('  A senha precisa ter pelo menos 4 caracteres.');
            }
        };
        const roleRows = await db.select().from(roles);
        const roleId = (c) => roleRows.find((r) => r.code === c).id;
        const initial = [
            { code: 'ADMIN', label: 'Administrador', user: args['admin-user'] || 'admin', name: args['admin-name'], pass: args['admin-pass'] },
            { code: 'CAIXA', label: 'Caixa', user: args['caixa-user'] || 'caixa', name: 'Caixa', pass: args['caixa-pass'] },
            { code: 'COZINHA', label: 'Cozinha', user: args['cozinha-user'] || 'cozinha', name: 'Cozinha', pass: args['cozinha-pass'] },
        ];
        for (const u of initial) {
            const exists = await db.select().from(users).where(eq(users.username, u.user));
            if (exists.length) {
                console.log(`- Usuário "${u.user}" já existe, mantido.`);
                continue;
            }
            console.log(`\n${u.label}:`);
            const name = u.name || (u.code === 'ADMIN' ? await ask('  Nome do administrador', 'Administrador') : u.label);
            const pass = u.pass || await askPass(`  Senha para o login "${u.user}" (mín. 4 caracteres)`);
            const [created] = await db.insert(users).values({ name, username: u.user, passwordHash: await hashPassword(pass), roleId: roleId(u.code) }).returning();
            await audit(db, { action: 'setup.user', entityType: 'user', entityId: created.id, message: `Instalação criou o usuário ${name} (${u.code}).` });
            console.log(`  ✔ Criado: login "${u.user}"`);
        }
        rl?.close();
        const cardapio = args.cardapio || (emp.id === 1 ? 'exemplo' : 'vazio');
        if (!['exemplo', 'vazio', 'piloto'].includes(cardapio))
            throw new Error('--cardapio deve ser exemplo, vazio ou piloto.');
        if (cardapio !== 'vazio') {
            const seeded = await semearCardapioInicial(cardapio);
            const qual = cardapio === 'exemplo' ? 'de exemplo (genérico)' : 'do restaurante piloto (testes)';
            console.log(seeded ? `\n✔ Cardápio ${qual} cadastrado (${seeded} produto(s)).` : '\n- Cardápio já estava completo, mantido.');
        }
        else {
            console.log('\n- Cardápio em branco: cadastre em Cardápio ou importe por planilha.');
        }
    });
    const host = config.baseDomain ? `https://${emp.slug}.${config.baseDomain}` : `http://localhost:${config.port}`;
    console.log(`\nPronto. Acesse ${host}\n`);
}
main().then(closePools).catch(async (e) => { console.error('Erro na configuração:', e.message ?? e); await closePools(); process.exit(1); });
