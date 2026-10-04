/**
 * Caixa pronto para uma sexta cheia (3.3): servidor do "Encerrar o dia" com UMA recontagem, contas abertas só com saldo,
 * "encerrar todas as pagas" / "cancelar vazias", pendências antes da contagem, estoque zerado pedindo decisão na 1ª
 * tentativa e a barra de prontos (itens resumidos; problema de dia anterior fora da barra).
 * Cria o próprio banco (ag_caixa) e sobe o próprio servidor na porta 3507.
 *   cd server && npx tsc -p tsconfig.json && node dist/scripts/caixa-test.js
 */
import pg from 'pg';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PG = process.env.PG ?? 'postgres://postgres:postgres@localhost:5432';
const DB_NAME = process.env.CAIXA_DB ?? 'ag_caixa';
const DB_URL = `${PG}/${DB_NAME}`;
const PORT = Number(process.env.PORT_TESTE ?? 3507);
const BASE = `http://localhost:${PORT}`;
const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

let passed = 0;
const failures: string[] = [];
function check(label: string, cond: unknown, extra?: unknown) {
  if (cond) { passed++; console.log(`  ✔ ${label}`); } else { failures.push(label); console.log(`  ✘ ${label}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 700)); }
}

class C {
  cookie = '';
  constructor(public empresa = 'cx', public extra: Record<string, string> = {}) {}
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'x-empresa': this.empresa, ...this.extra, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) if (c.startsWith('oneup_sessao=')) this.cookie = c.split(';')[0];
    const text = await res.text();
    let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b: unknown = {}) => this.req('POST', p, b);
  patch = (p: string, b: unknown) => this.req('PATCH', p, b);
  async login(u: string, p: string) { const r = await this.post('/api/auth/login', { username: u, password: p }); if (r.status !== 200) throw new Error(`login ${u}: ${r.status} ${JSON.stringify(r.data)}`); return this; }
}

let srv: ChildProcess | null = null;
async function subir() {
  srv = spawn('node', ['dist/index.js'], {
    cwd: SERVER,
    env: { ...process.env, DATABASE_URL: DB_URL, EMPRESA_HEADER: 'true', PORT: String(PORT), NODE_ENV: 'test', LOG_LEVEL: 'error', BASE_DOMAIN: '', DEFAULT_EMPRESA: '' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch { /* subindo */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('servidor de teste não subiu');
}
async function parar() {
  if (!srv) return;
  const p = srv; srv = null;
  await new Promise<void>((r) => { p.once('exit', () => r()); p.kill('SIGTERM'); setTimeout(() => { p.kill('SIGKILL'); r(); }, 9000).unref(); });
}

async function main() {
  const adm = new pg.Client({ connectionString: `${PG}/postgres` }); await adm.connect();
  await adm.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`); await adm.query(`CREATE DATABASE ${DB_NAME}`); await adm.end();
  execFileSync('node', ['dist/scripts/setup.js', '--empresa=cx', '--nome=Restaurante Caixa', '--admin-pass=cx-admin', '--caixa-pass=cx-caixa', '--cozinha-pass=cx-coz', '--cardapio=piloto'],
    { cwd: SERVER, env: { ...process.env, DATABASE_URL: DB_URL }, encoding: 'utf8' });
  const db = new pg.Client({ connectionString: DB_URL }); await db.connect();
  const q = async (s: string, p: unknown[] = []) => (await db.query(s, p)).rows as any[];

  await subir();
  const dono = await new C().login('admin', 'cx-admin');
  const caixa = await new C().login('caixa', 'cx-caixa');
  const coz = await new C().login('cozinha', 'cx-coz');

  const menu = (await dono.get('/api/menu?all=1')).data as any[];
  const prods = menu.flatMap((c) => c.products);
  const comida = prods.find((p: any) => p.active && p.sendsToKitchen && !p.trackStock && !p.groups.some((g: any) => g.required) && p.priceCents > 0);
  const bebida = prods.find((p: any) => p.active && p.trackStock && !p.groups?.length);
  const metodos = (await caixa.get('/api/payment-methods')).data as any[];
  const PIX = metodos.find((m) => m.code === 'PIX').id;
  const DIN = metodos.find((m) => m.code === 'DINHEIRO').id;
  check('Cardápio do piloto com comida (cozinha) e bebida com estoque', !!comida && !!bebida, { comida: comida?.name, bebida: bebida?.name });

  check('Abre o dia com R$ 100 na gaveta', (await caixa.post('/api/day/open', { openingCashCents: 10000 })).status === 200);

  // ---------------------------------------------------------------------------------------------
  console.log('\n[1] Estoque zerado: o caixa decide na 1ª tentativa (a venda nunca trava)');
  await dono.post('/api/stock/count', { items: [{ productId: bebida.id, qty: 0 }], reason: 'teste caixa' });
  const estoque = async () => (await q('SELECT stock_qty FROM products WHERE id = $1', [bebida.id]))[0].stock_qty;
  const contas0 = (await q('SELECT COUNT(*)::int AS n FROM accounts'))[0].n;
  const s1 = await caixa.post('/api/accounts', { customerName: 'Estoque', items: [{ productId: bebida.id, quantity: 2 }] });
  check('Nova conta com bebida sem estoque → 409 "Estoque insuficiente" com o que falta', s1.status === 409 && s1.data.code === 'STOCK_INSUFFICIENT'
    && s1.data.details?.[0]?.productId === bebida.id && s1.data.details[0].stock === 0 && s1.data.details[0].requested === 2, s1.data);
  check('…e nada foi lançado (nem conta, nem movimento de estoque)', (await q('SELECT COUNT(*)::int AS n FROM accounts'))[0].n === contas0
    && (await q('SELECT COUNT(*)::int AS n FROM stock_movements WHERE product_id = $1 AND type IN (\'VENDA\',\'DIVERGENCIA\')', [bebida.id]))[0].n === 0);
  const s2 = await caixa.post('/api/accounts', { customerName: 'Estoque', items: [{ productId: bebida.id, quantity: 2 }], stockDecisions: [{ productId: bebida.id, action: 'RELEASE', reason: 'Tinha no freezer' }] });
  const div = (await q(`SELECT * FROM stock_movements WHERE product_id = $1 AND type = 'DIVERGENCIA' ORDER BY id DESC LIMIT 1`, [bebida.id]))[0];
  check('"Liberar": vende, registra a divergência com o motivo e o estoque fica 0', s2.status === 200 && div?.missing === 2 && /freezer/.test(div.reason) && (await estoque()) === 0, { s2: s2.data, div });
  const s3 = await caixa.post(`/api/accounts/${s2.data.id}/orders`, { items: [{ productId: bebida.id, quantity: 1 }] });
  check('Complemento (+1) sem estoque também pergunta antes', s3.status === 409 && s3.data.code === 'STOCK_INSUFFICIENT', s3.data);
  const s4 = await caixa.post(`/api/accounts/${s2.data.id}/orders`, { items: [{ productId: bebida.id, quantity: 1 }], stockDecisions: [{ productId: bebida.id, action: 'CORRECT', newQty: 5 }] });
  check('"Corrigir": contagem 5 → vende 1 → 4', s4.status === 200 && (await estoque()) === 4, s4.data);
  // QR: o cliente pede (casa mostra o produto mesmo sem estoque) e o caixa decide ao confirmar
  await dono.patch('/api/configuracoes', { valores: { cardapio_digital_ligado: true, esconder_sem_estoque: false } });
  await dono.post('/api/stock/count', { items: [{ productId: bebida.id, qty: 0 }], reason: 'teste caixa QR' });
  const pub = new C('cx', { 'x-aparelho': 'celular-caixa-test' });
  const po = await pub.post('/api/public/orders', { customerName: 'Cliente QR', phone: '11987650000', mode: 'LOCAL', location: 'Mesa 9', items: [{ productId: bebida.id, quantity: 1 }] });
  const aguard = ((await caixa.get('/api/cashier/board')).data.awaiting as any[]).find((o) => o.accountId === po.data?.accountId) ?? ((await caixa.get('/api/cashier/board')).data.awaiting as any[])[0];
  if (po.status === 200 && aguard) {
    const c1 = await caixa.post(`/api/orders/${aguard.orderId}/confirm`, {});
    check('Confirmar pedido do QR sem estoque → pergunta (409) e o pedido continua aguardando', c1.status === 409 && c1.data.code === 'STOCK_INSUFFICIENT'
      && (await q('SELECT status FROM orders WHERE id = $1', [aguard.orderId]))[0].status === 'AWAITING_CONFIRMATION', c1.data);
    const c2 = await caixa.post(`/api/orders/${aguard.orderId}/confirm`, { stockDecisions: [{ productId: bebida.id, action: 'RELEASE', reason: 'Contagem atrasada' }] });
    check('…com "liberar" confirma', c2.status === 200, c2.data);
  } else check('Pedido público criado para testar a confirmação', false, po.data);

  // ---------------------------------------------------------------------------------------------
  console.log('\n[2] Barra de prontos: itens resumidos; problema de dia anterior fica fora');
  const k1 = await caixa.post('/api/accounts', { customerName: 'Pronto', tableLabel: '12', items: [{ productId: comida.id, quantity: 2 }] });
  const ko = (await caixa.get(`/api/accounts/${k1.data.id}`)).data.orders[0];
  await coz.post(`/api/kitchen/orders/${ko.id}/start`); await coz.post(`/api/kitchen/orders/${ko.id}/ready`);
  let board = (await caixa.get('/api/cashier/board')).data;
  const pr = (board.ready as any[]).find((r) => r.orderId === ko.id);
  check('Pronto traz os itens resumidos e a mesa', pr && pr.itemsText === `2× ${comida.name}` && pr.tableLabel === '12', pr);
  const k2 = await caixa.post('/api/accounts', { customerName: 'Problema antigo', items: [{ productId: comida.id, quantity: 1 }] });
  const ko2 = (await caixa.get(`/api/accounts/${k2.data.id}`)).data.orders[0];
  await coz.post(`/api/kitchen/orders/${ko2.id}/problem`, { note: 'Acabou o arroz' });
  board = (await caixa.get('/api/cashier/board')).data;
  check('Problema de hoje aparece na barra', (board.ready as any[]).some((r) => r.orderId === ko2.id && r.problemNote));
  await db.query(`UPDATE orders SET created_at = now() - interval '2 days' WHERE id = $1`, [ko2.id]);
  await new Promise((r) => setTimeout(r, 5200)); // resposta do painel é compartilhada por 5 s
  board = (await caixa.get('/api/cashier/board')).data;
  check('Problema de dia anterior NÃO entra na barra', !(board.ready as any[]).some((r) => r.orderId === ko2.id), board.ready);

  // ---------------------------------------------------------------------------------------------
  console.log('\n[3] Antes de contar: pendências do dia e "contas abertas" só com saldo');
  // pagar tudo o que já existe, para começar a conta limpa
  for (const a of (await caixa.get('/api/cashier/board')).data.accounts as any[]) if (a.balance > 0) await caixa.post(`/api/accounts/${a.id}/payments`, { payments: [{ methodId: PIX, amountCents: a.balance }], close: true });
  const comSaldo = await caixa.post('/api/accounts', { customerName: 'Com saldo', tableLabel: '3', items: [{ productId: comida.id, quantity: 1 }] });
  const paga = await caixa.post('/api/accounts', { customerName: 'Paga', items: [{ productId: comida.id, quantity: 1 }] });
  const pagaDet = (await caixa.get(`/api/accounts/${paga.data.id}`)).data;
  await caixa.post(`/api/accounts/${paga.data.id}/payments`, { payments: [{ methodId: DIN, amountCents: pagaDet.totals.balance }], close: false });
  const vazia1 = await caixa.post('/api/accounts', { customerName: 'Vazia um' });
  const vazia2 = await caixa.post('/api/accounts', { tableLabel: '40' });
  const cur = (await caixa.get('/api/register/current')).data;
  const abertasCom = (await q(`SELECT COUNT(*)::int AS n FROM accounts WHERE status IN ('OPEN','PARTIALLY_PAID','PAID')`))[0].n;
  check('"Contas abertas" conta só as com saldo > 0 (paga e vazias não contam)', cur.summary.openAccountsNow >= 1 && cur.summary.openAccountsNow < abertasCom
    && cur.summary.openAccountsNow === (await caixa.get('/api/day/pendencias')).data.comSaldo.length, { n: cur.summary.openAccountsNow, abertasCom });
  const pend = (await caixa.get('/api/day/pendencias')).data;
  check('Pendências: conta com saldo listada (com mesa e saldo)', pend.comSaldo.some((a: any) => a.id === comSaldo.data.id && a.tableLabel === '3' && a.balance > 0), pend.comSaldo);
  check('Pendências: conta paga não encerrada listada', pend.pagas.some((a: any) => a.id === paga.data.id), pend.pagas);
  check('Pendências: contas vazias listadas', [vazia1.data.id, vazia2.data.id].every((id) => pend.vazias.some((a: any) => a.id === id)), pend.vazias);
  check('Pendências: pedidos na cozinha/prontos sem entrega listados', pend.naCozinha.some((o: any) => o.id === ko.id && o.status === 'READY' && o.itemsText) && pend.naCozinha.some((o: any) => o.accountId === comSaldo.data.id), pend.naCozinha);
  check('Pendências: problema em aberto listado (mesmo de dia anterior)', pend.problemas.some((o: any) => o.id === ko2.id && o.problemNote === 'Acabou o arroz'), pend.problemas);
  check('Pendências sem valores do caixa (esperado, recebido, PIX…)', !/expected|received|byMethod|esperado/i.test(JSON.stringify(pend)));
  check('Cozinha não vê as pendências do fechamento', (await coz.get('/api/day/pendencias')).status === 403);

  const ep = await caixa.post('/api/day/encerrar-pagas');
  const stPaga = (await q('SELECT status FROM accounts WHERE id = $1', [paga.data.id]))[0].status;
  check('"Encerrar todas as pagas": encerra a paga', ep.status === 200 && ep.data.encerradas >= 1 && stPaga === 'CLOSED', { ep: ep.data, stPaga });
  check('…e não mexe na conta com saldo', (await q('SELECT status FROM accounts WHERE id = $1', [comSaldo.data.id]))[0].status === 'OPEN');
  const cv = await caixa.post('/api/day/cancelar-vazias');
  const vz = await q('SELECT a.status, c.reason, c.amount_cents FROM accounts a LEFT JOIN cancellations c ON c.account_id = a.id AND c.target = \'ACCOUNT\' WHERE a.id = ANY($1)', [[vazia1.data.id, vazia2.data.id]]);
  check('"Cancelar vazias": cancela as duas com o motivo automático', cv.status === 200 && cv.data.canceladas === 2 && vz.every((r) => r.status === 'CANCELLED' && r.reason === 'Conta vazia no fechamento' && r.amount_cents === 0), { cv: cv.data, vz });
  const aud = ((await dono.get('/api/audit')).data as any[]).map((l) => l.message).join('\n');
  check('Encerrar pagas e cancelar vazias vão para o histórico', /no fechamento do dia/.test(aud) && /Conta vazia no fechamento/.test(aud));
  const pend2 = (await caixa.get('/api/day/pendencias')).data;
  check('Depois: sem pagas nem vazias pendentes', pend2.pagas.length === 0 && pend2.vazias.length === 0, pend2);

  // ---------------------------------------------------------------------------------------------
  console.log('\n[4] Encerrar o dia às cegas com UMA recontagem');
  await caixa.post(`/api/accounts/${comSaldo.data.id}/payments`, { payments: [{ methodId: PIX, amountCents: (await caixa.get(`/api/accounts/${comSaldo.data.id}`)).data.totals.balance }], close: true });
  const esperado = (await dono.get('/api/register/current')).data.summary.expectedCashCents as number;
  const regId = (await dono.get('/api/register/current')).data.register.id as number;
  const r1 = await caixa.post('/api/day/close', { countedCashCents: esperado - 2000 });
  check('1ª contagem com R$ 20 a menos (tolerância R$ 5): "conte de novo"', r1.status === 200 && r1.data.recontar === true, r1.data);
  check('…sem revelar valores (esperado, diferença, contado, resumo)', !['expectedCashCents', 'differenceCents', 'countedCashCents', 'receivedCents', 'summary', 'conferir'].some((k) => k in r1.data), r1.data);
  const regRow = (await q('SELECT status, primeira_contagem_cents FROM cash_registers WHERE id = $1', [regId]))[0];
  check('…o dia NÃO fecha e a 1ª contagem fica gravada', regRow.status === 'OPEN' && regRow.primeira_contagem_cents === esperado - 2000, regRow);
  const cur2 = (await caixa.get('/api/register/current')).data;
  check('Tela do caixa sabe que falta a recontagem (sem valores)', cur2.recontagem === true && cur2.summary.expectedCashCents === null && cur2.summary.primeiraContagemCents === null, { recontagem: cur2.recontagem });
  const r2 = await caixa.post('/api/day/close', { countedCashCents: esperado - 1500 });
  check('2ª contagem fecha o dia mesmo passando da tolerância, com "confira com o responsável"', r2.status === 200 && r2.data.cego === true && r2.data.conferir === true && r2.data.recontado === true, r2.data);
  check('…ainda às cegas (sem esperado nem diferença)', !['expectedCashCents', 'differenceCents', 'receivedCents', 'summary'].some((k) => k in r2.data), r2.data);
  const fech = (await dono.get(`/api/registers/${regId}`)).data;
  check('Dono vê as duas contagens e as duas diferenças no resumo', fech.register.status === 'CLOSED' && fech.summary.primeiraContagemCents === esperado - 2000
    && fech.summary.primeiraDiferencaCents === -2000 && fech.summary.countedCashCents === esperado - 1500 && fech.summary.differenceCents === -1500, fech.summary);
  check('Lista de caixas do Dono traz a 1ª contagem', ((await dono.get('/api/registers')).data as any[]).find((r) => r.id === regId)?.primeiraContagemCents === esperado - 2000);
  const aud2 = ((await dono.get('/api/audit')).data as any[]).filter((l) => l.entityType === 'cash_register' || /contagem/.test(l.message)).map((l) => l.message).join('\n');
  check('Histórico: 1ª contagem (com o pedido de recontagem) e o fechamento com as duas', /fez a 1ª contagem da gaveta/.test(aud2) && /pediu uma recontagem/.test(aud2) && /1ª contagem R\$ .*2ª contagem R\$ /.test(aud2), aud2.slice(0, 600));

  console.log('\n[5] Dentro da tolerância fecha na 1ª; Dono fecha direto vendo tudo');
  await caixa.post('/api/day/open', { openingCashCents: 5000 });
  const r3 = await caixa.post('/api/day/close', { countedCashCents: 5300 });
  check('Diferença de R$ 3 (dentro da tolerância): fecha na 1ª contagem, sem recontagem', r3.status === 200 && !r3.data.recontar && r3.data.conferir === false && r3.data.recontado === false, r3.data);
  await caixa.post('/api/day/open', { openingCashCents: 5000 });
  const r4 = await dono.post('/api/day/close', { countedCashCents: 2000 });
  check('Dono com R$ 30 de diferença: fecha direto e vê esperado e diferença', r4.status === 200 && !r4.data.recontar && r4.data.expectedCashCents === 5000 && r4.data.differenceCents === -3000, r4.data);
  await caixa.post('/api/day/open', { openingCashCents: 5000 });
  const r5 = await caixa.post('/api/day/close', { countedCashCents: 0 });
  check('Caixa: 1ª contagem errada → recontar', r5.data.recontar === true);
  const r6 = await dono.post('/api/day/close', { countedCashCents: 5000 });
  check('Dono pode fechar depois da 1ª contagem do caixa; o resumo guarda a 1ª contagem', r6.status === 200 && r6.data.primeiraContagemCents === 0 && r6.data.differenceCents === 0, r6.data);

  await db.end();
  await parar();
  console.log(`\n${passed} ok, ${failures.length} falha(s)`);
  if (failures.length) { console.log(failures.map((f) => ' - ' + f).join('\n')); process.exit(1); }
}

main().catch(async (e) => { console.error(e); await parar(); process.exit(1); });
