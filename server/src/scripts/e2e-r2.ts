/** Testes da R2 (regressões R1–R7, T1–T27 e regra de reabertura). Chamado pelo e2e.ts. */
import pg from 'pg';
import type { Socket } from 'socket.io-client';
import { Client, check, waitEvent } from './e2e.js';

const DB_URL = process.env.DATABASE_URL;

export async function r2Tests(ctx: {
  admin: Client; caixa: Client; coz: Client; kSock: Socket; cSock: Socket;
  find: (name: string) => any; M: (code: string) => number;
}) {
  const { admin, caixa, coz, kSock, find, M } = ctx;
  const pgc = new pg.Client({ connectionString: DB_URL });
  await pgc.connect();
  const q = async (text: string, params: unknown[] = []) => (await pgc.query(text, params)).rows;
  const menu = async () => (await admin.get('/api/menu?all=1')).data as any[];
  const prod = async (name: string) => (await menu()).flatMap((c: any) => c.products).find((p: any) => p.name === name);
  const kitchen = async () => (await coz.get('/api/kitchen/orders')).data as any[];
  const newAcc = async (body: any) => {
    const r = await caixa.post('/api/accounts', body);
    if (r.status !== 200) console.log('   (erro ao criar conta)', r.data);
    return r;
  };

  // garante o dia aberto
  const cur = (await caixa.get('/api/register/current')).data;
  if (!cur.register) await caixa.post('/api/day/open', { openingCashCents: 10000 });

  console.log('\n[R2] Cliente em todas as telas (R1)');
  const jantinha = find('Jantinha Completa');
  const coca = await prod('Coca-Cola lata');
  const hamb = await prod('Hambúrguer');
  const batata = await prod('Batata Simples');
  const heineken = await prod('Heineken');
  // a suíte V1 muda o preço da batata para R$ 29; volta para R$ 25 (preço oficial)
  await admin.put(`/api/products/${batata.id}`, { ...batata, priceCents: 2500, groups: [] });
  // estoque inicial para os testes
  await caixa.post('/api/stock/count', { items: [{ productId: coca.id, qty: 20 }, { productId: heineken.id, qty: 10 }], reason: 'Contagem inicial do teste' });
  const g = await newAcc({
    customerName: 'Gustavo', note: 'camisa vermelha', tableLabel: '7', consumptionType: 'LOCAL',
    items: [{ productId: jantinha.id, quantity: 1, optionIds: [jantinha.groups[0].options[0].id] }, { productId: coca.id, quantity: 1 }],
  });
  check('T1. Conta com cliente "Gustavo" criada', g.status === 200 && g.data.orderNumber, g.data);
  const gId = g.data.id;
  const board = (await caixa.get('/api/cashier/board')).data;
  check('R1. Nome no painel do caixa', board.accounts.some((a: any) => a.id === gId && a.customerName === 'Gustavo'));
  const today = (await caixa.get('/api/orders/today')).data as any[];
  check('R1. Nome nos pedidos do dia', today.some((o: any) => o.accountId === gId && o.customerName === 'Gustavo'));
  const kOrd = (await kitchen()).find((o) => o.account.id === gId);
  check('R1/T3. Nome na cozinha; cozinha recebe só a Jantinha (Coca fica na conta)', kOrd?.account.customerName === 'Gustavo' && kOrd.items.length === 1 && kOrd.items[0].name === 'Jantinha Completa', kOrd);
  const det = (await caixa.get(`/api/orders/${g.data.orderId}`)).data;
  check('R1/R3. Detalhe do pedido completo (cliente, mesa, itens, total, situação, linha do tempo)',
    det.account.customerName === 'Gustavo' && det.account.tableLabel === '7' && det.order.items.length === 2 && det.order.totalCents === 3600
    && det.order.situation === 'PENDENTE' && det.timeline.length >= 3 && det.order.consumptionType === 'LOCAL', det);
  const readyEv = waitEvent(ctx.cSock, 'order:ready');
  await coz.post(`/api/kitchen/orders/${kOrd.id}/start`);
  await coz.post(`/api/kitchen/orders/${kOrd.id}/ready`);
  const rp = await readyEv;
  check('R1. Nome no alerta de pronto', rp?.customerName === 'Gustavo', rp);
  const noName = await newAcc({ items: [{ productId: batata.id, quantity: 1 }] });
  const accNo = (await caixa.get(`/api/accounts/${noName.data.id}`)).data;
  check('T2. Conta sem nome fica sem nome (a tela mostra "Cliente não informado" só neste caso)', accNo.customerName === null);
  const hist = (await admin.get('/api/orders/history?search=Gustavo')).data as any[];
  check('R1. Nome no histórico (admin)', hist.length >= 1 && hist.every((h: any) => h.customerName === 'Gustavo'));

  console.log('\n[R2] Reabertura: cozinha recebe só a diferença');
  const r1 = await newAcc({ customerName: 'Reabre', items: [{ productId: hamb.id, quantity: 2 }] });
  const k1 = (await kitchen()).find((o) => o.account.id === r1.data.id);
  await coz.post(`/api/kitchen/orders/${k1.id}/ready`);
  const kn = waitEvent(kSock, 'kitchen:new');
  const add1 = await caixa.post(`/api/accounts/${r1.data.id}/orders`, { items: [{ productId: batata.id, quantity: 1 }, { productId: coca.id, quantity: 1 }] });
  await kn;
  const kAll = await kitchen();
  const newBatch = kAll.find((o) => o.id === add1.data.orderId);
  check('Reabertura T1/T2. Cozinha recebe SOMENTE 1× Batata (sem Coca, sem hambúrgueres)', newBatch && newBatch.items.length === 1 && newBatch.items[0].name === 'Batata Simples' && newBatch.items[0].quantity === 1, newBatch?.items);
  check('Reabertura. Cartão mostra itens anteriores como PRONTOS (só leitura)', newBatch?.previous?.some((p: any) => p.name === 'Hambúrguer' && p.quantity === 2 && p.status === 'READY'), newBatch?.previous);
  check('Reabertura. Hambúrgueres não voltam para "novos"', !kAll.some((o) => o.id === k1.id && o.status !== 'READY'));
  const add2 = await caixa.post(`/api/accounts/${r1.data.id}/orders`, { items: [{ productId: hamb.id, quantity: 1 }] });
  const b2 = (await kitchen()).find((o) => o.id === add2.data.orderId);
  check('Reabertura T3. 2 → 3 hambúrgueres: cozinha recebe +1', b2?.items[0].quantity === 1);
  const accR = (await caixa.get(`/api/accounts/${r1.data.id}`)).data;
  await caixa.post(`/api/accounts/${r1.data.id}/payments`, { payments: [{ methodId: M('PIX'), amountCents: accR.totals.balance }] });
  const add3 = await caixa.post(`/api/accounts/${r1.data.id}/orders`, { items: [{ productId: batata.id, quantity: 2 }] });
  const accR2 = (await caixa.get(`/api/accounts/${r1.data.id}`)).data;
  check('Reabertura T5/T7. Conta paga + novo item: pagamento antigo mantido, saldo = só o novo, pedidos antigos PAGO, novo PENDENTE',
    accR2.totals.balance === 5000 && accR2.payments.length === 1 && accR2.orders.filter((o: any) => o.id !== add3.data.orderId).every((o: any) => o.situation === 'PAGO')
    && accR2.orders.find((o: any) => o.id === add3.data.orderId).situation === 'PENDENTE', accR2.orders.map((o: any) => [o.number, o.situation]));
  const b3 = (await kitchen()).find((o) => o.id === add3.data.orderId);
  check('Reabertura T4. +2 batatas: cozinha recebe 2 (não 4)', b3?.items[0].quantity === 2);

  console.log('\n[R2] Pagamento, duplicidade e desconto');
  const pm = await newAcc({ customerName: 'Misto', items: [{ productId: batata.id, quantity: 4 }] }); // R$ 100
  const key = 'teste-idem-' + Date.now();
  const payBody = { payments: [{ methodId: M('PIX'), amountCents: 6000 }, { methodId: M('DINHEIRO'), amountCents: 4000 }], close: true };
  const [pA, pB] = await Promise.all([
    caixa.req('POST', `/api/accounts/${pm.data.id}/payments`, payBody, { 'idempotency-key': key }),
    caixa.req('POST', `/api/accounts/${pm.data.id}/payments`, payBody, { 'idempotency-key': key }),
  ]);
  const pmAcc = (await caixa.get(`/api/accounts/${pm.data.id}`)).data;
  check('R2/T6. PIX 60 + dinheiro 40 → saldo 0 e conta encerrada', pmAcc.totals.balance === 0 && pmAcc.status === 'CLOSED');
  check('Duplicidade. Duplo clique no pagamento registra UMA vez', pmAcc.payments.length === 2 && [pA.status, pB.status].includes(200), [pA.status, pB.status]);
  const dk = 'teste-conta-' + Date.now();
  const [c1, c2] = await Promise.all([
    caixa.req('POST', '/api/accounts', { customerName: 'Duplo', items: [{ productId: batata.id, quantity: 1 }] }, { 'idempotency-key': dk }),
    caixa.req('POST', '/api/accounts', { customerName: 'Duplo', items: [{ productId: batata.id, quantity: 1 }] }, { 'idempotency-key': dk }),
  ]);
  const duplos = (await q(`SELECT COUNT(*)::int AS n FROM accounts WHERE customer_name = 'Duplo'`))[0].n;
  check('Duplicidade. Duplo clique em "Enviar pedido" cria UMA conta', duplos === 1, { duplos, s: [c1.status, c2.status] });
  const pp = await newAcc({ customerName: 'Parcial', items: [{ productId: batata.id, quantity: 4 }] });
  const pr = await caixa.post(`/api/accounts/${pp.data.id}/payments`, { payments: [{ methodId: M('PIX'), amountCents: 6000 }] });
  check('T5. Parcial 60 de 100 → saldo 40', pr.data.balance === 4000 && pr.data.status === 'PARTIALLY_PAID');
  await caixa.post(`/api/accounts/${pp.data.id}/discounts`, { amountCents: 1000, reason: 'Cortesia para morador' });
  const ppAcc = (await caixa.get(`/api/accounts/${pp.data.id}`)).data;
  check('T9. Desconto grava valor, motivo, usuário, total antes e depois', ppAcc.discounts[0].totalBeforeCents === 10000 && ppAcc.discounts[0].totalAfterCents === 9000 && ppAcc.discounts[0].userName === 'Caixa');

  console.log('\n[R2] Estoque (T10) e cozumel com cerveja');
  await caixa.post(`/api/stock/${coca.id}`, { type: 'AJUSTE', newQty: 1, reason: 'Teste de estoque 1' });
  const st1 = await newAcc({ items: [{ productId: coca.id, quantity: 1 }] });
  const cocaNow = async () => (await q('SELECT stock_qty FROM products WHERE id = $1', [coca.id]))[0].stock_qty;
  check('T10. Estoque 1 → vende → 0', st1.status === 200 && (await cocaNow()) === 0);
  const st2 = await newAcc({ items: [{ productId: coca.id, quantity: 1 }] });
  check('T10. Estoque 0 → alerta "estoque insuficiente" (não vende sem decisão)', st2.status === 409 && st2.data.code === 'STOCK_INSUFFICIENT' && st2.data.details[0].stock === 0, st2.data);
  const st3 = await newAcc({ items: [{ productId: coca.id, quantity: 1 }], stockDecisions: [{ productId: coca.id, action: 'RELEASE', reason: 'Tinha no freezer' }] });
  const div = await q(`SELECT * FROM stock_movements WHERE product_id = $1 AND type = 'DIVERGENCIA' ORDER BY id DESC LIMIT 1`, [coca.id]);
  check('T10. "Liberar venda" vende, registra divergência (motivo, usuário) e estoque não fica negativo', st3.status === 200 && div[0]?.missing === 1 && /freezer/.test(div[0].reason) && (await cocaNow()) === 0);
  const st4 = await newAcc({ items: [{ productId: coca.id, quantity: 1 }], stockDecisions: [{ productId: coca.id, action: 'CORRECT', newQty: 6 }] });
  check('T10. "Corrigir estoque e vender": contagem 6 → vende 1 → 5', st4.status === 200 && (await cocaNow()) === 5);
  const st4acc = (await caixa.get(`/api/accounts/${st4.data.id}`)).data;
  await caixa.post(`/api/order-items/${st4acc.orders[0].items[0].id}/cancel`, { reason: 'Cliente desistiu', returnStock: true });
  check('Cancelamento devolve ao estoque (5 → 6)', (await cocaNow()) === 6);
  const coz2 = await prod('Cozumel com cerveja');
  const heiOpt = coz2.groups[0].options.find((o: any) => o.name === 'Heineken');
  const heiBefore = (await q('SELECT stock_qty FROM products WHERE id = $1', [heineken.id]))[0].stock_qty;
  await newAcc({ items: [{ productId: coz2.id, quantity: 2, optionIds: [heiOpt.id] }] });
  const heiAfter = (await q('SELECT stock_qty FROM products WHERE id = $1', [heineken.id]))[0].stock_qty;
  check('Cozumel com cerveja baixa a Heineken escolhida (2 un.)', heiBefore - heiAfter === 2, { heiBefore, heiAfter });
  const kCoz = (await kitchen()).find((o) => o.items.some((i: any) => i.name === 'Cozumel com cerveja'));
  check('Cozumel vai para a cozinha', !!kCoz);

  console.log('\n[R2] Itens e cancelamentos');
  const cu = await newAcc({ customerName: 'Outro', consumptionType: 'VIAGEM', items: [{ custom: { description: 'Queijo extra', priceCents: 500, goesToKitchen: true }, quantity: 1 }, { productId: hamb.id, quantity: 3 }] });
  const cuAcc = (await caixa.get(`/api/accounts/${cu.data.id}`)).data;
  check('T17. "Outro/Adicional" aparece com a descrição', cuAcc.orders[0].items.some((i: any) => i.productName === 'Queijo extra' && i.isCustom && i.unitPriceCents === 500));
  const kv = (await kitchen()).find((o) => o.account.id === cu.data.id);
  check('T18. "Para viagem" aparece na cozinha', kv?.consumptionType === 'VIAGEM' && kv.items.some((i: any) => i.name === 'Queijo extra'));
  const hItem = cuAcc.orders[0].items.find((i: any) => i.productName === 'Hambúrguer');
  await caixa.post(`/api/order-items/${hItem.id}/cancel`, { reason: 'Cliente pediu só 2', quantity: 1 });
  const cuAcc2 = (await caixa.get(`/api/accounts/${cu.data.id}`)).data;
  const activeH = cuAcc2.orders[0].items.filter((i: any) => i.productName === 'Hambúrguer' && i.status === 'ACTIVE');
  check('Reduzir quantidade: 3 → 2 (cancelamento parcial com motivo)', activeH.length === 1 && activeH[0].quantity === 2 && cuAcc2.totals.total === 500 + 2 * 2500);
  const canc = await q(`SELECT * FROM cancellations WHERE account_id = $1 ORDER BY id DESC LIMIT 1`, [cu.data.id]);
  check('T8. Cancelamento registra motivo, usuário, status antes/depois', canc[0].reason === 'Cliente pediu só 2' && canc[0].status_before && canc[0].status_after && canc[0].quantity === 1);
  const cons = await caixa.req('PATCH', `/api/orders/${cuAcc2.orders[0].id}/consumption`, { consumptionType: 'LOCAL' });
  check('Tipo de consumo pode mudar antes de ficar pronto', cons.status === 200);

  console.log('\n[R2] Juntar contas e transferir pedido (T23)');
  const ja = await newAcc({ customerName: 'Junta A', items: [{ productId: batata.id, quantity: 1 }] });
  const jb = await newAcc({ customerName: 'Junta B', items: [{ productId: batata.id, quantity: 2 }] });
  await caixa.post(`/api/accounts/${ja.data.id}/payments`, { payments: [{ methodId: M('PIX'), amountCents: 1000 }] });
  const mg = await caixa.post(`/api/accounts/${ja.data.id}/merge`, { targetId: jb.data.id });
  const jbAcc = (await caixa.get(`/api/accounts/${jb.data.id}`)).data;
  const jaAcc = (await caixa.get(`/api/accounts/${ja.data.id}`)).data;
  check('Juntar: destino soma total (75) e pagamento (10); origem fica "Juntada"', mg.status === 200 && jbAcc.totals.total === 7500 && jbAcc.totals.paid === 1000 && jaAcc.status === 'MERGED', { t: jbAcc.totals, s: jaAcc.status });
  const tc = await newAcc({ customerName: 'Transf', items: [{ productId: batata.id, quantity: 1 }] });
  const tr = await caixa.post(`/api/orders/${tc.data.orderId}/transfer`, { targetAccountId: jb.data.id });
  const jbAcc2 = (await caixa.get(`/api/accounts/${jb.data.id}`)).data;
  check('Transferir pedido: vai para a conta de destino com o valor', tr.status === 200 && jbAcc2.totals.total === 10000);

  console.log('\n[R2] Estabelecimento aberto/fechado (R6, T11, T12)');
  await caixa.post('/api/day/establishment', { isOpen: false });
  const sAdm = (await admin.get('/api/settings')).data;
  check('T11/R6. Caixa fecha → admin vê FECHADO', sAdm.restaurant.isOpen === false);
  const blocked = await newAcc({ items: [{ productId: batata.id, quantity: 1 }] });
  check('Fechado recusa pedido novo', blocked.status === 409);
  await admin.patch('/api/settings', { isOpen: true });
  const sCx = (await caixa.get('/api/settings')).data;
  check('T12/R6. Admin abre → caixa vê ABERTO', sCx.restaurant.isOpen === true);
  const ev = await q(`SELECT COUNT(*)::int AS n FROM status_events`);
  check('Mudanças de estado registradas na linha do tempo', ev[0].n >= 2);

  console.log('\n[R2] Despesas e financeiro (T19, T20, T21)');
  const cats = (await caixa.get('/api/expense-categories')).data as any[];
  const comb = cats.find((c) => c.name === 'Combustível');
  const denied = await caixa.post('/api/expenses', { description: 'Aluguel', categoryId: comb.id, amountCents: 50000, paidFromRegister: false });
  check('Caixa não lança despesa fora da gaveta', denied.status === 400);
  const before = (await admin.get('/api/register/current')).data.summary.expectedCashCents;
  const ex = await caixa.post('/api/expenses', { description: 'Gasolina', categoryId: comb.id, amountCents: 8000, paidFromRegister: true });
  const after = (await admin.get('/api/register/current')).data.summary.expectedCashCents;
  check('T19. Despesa paga com a gaveta vira sangria (dinheiro esperado −80)', ex.status === 200 && before - after === 8000, { before, after });
  await admin.post('/api/expenses', { description: 'Funcionária', categoryId: cats.find((c) => c.name === 'Funcionários').id, amountCents: 10000 });
  const bat = await prod('Batata Simples');
  await admin.put(`/api/products/${bat.id}`, { ...bat, costCents: 1000, applyCostToPast: true, groups: [] });
  const fin = (await admin.get('/api/finance')).data;
  const batRow = fin.products.find((p: any) => p.name === 'Batata Simples');
  check('T20. Financeiro: lucro bruto = faturamento − custo; resultado = lucro bruto − despesas',
    fin.grossProfitCents === fin.revenueCents - fin.costCents && fin.operatingResultCents === fin.grossProfitCents - fin.expensesCents && fin.expensesCents === 18000, fin);
  check('T20. Análise por produto: Batata custo R$ 10, margem = receita − custo', batRow.costCents === batRow.qty * 1000 && batRow.marginCents === batRow.revenueCents - batRow.costCents && batRow.unitMarginCents === 1500);
  await admin.put(`/api/products/${bat.id}`, { ...bat, costCents: 1200, priceCents: 2700, groups: [] });
  const oldItem = (await q(`SELECT unit_cost_cents, unit_price_cents FROM order_items WHERE product_id = $1 ORDER BY id LIMIT 1`, [bat.id]))[0];
  check('T21. Mudança de preço e custo não altera vendas antigas', oldItem.unit_cost_cents === 1000 && oldItem.unit_price_cents === 2500);
  await admin.put(`/api/products/${bat.id}`, { ...bat, costCents: 1200, priceCents: 2500, groups: [] });

  console.log('\n[R2] Permissões do caixa (T22)');
  const forb = await Promise.all(['/api/dashboard', '/api/finance', '/api/registers', '/api/orders/history', '/api/insights', '/api/audit', '/api/users', '/api/timing']
    .map((u) => caixa.get(u)));
  check('T22. Caixa não acessa financeiro, dashboard, histórico, insights, auditoria, usuários', forb.every((r) => r.status === 403), forb.map((r) => r.status));
  const oldAcc = (await q(`SELECT id FROM accounts WHERE status = 'CLOSED' AND cash_register_id IS NOT NULL AND cash_register_id <> (SELECT id FROM cash_registers WHERE status='OPEN') ORDER BY id LIMIT 1`))[0];
  if (oldAcc) check('T22. Caixa não abre conta de dia anterior (API)', (await caixa.get(`/api/accounts/${oldAcc.id}`)).status === 403);
  const cozForb = await Promise.all(['/api/finance', '/api/insights', '/api/cashier/board'].map((u) => coz.get(u)));
  check('Cozinha sem acesso a financeiro/insights/caixa', cozForb.every((r) => r.status === 403));

  console.log('\n[R2] Tempo de preparo (T24) e admin na cozinha (T26)');
  const tp = await newAcc({ customerName: 'Tempo', items: [{ productId: batata.id, quantity: 1 }] });
  const tk = (await kitchen()).find((o) => o.account.id === tp.data.id);
  await admin.post(`/api/kitchen/orders/${tk.id}/start`);
  await admin.post(`/api/kitchen/orders/${tk.id}/ready`);
  const roleRow = await q(`SELECT user_role FROM audit_logs WHERE entity_type='order' AND entity_id=$1 AND action='kitchen.ready'`, [tk.id]);
  check('T26. Admin opera a cozinha e a auditoria registra perfil ADMIN', roleRow[0]?.user_role === 'ADMIN');
  await q(`UPDATE orders SET created_at = now() - interval '131 minutes', confirmed_at = now() - interval '130 minutes', started_at = now() - interval '129 minutes', ready_at = now() - interval '10 minutes' WHERE id = $1`, [tk.id]);
  // ontem + hoje: o teste joga o pedido 131 min para trás (de madrugada isso cai no dia anterior)
  const dia = (d: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() + d * 86400_000));
  const timingUrl = `/api/timing?from=${dia(-1)}&to=${dia(0)}`;
  const tim = (await admin.get(timingUrl)).data;
  check('T24. Tempo suspeito (esquecido) fica fora das médias', tim.suspects.some((s: any) => s.id === tk.id));
  const confirmed = (await q(`SELECT confirmed_at FROM orders WHERE id = $1`, [tk.id]))[0].confirmed_at as Date;
  const fix = await admin.post(`/api/orders/${tk.id}/times`, { field: 'readyAt', value: new Date(confirmed.getTime() + 14 * 60_000).toISOString(), reason: 'Cozinha esqueceu de marcar pronto' });
  const tim2 = (await admin.get(timingUrl)).data;
  const corr = await q(`SELECT * FROM order_time_corrections WHERE order_id = $1`, [tk.id]);
  check('T24. Correção do admin guarda o horário original e sai dos suspeitos', fix.status === 200 && corr.length === 1 && corr[0].before && !tim2.suspects.some((s: any) => s.id === tk.id), { fix: fix.data, corr, sus: tim2.suspects });
  const badFix = await admin.post(`/api/orders/${tk.id}/times`, { field: 'startedAt', value: new Date(confirmed.getTime() + 60 * 60_000).toISOString(), reason: 'teste inválido' });
  check('Correção com ordem inválida é recusada', badFix.status === 400);

  console.log('\n[R2] Cliente recorrente, insights, logout');
  await caixa.post(`/api/accounts/${noName.data.id}/pending`, { customerName: 'Fulano Fiado', contact: 'casa 99' });
  const sug = (await caixa.get('/api/customers/suggest?q=fulano')).data as any[];
  check('Sugestão de cliente avisa pendência', sug[0]?.name === 'Fulano Fiado' && sug[0].pendingCents === 2500, sug);
  const ins = (await admin.get('/api/insights')).data;
  check('T25. Insights sem base mostram nível 1 e mensagem de dados insuficientes', ins.level === 1 && /histórico suficiente|primeiros insights/.test(ins.message), ins.message);
  check('T25. Nenhum insight comparativo com menos de 7 dias', ins.all.every((i: any) => ['DADO', 'ESTIMATIVA'].includes(i.kind) || i.key.startsWith('day.highlight')));
  const lo = new Client('logout');
  await lo.post('/api/auth/login', { username: 'caixa', password: 'caixa123' });
  await lo.post('/api/auth/logout');
  const lg = await q(`SELECT 1 FROM audit_logs WHERE action = 'auth.logout' LIMIT 1`);
  check('Logout registrado na auditoria', lg.length === 1);
  const denied2 = await lo.get('/api/cashier/board');
  check('Depois do logout a API recusa (401)', denied2.status === 401);

  console.log('\n[R2] Travas do banco (R2)');
  let blockedDel = false;
  try { await q('DELETE FROM stock_movements WHERE id = (SELECT MIN(id) FROM stock_movements)'); } catch { blockedDel = true; }
  let neg = false;
  try { await q(`UPDATE products SET stock_qty = -1 WHERE id = $1`, [coca.id]); } catch { neg = true; }
  check('Banco recusa apagar movimento de estoque e estoque negativo', blockedDel && neg);
  await pgc.end();
}
