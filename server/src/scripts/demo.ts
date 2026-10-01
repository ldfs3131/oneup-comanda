import { sql, eq, and } from 'drizzle-orm';
import { closePools, db, ensureBaseData, nextNumber, runAsEmpresa, runAsSystem, runMigrations } from '../db/index.js';
import {
  accounts, cashRegisters, orderItems, orders, paymentMethods, payments, products, roles, stockMovements, users,
  optionGroups, options, discounts, restaurantSettings, statusEvents,
} from '../db/schema.js';
import { hashPassword } from '../auth.js';
import { config } from '../config.js';
import { audit } from '../lib/audit.js';
import { seedMenu } from '../seed/menu.js';
import { insertOrder, recomputeStatus } from '../services/accounts.js';

/**
 * Recria o banco de DEMONSTRAÇÃO com dados de teste claramente marcados [DEMO].
 * Gera 6 semanas de histórico sintético (para treinar e ver os Insights) + um dia em andamento.
 * Só roda se DEMO_MODE=true e o banco tiver "demo" no nome — nunca toca a produção.
 */
let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];

async function main() {
  const dbName = new URL(config.databaseUrl).pathname.slice(1);
  if (!config.demoMode || !dbName.includes('demo')) {
    console.error('Recusado: este comando só roda no banco de demonstração (DEMO_MODE=true e banco com "demo" no nome).');
    process.exit(1);
  }
  console.log(`Recriando banco de demonstração "${dbName}"...`);
  await runAsSystem(async () => {
    await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
    await db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
    await db.execute(sql`CREATE SCHEMA public`);
  });
  await runMigrations();
  // empresa fictícia de demonstração (acesso: DEFAULT_EMPRESA=demo ou demo.<domínio>)
  await runAsSystem(() => db.execute(sql`UPDATE empresas SET slug = 'demo', nome = '[DEMO] Restaurante Exemplo', status = 'TESTE' WHERE id = 1`));
  await ensureBaseData();

  const roleRows = await db.select().from(roles);
  const rid = (c: string) => roleRows.find((r) => r.code === c)!.id;
  const pass = await hashPassword('1234');
  const [admin] = await db.insert(users).values({ name: 'Admin Demo', username: 'admin', passwordHash: pass, roleId: rid('ADMIN') }).returning();
  const [caixa] = await db.insert(users).values({ name: 'Caixa Demo', username: 'caixa', passwordHash: pass, roleId: rid('CAIXA') }).returning();
  const [coz] = await db.insert(users).values({ name: 'Cozinha Demo', username: 'cozinha', passwordHash: pass, roleId: rid('COZINHA') }).returning();
  await db.update(restaurantSettings).set({ tagline: 'Demonstração ONE UP Comanda' }).where(eq(restaurantSettings.id, 1));

  await seedMenu();
  // Demo: alguns sabores de Monster ativos e custos de exemplo [DEMO] para o Financeiro ter o que mostrar
  await db.execute(sql`UPDATE products SET active = true WHERE name IN ('Monster Energy Green','Monster Mango Loco','Monster Ultra')`);
  await db.execute(sql`UPDATE products SET cost_cents = round(price_cents * 0.38) WHERE category_id IN (SELECT id FROM categories WHERE name IN ('Petiscos','Espetos','Pratos','Hambúrguer'))`);
  await db.execute(sql`UPDATE products SET cost_cents = round(price_cents * 0.45) WHERE category_id IN (SELECT id FROM categories WHERE name IN ('Bebidas','Cervejas','Chope','Drinks'))`);
  // estoque inicial de demonstração
  const tracked = await db.select().from(products).where(eq(products.trackStock, true));
  for (const p of tracked) {
    const qty = p.name.includes('Heineken') ? 60 : p.name.includes('Coca') ? 48 : 24;
    await db.insert(stockMovements).values({ productId: p.id, type: 'AJUSTE', quantity: qty, before: 0, after: qty, reason: '[DEMO] Contagem inicial', userId: admin.id });
    await db.update(products).set({ stockQty: qty }).where(eq(products.id, p.id));
  }

  const prods = (await db.select().from(products)).filter((p) => p.active);
  const P = (name: string) => prods.find((p) => p.name === name)!;
  const groups = await db.select().from(optionGroups);
  const opts = await db.select().from(options);
  const reqOptions = (pid: number) => groups.filter((g) => g.productId === pid && g.required).map((g) => opts.find((o) => o.groupId === g.id)!.id);
  const methods = await db.select().from(paymentMethods);
  const M = (code: string) => methods.find((m) => m.code === code)!.id;

  // ---------- Histórico sintético: 42 dias ----------
  const food = ['Batata Simples', 'Batata Cheddar e Bacon', 'Frango à Passarinho', 'Calabresa Acebolada', 'Jantinha Completa', 'Espeto de Frango',
    'Espeto de Contra-filé', 'Espeto de Coração', 'Hambúrguer', 'Filé com Fritas', 'Carne de Sol com Mandioca', 'Strogonoff de Frango', 'Filé de Frango à Parmegiana'];
  const drinks = ['Chope 300 ml', 'Chope 500 ml', 'Heineken', 'Coca-Cola lata', 'Guaraná Antarctica lata', 'Água sem gás', 'Caipirinha', 'Chope IPA 500 ml', 'Corona'];
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const dayMs = 86400_000;
  let histCount = 0;
  for (let back = 42; back >= 1; back--) {
    const d = new Date(new Date(today + 'T12:00:00-03:00').getTime() - back * dayMs);
    const wd = d.getUTCDay();
    if (wd === 1) continue; // segunda: fechado
    const weekend = wd === 5 || wd === 6;
    const trend = 1 + (42 - back) * 0.006; // leve crescimento
    const nAcc = Math.round((weekend ? 34 : wd === 0 ? 26 : 16) * trend * (0.85 + rnd() * 0.3));
    const dayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
    const openAt = new Date(`${dayStr}T17:00:00-03:00`);
    const [reg] = await db.insert(cashRegisters).values({ openedBy: caixa.id, openingCashCents: 20000, openedAt: openAt, status: 'CLOSED', closedAt: new Date(`${dayStr}T23:40:00-03:00`), closedBy: caixa.id }).returning();
    await db.insert(statusEvents).values([{ isOpen: true, userId: caixa.id, createdAt: openAt }, { isOpen: false, userId: caixa.id, createdAt: new Date(`${dayStr}T23:40:00-03:00`) }]);
    for (let a = 0; a < nAcc; a++) {
      // pico entre 19h e 21h30
      const minute = rnd() < 0.62 ? 19 * 60 + Math.floor(rnd() * 150) : 17 * 60 + 30 + Math.floor(rnd() * 330);
      const t = new Date(`${dayStr}T00:00:00-03:00`).getTime() + minute * 60_000;
      const number = await nextNumber(db, 'account');
      const [acc] = await db.insert(accounts).values({ number, customerName: `[DEMO] Cliente ${number}`, cashRegisterId: reg.id, openedBy: caixa.id, openedAt: new Date(t), status: 'CLOSED', closedAt: new Date(t + 90 * 60_000), closedBy: caixa.id }).returning();
      const nOrders = rnd() < 0.35 ? 2 : 1;
      let total = 0;
      for (let k = 0; k < nOrders; k++) {
        const ot = new Date(t + k * 35 * 60_000);
        const lines: { p: typeof prods[number]; q: number }[] = [];
        if (k === 0 || rnd() < 0.5) lines.push({ p: P(pick(food.slice(0, back < 21 ? food.length : food.length - 1))), q: rnd() < 0.2 ? 2 : 1 });
        lines.push({ p: P(pick(drinks)), q: 1 + Math.floor(rnd() * 3) });
        const kitchen = lines.some((l) => l.p.sendsToKitchen);
        const kmin = 11 + Math.floor(rnd() * 9) + (weekend ? 3 : 0);
        const num = await nextNumber(db, 'order');
        const [o] = await db.insert(orders).values({
          number: num, accountId: acc.id, sequence: k + 1, origin: 'CAIXA', status: 'DELIVERED', goesToKitchen: kitchen,
          consumptionType: rnd() < 0.15 ? 'VIAGEM' : 'LOCAL', expectedMinutes: kitchen ? 15 : null, cashRegisterId: reg.id, createdBy: caixa.id,
          createdAt: ot, confirmedAt: ot, confirmedBy: caixa.id,
          startedAt: kitchen ? new Date(ot.getTime() + 3 * 60_000) : null, startedBy: kitchen ? coz.id : null,
          readyAt: kitchen ? new Date(ot.getTime() + kmin * 60_000) : null, readyBy: kitchen ? coz.id : null,
          deliveredAt: new Date(ot.getTime() + (kitchen ? kmin + 2 : 1) * 60_000), deliveredBy: caixa.id,
        }).returning();
        for (const l of lines) {
          const oid = reqOptions(l.p.id);
          const snap = oid.map((id) => { const op = opts.find((x) => x.id === id)!; return { group: groups.find((g) => g.id === op.groupId)!.name, name: op.name, priceDeltaCents: op.priceDeltaCents, stockProductId: op.stockProductId }; });
          await db.insert(orderItems).values({ orderId: o.id, productId: l.p.id, productName: l.p.name, unitPriceCents: l.p.priceCents, quantity: l.q, optionsSnapshot: snap, goesToKitchen: l.p.sendsToKitchen, unitCostCents: l.p.costCents });
          total += l.p.priceCents * l.q;
        }
      }
      const method = rnd() < 0.55 ? 'PIX' : rnd() < 0.7 ? 'CARTAO' : 'DINHEIRO';
      await db.insert(payments).values({ accountId: acc.id, methodId: M(method), amountCents: total, cashRegisterId: reg.id, userId: caixa.id, createdAt: new Date(t + 85 * 60_000) });
      histCount++;
    }
  }

  // ---------- Dia em andamento (hoje) ----------
  const [reg] = await db.insert(cashRegisters).values({ openedBy: caixa.id, openingCashCents: 20000 }).returning();
  await db.update(restaurantSettings).set({ isOpen: true }).where(eq(restaurantSettings.id, 1));
  await db.insert(statusEvents).values({ isOpen: true, userId: caixa.id });

  async function account(name: string | null, note: string | null, orderList: { productId: number; quantity: number; optionIds?: number[] }[][], extra: Partial<typeof accounts.$inferInsert> = {}) {
    const number = await nextNumber(db, 'account');
    const [acc] = await db.insert(accounts).values({ number, customerName: name, note, cashRegisterId: reg.id, openedBy: caixa.id, ...extra }).returning();
    const created = [];
    for (const items of orderList) {
      created.push((await insertOrder(db, { accountId: acc.id, items, userId: caixa.id, origin: 'CAIXA', cashRegisterId: reg.id })).order);
    }
    await recomputeStatus(db, acc.id);
    return { acc, orders: created };
  }
  const setOrder = (id: number, s: Partial<typeof orders.$inferInsert>) => db.update(orders).set(s).where(eq(orders.id, id));
  const now = new Date();
  const jantinha = P('Jantinha Completa');
  const caip = P('Caipirinha');

  await account('[DEMO] João', 'camisa azul, perto da piscina', [[{ productId: P('Batata Simples').id, quantity: 1 }, { productId: P('Chope 300 ml').id, quantity: 2 }]]);
  const a2 = await account('[DEMO] Maria', 'churrasqueira', [[{ productId: P('Carne de Sol com Mandioca').id, quantity: 1 }, { productId: caip.id, quantity: 1, optionIds: reqOptions(caip.id) }]], { tableLabel: '4' });
  await setOrder(a2.orders[0].id, { status: 'IN_PREPARATION', startedAt: now, startedBy: coz.id });
  const a3 = await account(null, 'casa 123 — retirar no balcão', [[{ productId: P('Frango à Passarinho').id, quantity: 1 }]]);
  await setOrder(a3.orders[0].id, { status: 'READY', startedAt: now, startedBy: coz.id, readyAt: now, readyBy: coz.id, consumptionType: 'VIAGEM' });
  const a4 = await account('[DEMO] Pedro', null, [
    [{ productId: P('Hambúrguer').id, quantity: 2 }],
    [{ productId: P('Heineken').id, quantity: 3 }],
  ]);
  await setOrder(a4.orders[0].id, { status: 'DELIVERED', startedAt: now, readyAt: now, deliveredAt: now });
  await db.insert(payments).values({ accountId: a4.acc.id, methodId: M('PIX'), amountCents: 5000, cashRegisterId: reg.id, userId: caixa.id });
  await recomputeStatus(db, a4.acc.id);
  const a5 = await account('[DEMO] Ana', 'casa 45', [[{ productId: jantinha.id, quantity: 1, optionIds: reqOptions(jantinha.id) }]], { contact: 'casa 45 — (61) 90000-0000' });
  await setOrder(a5.orders[0].id, { status: 'DELIVERED', startedAt: now, readyAt: now, deliveredAt: now });
  await db.update(accounts).set({ status: 'PENDING', pendingAt: new Date(Date.now() - 9 * dayMs), pendingBy: caixa.id }).where(eq(accounts.id, a5.acc.id));
  const a6 = await account('[DEMO] Carla', null, [[{ productId: P('Filé Mignon à Parmegiana').id, quantity: 1 }, { productId: P('Coca-Cola lata').id, quantity: 1 }]]);
  await setOrder(a6.orders[0].id, { status: 'DELIVERED', startedAt: now, readyAt: now, deliveredAt: now });
  await db.insert(payments).values([
    { accountId: a6.acc.id, methodId: M('PIX'), amountCents: 3000, cashRegisterId: reg.id, userId: caixa.id },
    { accountId: a6.acc.id, methodId: M('CARTAO'), amountCents: 1899, cashRegisterId: reg.id, userId: caixa.id },
  ]);
  await db.update(accounts).set({ status: 'CLOSED', closedAt: now, closedBy: caixa.id }).where(eq(accounts.id, a6.acc.id));
  await db.insert(discounts).values({ accountId: a4.acc.id, kind: 'ADJUSTMENT', amountCents: 500, reason: '[DEMO] Cortesia para morador', userId: caixa.id, cashRegisterId: reg.id });
  await recomputeStatus(db, a4.acc.id);
  void and;

  await audit(db, { userId: admin.id, action: 'demo.seed', message: `Banco de demonstração recriado: ${histCount} contas de histórico [DEMO] + dia em andamento.` });
  console.log(`\n✔ Demonstração pronta (${histCount} contas de histórico). Logins: admin / caixa / cozinha — senha 1234.\n`);
}

// os dados são gerados dentro da empresa nº 1 (RLS ligado, como na aplicação)
runAsEmpresa(1, main).then(closePools).catch(async (e) => { console.error(e); await closePools(); process.exit(1); });
