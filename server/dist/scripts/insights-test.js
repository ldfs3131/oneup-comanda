/**
 * Testes de cenário do ONE UP Insights (T25/T27).
 * Roda num banco separado (nome precisa conter "insights"), recria o banco a cada cenário
 * e chama computeInsights com dados sintéticos controlados.
 *   DATABASE_URL=postgres://.../happy_alpha_insights node dist/scripts/insights-test.js
 */
import { eq, sql } from 'drizzle-orm';
import { db, ensureBaseData, nextNumber, pool, runMigrations } from '../db/index.js';
import { accounts, cashRegisters, excludedDays, orderItems, orders, paymentMethods, payments, products, roles, users } from '../db/schema.js';
import { config } from '../config.js';
import { seedMenu } from '../seed/menu.js';
import { computeInsights } from '../services/insights.js';
let ok = 0;
const fails = [];
function check(name, cond, extra) {
    if (cond) {
        ok++;
        console.log(`  ✔ ${name}`);
    }
    else {
        fails.push(name);
        console.log(`  ✘ ${name}`, extra ?? '');
    }
}
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const TZ = 'America/Sao_Paulo';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const NOW = { day: today, minute: 23 * 60 + 50 };
async function reset() {
    await db.execute(sql `DROP SCHEMA IF EXISTS public CASCADE`);
    await db.execute(sql `DROP SCHEMA IF EXISTS drizzle CASCADE`);
    await db.execute(sql `CREATE SCHEMA public`);
    await runMigrations();
    await ensureBaseData();
    await seedMenu();
}
/** Gera `days` dias completos de histórico terminando ontem. plan(back) define o volume do dia (back = 1 é ontem). */
async function generate(days, plan) {
    const roleRows = await db.select().from(roles);
    const [u] = await db.insert(users).values({ name: 'Teste', username: `t${Date.now()}`, passwordHash: 'x', roleId: roleRows.find((r) => r.code === 'CAIXA').id }).returning();
    const prods = await db.select().from(products);
    const P = (n) => prods.find((p) => p.name === n);
    const [pix] = await db.select().from(paymentMethods).where(eq(paymentMethods.code, 'PIX'));
    const base = [P('Batata Simples'), P('Hambúrguer'), P('Filé com Fritas')];
    const drink = [P('Chope 300 ml'), P('Coca-Cola lata')];
    for (let back = days; back >= 1; back--) {
        const pl = plan(back);
        if (!pl)
            continue;
        const day = addDays(today, -back);
        const [reg] = await db.insert(cashRegisters).values({ openedBy: u.id, openingCashCents: 0, openedAt: new Date(`${day}T17:00:00-03:00`), status: 'CLOSED', closedAt: new Date(`${day}T23:30:00-03:00`), closedBy: u.id }).returning();
        const lines = [];
        for (let a = 0; a < pl.accounts; a++)
            lines.push([{ p: base[a % 3], q: 1 }, { p: drink[a % 2], q: 1 }]);
        for (const e of pl.extra ?? [])
            if (e.qty > 0)
                lines.push([{ p: P(e.name), q: e.qty }]);
        for (let a = 0; a < lines.length; a++) {
            const t = new Date(`${day}T18:00:00-03:00`).getTime() + Math.floor((a / lines.length) * 300) * 60_000;
            const [acc] = await db.insert(accounts).values({ number: await nextNumber(db, 'account'), cashRegisterId: reg.id, openedBy: u.id, openedAt: new Date(t), status: 'CLOSED', closedAt: new Date(t + 3600_000), closedBy: u.id }).returning();
            const kitchen = lines[a].some((l) => l.p.sendsToKitchen);
            const [o] = await db.insert(orders).values({
                number: await nextNumber(db, 'order'), accountId: acc.id, sequence: 1, origin: 'CAIXA', status: 'DELIVERED', goesToKitchen: kitchen,
                expectedMinutes: kitchen ? 15 : null, cashRegisterId: reg.id, createdBy: u.id, createdAt: new Date(t), confirmedAt: new Date(t),
                readyAt: kitchen ? new Date(t + (12 + Math.floor(rnd() * 5)) * 60_000) : null, deliveredAt: new Date(t + 20 * 60_000),
            }).returning();
            let total = 0;
            for (const l of lines[a]) {
                await db.insert(orderItems).values({ orderId: o.id, productId: l.p.id, productName: l.p.name, unitPriceCents: l.p.priceCents, quantity: l.q, optionsSnapshot: [], goesToKitchen: l.p.sendsToKitchen });
                total += l.p.priceCents * l.q;
            }
            await db.insert(payments).values({ accountId: acc.id, methodId: pix.id, amountCents: total, cashRegisterId: reg.id, userId: u.id, createdAt: new Date(t + 3000_000) });
        }
    }
}
const noise = (n) => Math.max(1, Math.round(n * (0.95 + rnd() * 0.1)));
const run = (log = false) => computeInsights(db, { now: NOW, log });
const keys = (r) => r.all.map((i) => i.key);
const CAUSAL = /\b(porque|devido a|por causa|graças)\b/i;
function sanity(label, r) {
    check(`${label}: no máximo 5 no topo, confiança só ALTA/MÉDIA`, r.top.length <= 5 && r.all.every((i) => i.confidence === 'ALTA' || i.confidence === 'MEDIA'));
    check(`${label}: números consistentes (diferença = atual − referência)`, r.all.every((i) => i.metric.diffAbs == null || i.metric.reference == null || Math.abs(i.metric.current - i.metric.reference - i.metric.diffAbs) <= 1 || i.metric.unit === 'PCT'), r.all.map((i) => [i.key, i.metric]));
    check(`${label}: nenhum texto afirma causa nem fala em "lucro líquido"`, r.all.every((i) => !CAUSAL.test(i.text) && !/lucro líquido/i.test(i.text)));
    check(`${label}: comparações sempre dizem com o quê comparam`, r.all.every((i) => i.kind !== 'INSIGHT' || i.key.startsWith('day.highlight') || !!i.comparison));
    check(`${label}: ranking por score`, r.all.every((i, k) => k === 0 || r.all[k - 1].score >= i.score));
}
async function main() {
    const dbName = new URL(config.databaseUrl).pathname.slice(1);
    if (!dbName.includes('insights')) {
        console.error('Recusado: use um banco com "insights" no nome.');
        process.exit(1);
    }
    console.log('\n[Insights] Sem dados');
    await reset();
    let r = await run();
    check('Zero dados: nível 1 e mensagem "Assim que houver dados suficientes..."', r.level === 1 && r.dataDays === 0 && /Assim que houver dados suficientes/.test(r.message) && r.top.length === 0, r);
    console.log('\n[Insights] 4 dias');
    await reset();
    await generate(4, () => ({ accounts: noise(20) }));
    r = await run();
    check('4 dias: nível 1, só informações do dia (nenhuma comparação)', r.level === 1 && r.dataDays === 4 && r.all.every((i) => ['DADO', 'ESTIMATIVA'].includes(i.kind)), keys(r));
    sanity('4 dias', r);
    console.log('\n[Insights] 7 dias');
    await reset();
    await generate(7, () => ({ accounts: noise(20) }));
    r = await run();
    check('7 dias: nível 2 (comparações simples)', r.level === 2 && r.dataDays === 7, r.level);
    check('7 dias: sem tendência de produto nem dia da semana (exige 28+)', !r.all.some((i) => i.key.startsWith('period.product') || i.key.startsWith('period.weekday') || i.key === 'period.anomaly'), keys(r));
    console.log('\n[Insights] 28 dias estáveis (só oscilação normal)');
    await reset();
    await generate(28, () => ({ accounts: noise(25) }));
    r = await run();
    check('28 dias: nível 3', r.level === 3 && r.dataDays === 28);
    check('Oscilação normal não vira insight de alta/queda/anomalia', !r.all.some((i) => ['period.sales7', 'period.anomaly'].includes(i.key) || i.key.startsWith('period.product')), keys(r));
    sanity('28 dias estáveis', r);
    console.log('\n[Insights] 56 dias');
    await reset();
    await generate(56, () => ({ accounts: noise(22) }));
    r = await run();
    check('56 dias: nível 4 (histórico robusto)', r.level === 4 && r.dataDays === 56, r.level);
    console.log('\n[Insights] Crescimento na última semana');
    await reset();
    await generate(28, (b) => ({ accounts: noise(b <= 7 ? 35 : 25) }));
    r = await run();
    const up = r.all.find((i) => i.key === 'period.sales7');
    check('Crescimento: "Faturamento da semana em alta" com % e base explícita', !!up && up.metric.diffPct > 0.3 && /acima dos 7 dias anteriores/.test(up.text) && !!up.comparison, up ?? keys(r));
    check('Crescimento: detalhe "Por quê?" com método, amostra e série', !!up && !!up.detail.method && !!up.detail.samples && (up.detail.series?.length ?? 0) === 13);
    sanity('Crescimento', r);
    console.log('\n[Insights] Não repetir o mesmo insight');
    await run(true);
    await db.execute(sql `UPDATE insight_log SET created_at = now() - interval '1 day'`);
    r = await run();
    const rep = r.all.find((i) => i.key === 'period.sales7');
    check('Mesmo insight de ontem volta marcado como repetido e com prioridade menor', !!rep && rep.repeated === true && rep.score < up.score, rep);
    check('Novos aparecem antes dos repetidos no topo', r.top.findIndex((i) => i.repeated) === -1 || r.top.slice(r.top.findIndex((i) => i.repeated)).every((i) => i.repeated));
    console.log('\n[Insights] Produto em queda consistente');
    await reset();
    await generate(35, (b) => ({ accounts: noise(25), extra: [{ name: 'Espeto de Frango', qty: b <= 21 ? 1 : 4 }] }));
    r = await run();
    const down = r.all.find((i) => i.key === 'period.product:Espeto de Frango');
    check('Queda: "Espeto de Frango em queda" com unidades/semana atual × anterior', !!down && down.metric.diffPct < -0.5 && /em queda/.test(down.title) && /não indicam o motivo/.test(down.text), down ?? keys(r));
    console.log('\n[Insights] Variação pequena em volume baixo');
    await reset();
    await generate(35, (b) => ({ accounts: noise(25), extra: [{ name: 'Corona', qty: b <= 21 ? (b % 3 === 0 ? 1 : 0) : (b % 7 === 0 ? 1 : 0) }] }));
    r = await run();
    check('Volume baixo (1 → 2 un./semana) NÃO vira "tendência"', !r.all.some((i) => i.key === 'period.product:Corona'), keys(r));
    console.log('\n[Insights] Anomalia de ontem e dia atípico');
    await reset();
    await generate(35, (b) => ({ accounts: b === 1 ? 90 : noise(25) }));
    r = await run();
    const an = r.all.find((i) => i.key === 'period.anomaly');
    check('Ontem 3,6× o normal: "Ontem fora do padrão" comparando com o mesmo dia da semana', !!an && /acima/.test(an.title) && /mesmo dia da semana/.test(an.detail.method), an ?? keys(r));
    await db.insert(excludedDays).values({ day: addDays(today, -1), reason: 'Evento fechado (teste)' });
    r = await run();
    check('Dia marcado como atípico sai das médias e não gera anomalia', !r.all.some((i) => i.key === 'period.anomaly'), keys(r));
    console.log(`\nResultado insights: ${ok} verificações OK, ${fails.length} falhas.`);
    if (fails.length) {
        console.log('Falhas:\n - ' + fails.join('\n - '));
    }
    await pool.end();
    process.exit(fails.length ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
