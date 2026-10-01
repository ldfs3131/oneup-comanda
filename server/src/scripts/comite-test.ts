/**
 * COMITÊ DE TESTES — cada falha encontrada pelos revisores vira um teste que não pode voltar.
 * Roda no banco de duas empresas (alfa e beta) com EMPRESA_HEADER=true (veja testes.sh).
 *   BASE_URL=http://localhost:3200 DATABASE_URL=... node dist/scripts/comite-test.js
 */
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const BASE = process.env.BASE_URL ?? 'http://localhost:3200';
const DB_URL = process.env.DATABASE_URL!;
let passed = 0;
const failures: string[] = [];
function check(label: string, cond: unknown, extra?: unknown) {
  if (cond) { passed++; console.log(`  ✔ ${label}`); } else { failures.push(label); console.log(`  ✘ ${label}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400)); }
}

class C {
  cookie = '';
  constructor(public empresa: string, public extra: Record<string, string> = {}) {}
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const t0 = performance.now();
    const res = await fetch(BASE + path, {
      method,
      headers: { 'x-empresa': this.empresa, ...this.extra, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, headers: res.headers, ms: performance.now() - t0 };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b: unknown = {}, h?: Record<string, string>) => this.req('POST', p, b, h);
  patch = (p: string, b: unknown) => this.req('PATCH', p, b);
  async login(u: string, p: string) { const r = await this.post('/api/auth/login', { username: u, password: p }); if (r.status !== 200) throw new Error(`login ${u}: ${r.status} ${JSON.stringify(r.data)}`); return this; }
}

async function main() {
  const db = new pg.Client({ connectionString: DB_URL }); await db.connect();
  const dono = await new C('alfa').login('admin', 'alfa-admin');
  const caixa = await new C('alfa').login('caixa', 'alfa-caixa');
  // mais caixas para concorrência
  const users = (await dono.get('/api/users')).data as { username: string }[];
  for (const u of ['cx2', 'cx3', 'limite1', 'senha1']) {
    if (!users.some((x) => x.username === u)) await dono.post('/api/users', { name: `Teste ${u}`, username: u, password: 'segredo123', role: 'CAIXA' });
  }
  const cx2 = await new C('alfa').login('cx2', 'segredo123');
  const cx3 = await new C('alfa').login('cx3', 'segredo123');
  await dono.patch('/api/configuracoes', { valores: { cardapio_digital_ligado: true } });
  const reg0 = (await caixa.get('/api/register/current')).data;
  if (!reg0.register) await caixa.post('/api/register/open', { openingCashCents: 10000 });
  await caixa.post('/api/day/establishment', { isOpen: true });
  const menu = (await dono.get('/api/menu?all=1')).data as any[];
  const simples = menu.flatMap((c) => c.products).filter((p: any) => p.active && !p.trackStock && !p.groups.some((g: any) => g.required) && p.priceCents > 0);
  const P = simples[0], P2 = simples[1];
  const metodos = (await caixa.get('/api/payment-methods')).data as any[];
  const PIX = metodos.find((m) => m.code === 'PIX').id;
  const novaConta = async (c: C = caixa, itens = [{ productId: P.id, quantity: 1 }]) => (await c.post('/api/accounts', { customerName: 'Comitê', items: itens })).data;

  console.log('\n[1] Pagamento no exato momento do fechamento do caixa entra no resumo (ou é recusado)');
  {
    const difs: unknown[] = []; let e500 = 0; let fechou = 0;
    for (let rodada = 0; rodada < 6; rodada++) {
      const contas: any[] = []; for (let i = 0; i < 40; i++) contas.push(await novaConta([caixa, cx2, cx3][i % 3]));
      const atual = (await dono.get('/api/register/current')).data;
      const espera = [0, 5, 10, 15, 25, 35][rodada];
      const pagar = contas.map((a, i) => (i % 3 === 0 ? caixa : i % 3 === 1 ? cx2 : cx3).post(`/api/accounts/${a.id}/payments`, { payments: [{ methodId: PIX, amountCents: Math.floor(P.priceCents / 2) }] }));
      const pedidos = contas.slice(0, 10).map((a) => cx2.post(`/api/accounts/${a.id}/orders`, { items: [{ productId: P2.id, quantity: 1 }] }));
      await new Promise((r) => setTimeout(r, espera));
      const fech = dono.post('/api/register/close', { countedCashCents: atual.summary.expectedCashCents });
      const res = await Promise.all([...pagar, ...pedidos, fech]);
      const f = res[res.length - 1];
      if (f.status === 200) fechou++;
      e500 += res.filter((r) => r.status >= 500).length;
      const [linha] = (await db.query(`SELECT (summary->>'receivedCents')::int AS resumo, (summary->>'salesCents')::int AS vendas,
        (SELECT COALESCE(SUM(amount_cents),0)::int FROM payments WHERE cash_register_id=$1 AND reversed_at IS NULL) AS banco,
        (SELECT COALESCE(SUM(oi.unit_price_cents*oi.quantity),0)::int FROM orders o JOIN order_items oi ON oi.order_id=o.id WHERE o.cash_register_id=$1 AND oi.status='ACTIVE' AND o.status<>'AWAITING_CONFIRMATION') AS banco_vendas
        FROM cash_registers WHERE id=$1`, [f.data?.id])).rows;
      if (!linha || linha.resumo !== linha.banco || linha.vendas !== linha.banco_vendas) difs.push({ rodada, ...linha });
      await caixa.post('/api/register/open', { openingCashCents: 10000 });
    }
    check('6 fechamentos com pagamentos e pedidos chegando ao mesmo tempo concluídos', fechou === 6, fechou);
    check('Resumo do fechamento = o que ficou gravado no caixa, em todas as rodadas (recebido e vendas)', difs.length === 0, difs);
    check('Ninguém recebeu "erro interno" (quem chegou depois recebeu "dia não aberto")', e500 === 0, e500);
  }

  console.log('\n[2] Duas pessoas mexendo na mesma conta ao mesmo tempo: sem "erro interno"');
  {
    let e500 = 0; const exemplos: unknown[] = [];
    for (let rodada = 0; rodada < 12; rodada++) {
      const a = await novaConta(caixa, [{ productId: P.id, quantity: 2 }, { productId: P2.id, quantity: 1 }]);
      const b = await novaConta(cx2);
      const det = (await caixa.get(`/api/accounts/${a.id}`)).data;
      const ordem = det.orders[0]; const item = ordem.items[0];
      const ops = rodada % 4 === 0
        ? [caixa.post(`/api/orders/${ordem.id}/transfer`, { targetAccountId: b.id }), cx2.post(`/api/order-items/${item.id}/cancel`, { reason: 'Teste do comitê' })]
        : rodada % 4 === 1
          ? [caixa.post(`/api/accounts/${a.id}/merge`, { targetId: b.id }), cx2.post(`/api/orders/${ordem.id}/cancel`, { reason: 'Teste do comitê' })]
          : rodada % 4 === 2
            ? [caixa.post(`/api/orders/${ordem.id}/cancel`, { reason: 'Teste do comitê' }), cx2.post(`/api/order-items/${item.id}/cancel`, { reason: 'Teste do comitê' })]
            : [dono.post(`/api/accounts/${a.id}/cancel`, { reason: 'Teste do comitê' }), cx2.post(`/api/order-items/${item.id}/cancel`, { reason: 'Teste do comitê' }), cx3.post(`/api/accounts/${a.id}/payments`, { payments: [{ methodId: PIX, amountCents: 100 }] })];
      for (const r of await Promise.all(ops)) if (r.status >= 500) { e500++; exemplos.push(r.data); }
    }
    check('Transferir/juntar/cancelar/pagar ao mesmo tempo: nenhuma resposta 500', e500 === 0, { e500, exemplos: exemplos.slice(0, 3) });
  }

  console.log('\n[3] Chave anti-duplicidade presa à ação');
  {
    const a = await novaConta();
    const k = randomUUID();
    const p1 = await caixa.post(`/api/accounts/${a.id}/payments`, { payments: [{ methodId: PIX, amountCents: 100 }] }, { 'idempotency-key': k });
    const p2 = await caixa.post(`/api/accounts/${a.id}/orders`, { items: [{ productId: P.id, quantity: 1 }] }, { 'idempotency-key': k });
    check('A mesma chave usada em outra ação é recusada (não devolve a resposta do pagamento)', p1.status === 200 && p2.status === 409, { p1: p1.status, p2: p2.status, d: p2.data });
  }

  console.log('\n[4] Cardápio digital no pico: Wi-Fi compartilhado, duplo toque e casa pausada');
  {
    const pedido = (i: number) => ({ customerName: `Cliente ${i}`, mode: 'LOCAL', location: `Mesa ${i}`, items: [{ productId: P.id, quantity: 1 }] });
    // 25 celulares diferentes no MESMO Wi-Fi (mesmo IP), 1 pedido cada
    const res = await Promise.all(Array.from({ length: 25 }, (_, i) => new C('alfa', { 'x-aparelho': `celular-${i}-${randomUUID().slice(0, 8)}` }).post('/api/public/orders', pedido(i))));
    check('25 clientes no mesmo Wi-Fi conseguem pedir (limite é por aparelho, não por internet)', res.every((r) => r.status === 200), res.filter((r) => r.status !== 200).map((r) => r.data));
    const um = new C('alfa', { 'x-aparelho': `abusado-${randomUUID().slice(0, 8)}` });
    const seq = []; for (let i = 0; i < 8; i++) seq.push((await um.post('/api/public/orders', pedido(100 + i))).status);
    check('O MESMO celular é limitado depois de 6 pedidos em 10 min', seq.filter((s) => s === 200).length === 6 && seq.slice(6).every((s) => s === 429), seq);
    const dup = new C('alfa', { 'x-aparelho': `duplo-${randomUUID().slice(0, 8)}` });
    const k = randomUUID();
    const [d1, d2] = await Promise.all([dup.post('/api/public/orders', pedido(200), { 'idempotency-key': k }), dup.post('/api/public/orders', pedido(200), { 'idempotency-key': k })]);
    const d3 = await dup.post('/api/public/orders', pedido(200), { 'idempotency-key': k });
    const nums = [d1, d2, d3].filter((r) => r.status === 200).map((r) => r.data.orderNumber);
    check('Duplo toque / reenvio do mesmo pedido do celular gera UM pedido só', new Set(nums).size === 1 && nums.length >= 1, [d1, d2, d3].map((r) => [r.status, r.data?.orderNumber]));
    // casa pausada: quem já pediu ainda é confirmado
    const board = (await caixa.get('/api/cashier/board')).data;
    const aguardando = board.awaiting[0];
    await caixa.post('/api/day/establishment', { isOpen: false });
    const conf = await caixa.post(`/api/orders/${aguardando.orderId}/confirm`, {});
    check('Com a casa PAUSADA para pedidos novos, o caixa ainda confirma quem já pediu', conf.status === 200, conf.data);
    await caixa.post('/api/day/establishment', { isOpen: true });
  }

  console.log('\n[5] Senha errada: trava só quem errou, não o restaurante');
  {
    const ip = { 'x-forwarded-for': '203.0.113.9' }; // sem TRUST_PROXY o servidor ignora este cabeçalho: mesmo "aparelho"
    for (let i = 0; i < 8; i++) await new C('alfa', ip).post('/api/auth/login', { username: 'limite1', password: 'errada' });
    const bloq = await new C('alfa', ip).post('/api/auth/login', { username: 'limite1', password: 'segredo123' });
    check('Depois de 8 erros, o mesmo usuário fica bloqueado neste aparelho (mesmo com a senha certa)', bloq.status === 429, bloq.status);
    const outro = await new C('alfa', ip).post('/api/auth/login', { username: 'admin', password: 'alfa-admin' });
    check('O dono, no MESMO aparelho, continua entrando normalmente', outro.status === 200, outro.data);
    const t = async (u: string) => { const l: number[] = []; for (let i = 0; i < 3; i++) l.push((await new C('alfa').post('/api/auth/login', { username: u, password: 'x-errada' })).ms); return l.reduce((s, x) => s + x, 0) / l.length; };
    const tNao = await t('nao-existe-ninguem'), tSim = await t('cx3');
    check(`Tempo de resposta não revela se o login existe (inexistente ${Math.round(tNao)} ms × existente ${Math.round(tSim)} ms)`, tNao > tSim * 0.5, { tNao, tSim });
  }

  console.log('\n[6] Trocar senha derruba os outros aparelhos');
  {
    const a = await new C('alfa').login('senha1', 'segredo123');
    const b = await new C('alfa').login('senha1', 'segredo123');
    check('Dois aparelhos logados', (await a.get('/api/auth/me')).status === 200 && (await b.get('/api/auth/me')).status === 200);
    const tr = await a.post('/api/auth/password', { current: 'segredo123', next: 'nova-senha-456' });
    check('Troca de senha aceita', tr.status === 200, tr.data);
    check('O aparelho que trocou continua dentro', (await a.get('/api/auth/me')).status === 200);
    check('O OUTRO aparelho (senha antiga) é desconectado na hora', (await b.get('/api/auth/me')).status === 401);
    const lista = (await dono.get('/api/users')).data as any[];
    const id = lista.find((u) => u.username === 'senha1').id;
    await dono.patch(`/api/users/${id}`, { password: 'redefinida-789' });
    check('Senha redefinida pelo dono desconecta a pessoa em todos os aparelhos', (await a.get('/api/auth/me')).status === 401);
    const c = await new C('alfa').login('senha1', 'redefinida-789');
    await dono.patch(`/api/users/${id}`, { active: false });
    check('Pessoa desativada sai na hora', (await c.get('/api/auth/me')).status === 401);
  }

  console.log('\n[7] Telas iguais recebem a mesma resposta, e nunca uma resposta velha');
  {
    await caixa.get('/api/cashier/board');
    const b2 = await cx2.get('/api/cashier/board');
    check('Segundo caixa recebe a resposta já calculada', b2.headers.get('x-resposta') === 'compartilhada', b2.headers.get('x-resposta'));
    const nova = await novaConta(cx3);
    const b3 = await cx2.get('/api/cashier/board');
    check('Logo depois de abrir uma conta, o painel já mostra a conta nova (não usa resposta antiga)', b3.data.accounts.some((a: any) => a.id === nova.id) && b3.headers.get('x-resposta') !== 'compartilhada');
    const pm1 = await new C('alfa').get('/api/public/menu');
    const prodPub = pm1.data.categories.flatMap((c: any) => c.products)[0];
    await dono.patch(`/api/products/${prodPub.id}/availability`, { available: false });
    const pm2 = await new C('alfa').get('/api/public/menu');
    check('Produto marcado como "acabou" some do cardápio do cliente na hora', !pm2.data.categories.flatMap((c: any) => c.products).some((p: any) => p.id === prodPub.id));
    await dono.patch(`/api/products/${prodPub.id}/availability`, { available: true });
    const pmB = await new C('beta').get('/api/public/menu');
    check('A resposta compartilhada nunca passa para outra empresa', pmB.status === 200 && JSON.stringify(pmB.data) !== JSON.stringify(pm2.data));
    const kz = await new C('alfa').login('cozinha', 'alfa-coz');
    check('Cozinha não recebe o painel do caixa guardado (perfil conferido antes)', (await kz.get('/api/cashier/board')).status === 403);
  }

  console.log('\n[8] Cabeçalhos de proteção e informação pública');
  {
    const r = await new C('alfa').get('/api/meta');
    check('Versão do sistema não aparece sem login', r.data.version === undefined, r.data);
    const csp = r.headers.get('content-security-policy') ?? '';
    check('Página só executa código do próprio sistema (Content-Security-Policy)', csp.includes("script-src 'self'") && csp.includes("object-src 'none'"), csp);
  }

  await db.end();
  console.log(`\nResultado comitê: ${passed} verificações OK, ${failures.length} falhas.`);
  if (failures.length) { console.log(failures.map((f) => ' - ' + f).join('\n')); process.exitCode = 1; }
}
main().catch((e) => { console.error(e); process.exit(1); });
