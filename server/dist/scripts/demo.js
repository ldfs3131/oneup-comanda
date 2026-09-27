import { sql, eq } from 'drizzle-orm';
import { db, ensureBaseData, nextNumber, pool, runMigrations } from '../db/index.js';
import { accounts, cashRegisters, categories, orders, paymentMethods, payments, products, roles, users, } from '../db/schema.js';
import { hashPassword } from '../auth.js';
import { config } from '../config.js';
import { audit } from '../lib/audit.js';
import { seedMenu } from '../seed/menu.js';
import { insertOrder, recomputeStatus } from '../services/accounts.js';
/**
 * Recria o banco de DEMONSTRAÇÃO com dados de teste claramente marcados [DEMO].
 * Só roda se DEMO_MODE=true e o banco tiver "demo" no nome — nunca toca a produção.
 */
async function main() {
    const dbName = new URL(config.databaseUrl).pathname.slice(1);
    if (!config.demoMode || !dbName.includes('demo')) {
        console.error('Recusado: este comando só roda no banco de demonstração (DEMO_MODE=true e banco com "demo" no nome).');
        process.exit(1);
    }
    console.log(`Recriando banco de demonstração "${dbName}"...`);
    await db.execute(sql `DROP SCHEMA IF EXISTS public CASCADE`);
    await db.execute(sql `DROP SCHEMA IF EXISTS drizzle CASCADE`);
    await db.execute(sql `CREATE SCHEMA public`);
    await runMigrations();
    await ensureBaseData();
    const roleRows = await db.select().from(roles);
    const rid = (c) => roleRows.find((r) => r.code === c).id;
    const pass = await hashPassword('1234');
    const [admin] = await db.insert(users).values({ name: 'Admin Demo', username: 'admin', passwordHash: pass, roleId: rid('ADMIN') }).returning();
    const [caixa] = await db.insert(users).values({ name: 'Caixa Demo', username: 'caixa', passwordHash: pass, roleId: rid('CAIXA') }).returning();
    const [coz] = await db.insert(users).values({ name: 'Cozinha Demo', username: 'cozinha', passwordHash: pass, roleId: rid('COZINHA') }).returning();
    await seedMenu();
    // Bebidas de TESTE — preços fictícios só para treino, marcados [DEMO]
    const [beb] = await db.select().from(categories).where(eq(categories.name, 'Bebidas'));
    await db.insert(products).values([
        { categoryId: beb.id, name: 'Chope [DEMO]', priceCents: 1000, sendsToKitchen: false, sortOrder: 1, description: 'Produto de teste — preço fictício' },
        { categoryId: beb.id, name: 'Refrigerante lata [DEMO]', priceCents: 600, sendsToKitchen: false, sortOrder: 2, description: 'Produto de teste — preço fictício' },
        { categoryId: beb.id, name: 'Água [DEMO]', priceCents: 400, sendsToKitchen: false, sortOrder: 3, description: 'Produto de teste — preço fictício' },
    ]);
    const [reg] = await db.insert(cashRegisters).values({ openedBy: caixa.id, openingCashCents: 20000 }).returning();
    const prods = await db.select().from(products);
    const P = (name) => prods.find((p) => p.name === name).id;
    const methods = await db.select().from(paymentMethods);
    const M = (code) => methods.find((m) => m.code === code).id;
    async function account(name, note, orderList) {
        const number = await nextNumber(db, 'account');
        const [acc] = await db.insert(accounts).values({ number, customerName: name, note, cashRegisterId: reg.id, openedBy: caixa.id }).returning();
        const created = [];
        for (const items of orderList) {
            created.push((await insertOrder(db, { accountId: acc.id, items, userId: caixa.id, origin: 'CAIXA', cashRegisterId: reg.id })).order);
        }
        await recomputeStatus(db, acc.id);
        return { acc, orders: created };
    }
    const setOrder = (id, s) => db.update(orders).set(s).where(eq(orders.id, id));
    const now = new Date();
    // 1) Pedido novo aguardando a cozinha
    await account('[DEMO] João', 'camisa azul, perto da piscina', [[{ productId: P('Batata Simples'), quantity: 1 }, { productId: P('Chope [DEMO]'), quantity: 2 }]]);
    // 2) Em preparo
    const a2 = await account('[DEMO] Maria', 'churrasqueira', [[{ productId: P('Carne de Sol com Mandioca'), quantity: 1 }]]);
    await setOrder(a2.orders[0].id, { status: 'IN_PREPARATION', startedAt: now, startedBy: coz.id });
    // 3) Pronto, aguardando retirada
    const a3 = await account(null, 'casa 123 — retirar no balcão', [[{ productId: P('Frango à Passarinho'), quantity: 1 }]]);
    await setOrder(a3.orders[0].id, { status: 'READY', startedAt: now, startedBy: coz.id, readyAt: now, readyBy: coz.id });
    // 4) Parcialmente paga (pedido entregue + complemento)
    const a4 = await account('[DEMO] Pedro', null, [
        [{ productId: P('Batata Cheddar e Bacon'), quantity: 1 }],
        [{ productId: P('Chope [DEMO]'), quantity: 3 }],
    ]);
    await setOrder(a4.orders[0].id, { status: 'DELIVERED', startedAt: now, readyAt: now, deliveredAt: now });
    await db.insert(payments).values({ accountId: a4.acc.id, methodId: M('PIX'), amountCents: 2000, cashRegisterId: reg.id, userId: caixa.id });
    await recomputeStatus(db, a4.acc.id);
    // 5) Pendente (cliente saiu sem pagar)
    const jantinha = prods.find((p) => p.name === 'Jantinha Completa');
    const optRows = (await db.execute(sql `SELECT o.id FROM options o JOIN option_groups g ON g.id = o.group_id WHERE g.product_id = ${jantinha.id} ORDER BY o.sort_order LIMIT 1`)).rows;
    const a5 = await account('[DEMO] Ana', 'casa 45', [[{ productId: jantinha.id, quantity: 1, optionIds: [optRows[0].id] }]]);
    await setOrder(a5.orders[0].id, { status: 'DELIVERED', startedAt: now, readyAt: now, deliveredAt: now });
    await db.update(accounts).set({ status: 'PENDING', contact: 'casa 45 — (61) 90000-0000', pendingAt: now, pendingBy: caixa.id }).where(eq(accounts.id, a5.acc.id));
    // 6) Paga e encerrada (PIX + cartão)
    const a6 = await account('[DEMO] Carla', null, [[{ productId: P('Filé Mignon à Parmegiana'), quantity: 1 }, { productId: P('Refrigerante lata [DEMO]'), quantity: 1 }]]);
    await setOrder(a6.orders[0].id, { status: 'DELIVERED', startedAt: now, readyAt: now, deliveredAt: now });
    await db.insert(payments).values([
        { accountId: a6.acc.id, methodId: M('PIX'), amountCents: 3000, cashRegisterId: reg.id, userId: caixa.id },
        { accountId: a6.acc.id, methodId: M('CARTAO'), amountCents: 1899, cashRegisterId: reg.id, userId: caixa.id },
    ]);
    await db.update(accounts).set({ status: 'CLOSED', closedAt: now, closedBy: caixa.id }).where(eq(accounts.id, a6.acc.id));
    await audit(db, { userId: admin.id, action: 'demo.seed', message: 'Banco de demonstração recriado com dados de teste [DEMO].' });
    console.log('\n✔ Demonstração pronta. Logins: admin / caixa / cozinha — senha 1234 para todos.\n');
    await pool.end();
}
main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
