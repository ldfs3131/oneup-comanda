/**
 * PORTÃO DA ONE BASE — testes de vazamento entre empresas.
 * A empresa BETA (com o perfil mais poderoso dela) tenta ler, alterar e apagar dados da ALFA por
 * todas as rotas que recebem identificador, por referência cruzada, pelo tempo real e direto no banco.
 *
 * Preparação (banco novo):
 *   node dist/scripts/setup.js --empresa=alfa --nome="Alfa" --admin-pass=alfa-admin --caixa-pass=alfa-caixa --cozinha-pass=alfa-coz --cardapio=exemplo
 *   node dist/scripts/setup.js --empresa=beta --nome="Beta" --admin-pass=beta-admin --caixa-pass=beta-caixa --cozinha-pass=beta-coz --cardapio=exemplo
 *   EMPRESA_HEADER=true PORT=3200 node dist/index.js &
 *   BASE_URL=http://localhost:3200 DATABASE_URL=... node dist/scripts/isolamento-test.js
 */
import { io, type Socket } from 'socket.io-client';
import pg from 'pg';

const BASE = process.env.BASE_URL ?? 'http://localhost:3200';
const DB_URL = process.env.DATABASE_URL!;
let passed = 0;
const failures: string[] = [];
function check(label: string, cond: unknown, extra?: unknown) {
  if (cond) { passed++; console.log(`  ✔ ${label}`); } else { failures.push(label); console.log(`  ✘ ${label}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300)); }
}

class Client {
  cookie = '';
  constructor(public empresa: string) {}
  async req(method: string, path: string, body?: unknown, empresa = this.empresa) {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'x-empresa': empresa, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, text };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b: unknown = {}) => this.req('POST', p, b);
  put = (p: string, b: unknown) => this.req('PUT', p, b);
  patch = (p: string, b: unknown) => this.req('PATCH', p, b);
  del = (p: string) => this.req('DELETE', p);
  socket(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const s = io(BASE, { extraHeaders: { cookie: this.cookie, 'x-empresa': this.empresa }, transports: ['websocket'] });
      s.on('connect', () => resolve(s)); s.on('connect_error', reject);
    });
  }
}
const events = (s: Socket) => { const got: string[] = []; s.onAny((e) => got.push(e)); return got; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MARCA = 'ALFA-SEGREDO-7Q';

async function snapshot(c: pg.Client, empresaId: number) {
  const tabelas = ['accounts', 'orders', 'order_items', 'payments', 'discounts', 'cancellations', 'expenses', 'products', 'categories', 'options', 'users', 'stock_movements', 'customers', 'cash_registers', 'restaurant_settings', 'expense_categories'];
  const out: Record<string, string> = {};
  for (const t of tabelas) {
    const r = await c.query(`SELECT count(*)::int AS n, md5(COALESCE(string_agg(to_jsonb(x)::text, '|' ORDER BY to_jsonb(x)::text), '')) AS h FROM ${t} x WHERE empresa_id = $1`, [empresaId]);
    out[t] = `${r.rows[0].n}:${r.rows[0].h}`;
  }
  return out;
}

async function main() {
  const sys = new pg.Client({ connectionString: DB_URL }); await sys.connect();
  const ids = Object.fromEntries((await sys.query(`SELECT slug, id FROM empresas WHERE slug IN ('alfa','beta')`)).rows.map((r) => [r.slug, r.id]));
  if (!ids.alfa || !ids.beta) throw new Error('Rode o setup das empresas alfa e beta antes (veja o topo do arquivo).');

  console.log('\n[1] Login e sessão presos à empresa');
  const aAdm = new Client('alfa'), aCx = new Client('alfa'), aCoz = new Client('alfa');
  const bAdm = new Client('beta'), bCx = new Client('beta'), bCoz = new Client('beta');
  check('Mesmo usuário "admin" existe nas duas empresas, cada um com sua senha',
    (await aAdm.post('/api/auth/login', { username: 'admin', password: 'alfa-admin' })).status === 200
    && (await bAdm.post('/api/auth/login', { username: 'admin', password: 'beta-admin' })).status === 200);
  check('Senha da Alfa não entra na Beta', (await new Client('beta').post('/api/auth/login', { username: 'admin', password: 'alfa-admin' })).status !== 200);
  await aCx.post('/api/auth/login', { username: 'caixa', password: 'alfa-caixa' });
  await aCoz.post('/api/auth/login', { username: 'cozinha', password: 'alfa-coz' });
  await bCx.post('/api/auth/login', { username: 'caixa', password: 'beta-caixa' });
  await bCoz.post('/api/auth/login', { username: 'cozinha', password: 'beta-coz' });
  const roubado = new Client('beta'); roubado.cookie = aAdm.cookie;
  check('Sessão (cookie) da Alfa não vale na Beta', (await roubado.get('/api/auth/me')).status === 401);
  check('Empresa inexistente: 404', (await new Client('nao-existe').get('/api/meta')).status === 404);
  check('Endereço sem empresa definida: 404 (nunca cai numa empresa padrão)', (await fetch(BASE + '/api/meta')).status === 404);

  console.log('\n[2] A Alfa trabalha (dados que a Beta não pode ver)');
  const aSockK = await aCoz.socket(), bSockK = await bCoz.socket(), bSockC = await bCx.socket(), bSockA = await bAdm.socket();
  const bGot = [...events(bSockK), ...events(bSockC)]; const bGotK = events(bSockK), bGotC = events(bSockC), bGotA = events(bSockA);
  const aGotK = events(aSockK);
  const aMenu = (await aAdm.get('/api/menu?all=1')).data as any[];
  const aProds = aMenu.flatMap((c) => c.products);
  const aFood = aProds.find((p) => p.sendsToKitchen && !p.groups?.length);
  const aDrink = aProds.find((p) => !p.sendsToKitchen && !p.groups?.length && p.trackStock);
  const aOpt = aProds.flatMap((p) => p.groups ?? []).flatMap((g: any) => g.options)[0];
  const aCat = aMenu[0];
  await aAdm.post(`/api/stock/${aDrink.id}`, { type: 'ENTRADA', quantity: 50, reason: 'estoque inicial' });
  check('Alfa abre o caixa', (await aCx.post('/api/register/open', { openingCashCents: 10000 })).status === 200);
  const aAcc = await aCx.post('/api/accounts', { customerName: MARCA, note: MARCA, phone: '61999990001', items: [{ productId: aFood.id, quantity: 2 }, { productId: aDrink.id, quantity: 1 }] });
  check('Alfa cria conta com cozinha', aAcc.status === 200, aAcc.data);
  await sleep(400);
  check('Cozinha da Alfa recebe o pedido em tempo real', aGotK.includes('kitchen:new'));
  const aMethods = (await aCx.get('/api/payment-methods')).data as any[];
  const aPix = aMethods.find((m) => m.code === 'PIX');
  await aCx.post(`/api/accounts/${aAcc.data.id}/payments`, { payments: [{ methodId: aPix.id, amountCents: 500 }] });
  await aCx.post(`/api/accounts/${aAcc.data.id}/discounts`, { amountCents: 100, reason: 'desconto alfa' });
  const aDet = (await aCx.get(`/api/accounts/${aAcc.data.id}`)).data;
  const aOrder = aDet.orders[0];
  const aItem = aOrder.items[0];
  const aPay = (await sys.query('SELECT id FROM payments WHERE account_id = $1', [aAcc.data.id])).rows[0];
  const aKitchen = ((await aCoz.get('/api/kitchen/orders')).data as any[])[0];
  await aCoz.post(`/api/kitchen/orders/${aKitchen.id}/start`);
  const aCats = (await aAdm.get('/api/expense-categories')).data as any[];
  const aExp = await aAdm.post('/api/expenses', { description: MARCA, categoryId: aCats[0].id, amountCents: 3300 });
  const aExpId = aExp.data?.id ?? (await sys.query('SELECT max(id) AS id FROM expenses WHERE empresa_id=$1', [ids.alfa])).rows[0].id;
  const aAcc2 = await aCx.post('/api/accounts', { customerName: `${MARCA}-2`, items: [{ productId: aDrink.id, quantity: 1 }] });
  await aCx.post(`/api/accounts/${aAcc2.data.id}/pending`, { customerName: `${MARCA}-FIADO`, contact: 'casa 7' });
  const aUser = ((await aAdm.get('/api/users')).data as any[]).find((u) => u.username === 'caixa');
  const aReg = ((await aAdm.get('/api/registers')).data as any[])[0];
  await aAdm.patch('/api/settings', { name: `Restaurante ${MARCA}` });
  check('Numeração da Alfa começa em 1', aAcc.data.number === 1, aAcc.data.number);

  await sleep(600);
  check('[tempo real] Cozinha da Beta NÃO recebeu nada da Alfa', bGotK.length === 0, bGotK);
  check('[tempo real] Caixa da Beta NÃO recebeu nada da Alfa', bGotC.length === 0, bGotC);
  check('[tempo real] Admin da Beta NÃO recebeu nada da Alfa', bGotA.length === 0, bGotA);
  void bGot;

  const antes = await snapshot(sys, ids.alfa);

  console.log('\n[3] A Beta tenta LER a Alfa pelas listas');
  const listas = ['/api/cashier/board', '/api/orders/today', '/api/kitchen/orders', '/api/accounts/receivable', '/api/accounts', '/api/audit',
    '/api/registers', '/api/register/current', '/api/expenses', '/api/stock', '/api/stock/divergences', '/api/menu?all=1', '/api/users', '/api/customers/suggest?q=alfa',
    '/api/dashboard', '/api/finance', '/api/insights', '/api/timing', '/api/settings', '/api/meta', '/api/cancellations', '/api/orders/history', '/api/public/menu'];
  for (const u of listas) {
    const r = await bAdm.get(u);
    check(`Beta ${u} → sem nenhum dado da Alfa (${r.status})`, !r.text.includes(MARCA) && !r.text.includes('61999990001'), r.text.slice(0, 200));
  }
  const bDash = (await bAdm.get('/api/dashboard')).data;
  check('Dashboard da Beta não soma vendas da Alfa', bDash.revenueCents === 0 && bDash.ordersCount === 0, { rev: bDash.revenueCents, n: bDash.ordersCount });
  const bMeta = (await new Client('beta').get('/api/meta')).data;
  check('Nome da Beta não mudou com a configuração da Alfa', !String(bMeta.restaurantName).includes(MARCA), bMeta);

  console.log('\n[4] A Beta tenta LER, ALTERAR e APAGAR registros da Alfa pelo identificador (todas as rotas)');
  const bMenu = (await bAdm.get('/api/menu?all=1')).data as any[];
  const bProds = bMenu.flatMap((c) => c.products);
  const bDrink = bProds.find((p) => !p.sendsToKitchen && !p.groups?.length);
  if (bDrink.trackStock) await bAdm.post(`/api/stock/${bDrink.id}`, { type: 'ENTRADA', quantity: 50, reason: 'estoque inicial' });
  check('Beta abre o caixa', (await bCx.post('/api/register/open', { openingCashCents: 5000 })).status === 200);
  const bAcc = await bCx.post('/api/accounts', { customerName: 'Beta cliente', items: [{ productId: bDrink.id, quantity: 1 }] });
  check('Numeração da Beta também começa em 1 (independente)', bAcc.data.number === 1, bAcc.data.number);
  const bPix = ((await bCx.get('/api/payment-methods')).data as any[]).find((m) => m.code === 'PIX');
  const R = 'teste de vazamento';
  const aCustomerId = (await sys.query('SELECT id FROM customers WHERE empresa_id = $1 ORDER BY id LIMIT 1', [ids.alfa])).rows[0]?.id ?? 999999;
  const ataques: [string, string, unknown?][] = [
    ['GET', `/api/accounts/${aAcc.data.id}`],
    ['GET', `/api/orders/${aOrder.id}`],
    ['GET', `/api/order-items/${aItem.id}/stock`],
    ['GET', `/api/registers/${aReg.id}`],
    ['GET', `/api/stock/${aDrink.id}/movements`],
    ['PATCH', `/api/accounts/${aAcc.data.id}`, { customerName: 'invadido', note: 'invadido' }],
    ['PATCH', `/api/categories/${aCat.id}`, { name: 'invadido' }],
    ['DELETE', `/api/categories/${aCat.id}`],
    ['PATCH', `/api/expense-categories/${aCats[0].id}`, { name: 'invadido' }],
    ...(aOpt ? [['PATCH', `/api/options/${aOpt.id}/availability`, { available: false }] as [string, string, unknown]] : []),
    ['PATCH', `/api/orders/${aOrder.id}/consumption`, { consumptionType: 'VIAGEM' }],
    ['PATCH', `/api/products/${aFood.id}/availability`, { available: false }],
    ['PATCH', `/api/users/${aUser.id}`, { active: false }],
    ['POST', `/api/accounts/${aAcc.data.id}/orders`, { items: [{ productId: bDrink.id, quantity: 1 }] }],
    ['POST', `/api/accounts/${aAcc.data.id}/payments`, { payments: [{ methodId: bPix.id, amountCents: 100 }] }],
    ['POST', `/api/accounts/${aAcc.data.id}/discounts`, { amountCents: 100, reason: R }],
    ['POST', `/api/accounts/${aAcc.data.id}/pending`, { customerName: 'x', contact: 'casa 1' }],
    ['POST', `/api/accounts/${aAcc.data.id}/close`, {}],
    ['POST', `/api/accounts/${aAcc.data.id}/cancel`, { reason: R }],
    ['POST', `/api/accounts/${aAcc2.data.id}/reopen`, { reason: R }],
    ['POST', `/api/accounts/${aAcc.data.id}/merge`, { targetId: bAcc.data.id }],
    ['POST', `/api/accounts/${bAcc.data.id}/merge`, { targetId: aAcc.data.id }],
    ['POST', `/api/orders/${aOrder.id}/transfer`, { targetAccountId: bAcc.data.id }],
    ['POST', `/api/orders/${aOrder.id}/cancel`, { reason: R }],
    ['POST', `/api/orders/${aOrder.id}/confirm`, {}],
    ['POST', `/api/orders/${aOrder.id}/deliver`, {}],
    ['POST', `/api/orders/${aOrder.id}/clear-problem`, {}],
    ['POST', `/api/orders/${aOrder.id}/times`, { field: 'readyAt', value: new Date().toISOString(), reason: R }],
    ['POST', `/api/order-items/${aItem.id}/cancel`, { reason: R }],
    ['POST', `/api/kitchen/orders/${aKitchen.id}/start`, {}],
    ['POST', `/api/kitchen/orders/${aKitchen.id}/ready`, {}],
    ['POST', `/api/kitchen/orders/${aKitchen.id}/back`, {}],
    ['POST', `/api/kitchen/orders/${aKitchen.id}/problem`, { reason: R }],
    ['POST', `/api/payments/${aPay.id}/reverse`, { reason: R }],
    ['POST', `/api/expenses/${aExpId}/cancel`, { reason: R }],
    ['POST', `/api/products/${aFood.id}/move`, { direction: 'up' }],
    ['POST', `/api/products/${aFood.id}/prep`, { minutes: 33 }],
    ['POST', `/api/products/${aFood.id}/image`, {}],
    ['POST', `/api/stock/${aDrink.id}`, { type: 'ENTRADA', quantity: 5, reason: R }],
    ['PUT', `/api/products/${aFood.id}`, { ...aFood, name: 'invadido', priceCents: 1, groups: [] }],
    // referência cruzada: a Beta usa identificadores da Alfa dentro das próprias operações
    ['POST', '/api/accounts', { items: [{ productId: aFood.id, quantity: 1 }] }],
    ['POST', `/api/accounts/${bAcc.data.id}/orders`, { items: [{ productId: aDrink.id, quantity: 1 }] }],
    ['POST', `/api/accounts/${bAcc.data.id}/payments`, { payments: [{ methodId: aPix.id, amountCents: 100 }] }],
    ['POST', '/api/stock/count', { items: [{ productId: aDrink.id, qty: 0 }], reason: R }],
    ['POST', '/api/expenses', { description: 'x', categoryId: aCats[0].id, amountCents: 100 }],
    ['POST', '/api/products', { categoryId: aCat.id, name: 'Produto invasor', priceCents: 100, sendsToKitchen: false, groups: [] }],
    ['POST', '/api/accounts', { customerId: aCustomerId, items: [{ productId: bDrink.id, quantity: 1 }] }],
  ];
  for (const [m, p, b] of ataques) {
    for (const cli of [bAdm, bCx]) {
      const r = await cli.req(m, p, b);
      // contagem em lote ignora produtos que não existem para quem pede: 200 com 0 alterados = sem efeito
      const semEfeito = p === '/api/stock/count' && r.status === 200 && r.data?.changed === 0;
      const vazou = (r.status < 300 && !semEfeito) || r.text.includes(MARCA);
      check(`${cli === bAdm ? 'admin' : 'caixa'} da Beta ${m} ${p} → bloqueado (${r.status})`, !vazou, r.text.slice(0, 160));
    }
  }
  const depois = await snapshot(sys, ids.alfa);
  const mudou = Object.keys(antes).filter((k) => antes[k] !== depois[k]);
  check('Impressão digital dos dados da Alfa IDÊNTICA depois de todos os ataques (16 tabelas)', mudou.length === 0, mudou);
  check('Alfa continua vendo a própria conta intacta', (await aCx.get(`/api/accounts/${aAcc.data.id}`)).data.customerName === MARCA);

  console.log('\n[5] Direto no banco, com o papel da aplicação (como se houvesse um erro no código)');
  const app = new pg.Client({ connectionString: DB_URL, options: '-c role=oneup_app' }); await app.connect();
  const q = async (s: string, p: unknown[] = []) => { try { return { ok: true, r: await app.query(s, p) }; } catch (e) { return { ok: false, err: (e as Error).message }; } };
  let r = await q('SELECT count(*)::int AS n FROM accounts');
  check('Sem empresa no contexto: nenhuma linha visível', r.ok && r.r!.rows[0].n === 0, r);
  r = await q("INSERT INTO customers (name) VALUES ('sem empresa')");
  check('Sem empresa no contexto: inserir é recusado', !r.ok, r);
  await app.query("SELECT set_config('app.empresa_id', $1, false)", [String(ids.beta)]);
  r = await q('SELECT count(*)::int AS n FROM accounts WHERE empresa_id = $1', [ids.alfa]);
  check('Contexto Beta: SELECT pedindo explicitamente a Alfa devolve 0', r.ok && r.r!.rows[0].n === 0, r);
  r = await q("UPDATE accounts SET note = 'x' WHERE id = $1", [aAcc.data.id]);
  check('Contexto Beta: UPDATE numa conta da Alfa altera 0 linhas', r.ok && r.r!.rowCount === 0, r);
  r = await q('DELETE FROM sessions WHERE empresa_id = $1', [ids.alfa]);
  check('Contexto Beta: DELETE nas sessões da Alfa apaga 0 linhas', r.ok && r.r!.rowCount === 0, r);
  r = await q("INSERT INTO customers (name, empresa_id) VALUES ('injetado', $1)", [ids.alfa]);
  check('Contexto Beta: inserir registro marcado como da Alfa é recusado pelo banco', !r.ok, r);
  r = await q('UPDATE accounts SET empresa_id = $1 WHERE id = $2', [ids.alfa, bAcc.data.id]);
  check('Contexto Beta: "mover" conta da Beta para a Alfa é recusado', !r.ok, r);
  r = await q("INSERT INTO empresas (slug, nome) VALUES ('hack','hack')");
  check('Aplicação não cria empresa', !r.ok, r);
  r = await q('SELECT count(*)::int AS n FROM empresas');
  check('Aplicação só enxerga a própria empresa no cadastro', r.ok && r.r!.rows[0].n === 1, r);
  r = await q('RESET ROLE');
  r = await q('SELECT count(*)::int AS n FROM accounts WHERE empresa_id = $1', [ids.alfa]);
  check('RESET ROLE não escapa do isolamento', r.ok && r.r!.rows[0].n === 0, r);
  await app.end();

  [aSockK, bSockK, bSockC, bSockA].forEach((s) => s.close());
  await sys.end();
  console.log(`\nResultado isolamento: ${passed} verificações OK, ${failures.length} falhas.`);
  if (failures.length) { console.log('Falhas:\n - ' + failures.join('\n - ')); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
