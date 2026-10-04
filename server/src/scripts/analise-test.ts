/**
 * CENTRAL DE ANÁLISE (Relatório Mensal ONE UP) — testes.
 * Sozinho: recria o banco `ag_analise`, cria a empresa "ana" (cardápio de exemplo), grava 4 meses de dados sintéticos
 * por SQL, sobe o servidor na porta 3501 (com "hoje" fixo em 25/09/2026) e confere detectores, seções, nota, dinheiro na
 * mesa, fluxo do relatório e que Dono, Caixa e Cozinha NÃO enxergam nada.
 *   cd server && npx tsc -p tsconfig.json && node dist/scripts/analise-test.js
 *   (PG=postgres://postgres:postgres@localhost:5432 por padrão)
 */
import pg from 'pg';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PG = process.env.PG ?? 'postgres://postgres:postgres@localhost:5432';
const DB_URL = `${PG}/ag_analise`;
process.env.DATABASE_URL = DB_URL; // o pool do servidor (importado abaixo) usa este banco
const PORT = 3501;
const BASE = `http://localhost:${PORT}`;
const HOJE = '2026-09-25';
const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

let passed = 0;
const failures: string[] = [];
function check(label: string, cond: unknown, extra?: unknown) {
  if (cond) { passed++; console.log(`  ✔ ${label}`); } else { failures.push(label); console.log(`  ✘ ${label}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 600)); }
}

// ---------- gerador determinístico ----------
let seed = 20260925;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ri = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pick = <T,>(arr: [T, number][]) => { const tot = arr.reduce((s, [, w]) => s + w, 0); let r = rnd() * tot; for (const [v, w] of arr) { r -= w; if (r <= 0) return v; } return arr[arr.length - 1][0]; };
const pad = (x: number) => String(x).padStart(2, '0');
const diasNoMes = (k: string) => new Date(Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)), 0)).getUTCDate();
const ts = (dia: string, min: number) => `${dia} ${pad(Math.floor(min / 60))}:${pad(min % 60)}:00-03`;

class C {
  jar = new Map<string, string>();
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(BASE + path, {
      method, headers: { 'x-empresa': 'ana', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.jar.size ? { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); this.jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    const text = await res.text(); let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, text };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b: unknown = {}) => this.req('POST', p, b);
  put = (p: string, b: unknown) => this.req('PUT', p, b);
  async login(u: string, p: string) { const r = await this.post('/api/auth/login', { username: u, password: p }); if (r.status !== 200) throw new Error(`login ${u}: ${r.status} ${JSON.stringify(r.data)}`); return this; }
}

async function gerarDados(c: pg.Client, EMP: number) {
  const q = (s: string, p: unknown[] = []) => c.query(s, p);
  const one = async (s: string, p: unknown[] = []) => (await q(s, p)).rows[0];
  const uid = (await one(`SELECT id FROM users WHERE empresa_id=$1 AND username='admin'`, [EMP])).id;
  const metodos = (await q(`SELECT id FROM payment_methods WHERE empresa_id=$1 ORDER BY id`, [EMP])).rows.map((r) => r.id);
  const cat = async (nome: string) => (await one(`SELECT id FROM expense_categories WHERE empresa_id=$1 AND name=$2`, [EMP, nome])).id;
  // custos e estoque
  const custos: Record<number, number> = { 1: 800, 2: 1200, 8: 700, 9: 450, 15: 1100, 16: 1300, 24: 1350, 3: 2500, 6: 4200, 25: 300, 56: 600, 59: 250, 35: 250 };
  for (const [id, cst] of Object.entries(custos)) await q(`UPDATE products SET cost_cents=$1 WHERE id=$2 AND empresa_id=$3`, [cst, id, EMP]);
  await q(`UPDATE products SET stock_qty = CASE id WHEN 25 THEN 40 WHEN 56 THEN 60 WHEN 35 THEN 480 ELSE stock_qty END WHERE empresa_id=$1`, [EMP]);
  await q(`UPDATE products SET track_stock = (id IN (25, 56, 35)) WHERE empresa_id=$1`, [EMP]);
  // histórico de custo do Hambúrguer: subiu 50% em agosto, preço igual (custo sem repasse)
  await q(`INSERT INTO product_costs (empresa_id, product_id, cost_cents, user_id, created_at) VALUES ($1,24,900,$2,'2026-06-01 09:00-03'),($1,24,1350,$2,'2026-08-01 09:00-03')`, [EMP, uid]);
  const custoNaData = (pid: number, dia: string) => (pid === 24 ? (dia < '2026-08-01' ? 900 : 1350) : custos[pid] ?? null);
  const preco: Record<number, number> = Object.fromEntries((await q(`SELECT id, price_cents FROM products WHERE empresa_id=$1`, [EMP])).rows.map((r) => [r.id, r.price_cents]));
  const nomes: Record<number, string> = Object.fromEntries((await q(`SELECT id, name FROM products WHERE empresa_id=$1`, [EMP])).rows.map((r) => [r.id, r.name]));
  const cozinha = new Set([1, 2, 3, 6, 8, 9, 15, 16, 24]);
  // clientes (1..8 vinham com frequência e sumiram depois de julho; 1..5 aceitaram ofertas)
  const clientes: number[] = [];
  for (let i = 1; i <= 40; i++) clientes.push((await one(`INSERT INTO customers (empresa_id, name, phone, aceita_ofertas) VALUES ($1,$2,$3,$4) RETURNING id`, [EMP, `Cliente ${i}`, `6199900${pad(i)}00`, i <= 5])).id);

  let numConta = 100000, numPedido = 100000;
  const meses = ['2026-06', '2026-07', '2026-08', '2026-09'];
  const PESOS: [number, number][] = [[8, 6], [9, 4], [1, 3], [2, 2], [15, 3], [16, 2], [24, 4], [3, 0.5], [6, 0.4], [25, 5], [56, 4], [59, 4], [32, 1], [35, 0.2]];
  for (const mes of meses) {
    const ultimo = mes === '2026-09' ? 25 : diasNoMes(mes);
    for (let d = 1; d <= ultimo; d++) {
      const dia = `${mes}-${pad(d)}`;
      const dow = new Date(dia + 'T12:00:00Z').getUTCDay();
      if (dow === 1) continue; // fecha às segundas
      const difCaixa = mes === '2026-09' && [3, 9, 16, 23].includes(d) ? -2000 : 0;
      const reg = (await one(`INSERT INTO cash_registers (empresa_id, status, opened_by, opened_at, opening_cash_cents, closed_by, closed_at, expected_cash_cents, counted_cash_cents, difference_cents)
        VALUES ($1,'CLOSED',$2,$3,10000,$2,$4,10000,$5,$6) RETURNING id`, [EMP, uid, ts(dia, 600), ts(dia, 23 * 60 + 30), 10000 + difCaixa, difCaixa])).id;
      let nPed = dow === 5 || dow === 6 ? 25 : dow === 0 ? 22 : dow === 2 ? 7 : 15;
      if (mes === '2026-09') nPed = Math.round(nPed * 0.75);
      for (let k = 0; k < nPed; k++) {
        const hora = pick<number>([[11, 2], [12, 4], [13, 3], [14, 1], [18, 2], [19, 5], [20, 5], [21, 3], [22, 1]]);
        const criado = hora * 60 + ri(0, 59);
        // cliente: frequentes 1..8 só até julho; 9..40 o tempo todo
        let cli: number | null = null;
        if (rnd() < 0.45) { const i = mes <= '2026-07' ? ri(1, 40) : ri(9, 40); cli = clientes[i - 1]; }
        const itens: { pid: number; qtd: number }[] = [];
        const nItens = ri(1, 3);
        for (let j = 0; j < nItens; j++) { const pid = pick(PESOS); if (!itens.some((x) => x.pid === pid)) itens.push({ pid, qtd: ri(1, 2) }); }
        if (itens.some((x) => x.pid === 24) && !itens.some((x) => x.pid === 25) && rnd() < 0.6) itens.push({ pid: 25, qtd: 1 });
        // Coca-Cola acabou de 10 a 13/09 (ruptura): ninguém conseguiu comprar
        if (dia >= '2026-09-10' && dia <= '2026-09-13') { const i = itens.findIndex((x) => x.pid === 25); if (i >= 0) itens.splice(i, 1); if (!itens.length) itens.push({ pid: 59, qtd: 1 }); }
        const vaiCozinha = itens.some((x) => cozinha.has(x.pid));
        const pico = hora === 19 || hora === 20;
        const tCoz = mes === '2026-09' && k === 0 && d % 5 === 0 ? 70 : pico ? ri(14, 30) : ri(8, 15);
        const total = itens.reduce((s, x) => s + preco[x.pid] * x.qtd, 0);
        const acc = (await one(`INSERT INTO accounts (empresa_id, number, status, origin, customer_id, cash_register_id, opened_by, opened_at, closed_at, closed_by)
          VALUES ($1,$2,'CLOSED',$3,$4,$5,$6,$7,$8,$6) RETURNING id`, [EMP, numConta++, rnd() < 0.15 ? 'QR_CODE' : 'CAIXA', cli, reg, uid, ts(dia, criado), ts(dia, criado + tCoz + 20)])).id;
        const ord = (await one(`INSERT INTO orders (empresa_id, number, account_id, sequence, origin, status, goes_to_kitchen, expected_minutes, cash_register_id, created_by, created_at, confirmed_at, started_at, ready_at, delivered_at)
          VALUES ($1,$2,$3,1,'CAIXA','DELIVERED',$4,15,$5,$6,$7,$7,$8,$9,$10) RETURNING id`,
          [EMP, numPedido++, acc, vaiCozinha, reg, uid, ts(dia, criado), vaiCozinha ? ts(dia, criado + 2) : null, vaiCozinha ? ts(dia, criado + tCoz) : null, ts(dia, criado + tCoz + 3)])).id;
        for (const it of itens) {
          await q(`INSERT INTO order_items (empresa_id, order_id, product_id, product_name, unit_price_cents, quantity, goes_to_kitchen, unit_cost_cents) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [EMP, ord, it.pid, nomes[it.pid], preco[it.pid], it.qtd, cozinha.has(it.pid), custoNaData(it.pid, dia)]);
        }
        // descontos: 1% das contas até agosto; em setembro, 1 em cada 4 contas com 15%
        let desc = 0;
        if ((mes === '2026-09' && rnd() < 0.25) || (mes !== '2026-09' && rnd() < 0.05)) {
          desc = Math.round(total * (mes === '2026-09' ? 0.15 : 0.1));
          await q(`INSERT INTO discounts (empresa_id, account_id, kind, amount_cents, reason, cash_register_id, user_id, created_at) VALUES ($1,$2,'DISCOUNT',$3,'cliente fiel',$4,$5,$6)`, [EMP, acc, desc, reg, uid, ts(dia, criado + tCoz + 10)]);
        }
        await q(`INSERT INTO payments (empresa_id, account_id, method_id, amount_cents, cash_register_id, user_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [EMP, acc, metodos[ri(0, metodos.length - 1)], total - desc, reg, uid, ts(dia, criado + tCoz + 15)]);
      }
      // cancelamentos de comida já em preparo (setembro)
      if (mes === '2026-09' && d % 5 === 2) {
        const acc = (await one(`SELECT id FROM accounts WHERE empresa_id=$1 AND cash_register_id=$2 LIMIT 1`, [EMP, reg])).id;
        await q(`INSERT INTO cancellations (empresa_id, target, account_id, description, amount_cents, quantity, was_in_preparation, reason, cash_register_id, user_id, created_at, status_before, status_after)
          VALUES ($1,'ITEM',$2,'1× Batata Simples',2500,1,true,'cliente desistiu',$3,$4,$5,'Em preparo','Cancelado')`, [EMP, acc, reg, uid, ts(dia, 20 * 60)]);
      }
    }
    // despesas do mês (energia dispara em setembro)
    await q(`INSERT INTO expenses (empresa_id, description, category_id, amount_cents, date, user_id) VALUES ($1,'Folha',$2,600000,$3,$4),($1,'Energia',$5,$6,$3,$4),($1,'Compras',$7,300000,$3,$4)`,
      [EMP, await cat('Funcionários'), `${mes}-05`, uid, await cat('Energia'), mes === '2026-09' ? 130000 : 80000, await cat('Compras')]);
  }

  // ---------- estoque ----------
  const mov = (pid: number, tipo: string, qtd: number, antes: number, depois: number, quando: string, extra: { motivo?: string; custo?: number; forn?: string; faltou?: number } = {}) =>
    q(`INSERT INTO stock_movements (empresa_id, product_id, type, quantity, "before", "after", missing, reason, user_id, unit_cost_cents, fornecedor, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [EMP, pid, tipo, qtd, antes, depois, extra.faltou ?? 0, extra.motivo ?? null, uid, extra.custo ?? null, extra.forn ?? null, quando]);
  // Coca: compras da Distribuidora X subindo 20% (jul→set); Atacadão Y vendeu mais barato em agosto
  await mov(25, 'ENTRADA', 100, 0, 100, '2026-07-01 09:00-03', { custo: 300, forn: 'Distribuidora X' });
  await mov(25, 'ENTRADA', 100, 20, 120, '2026-08-01 09:00-03', { custo: 290, forn: 'Atacadão Y' });
  await mov(25, 'ENTRADA', 100, 30, 130, '2026-08-20 09:00-03', { custo: 330, forn: 'Distribuidora X' });
  await mov(25, 'AJUSTE', -10, 60, 50, '2026-09-05 22:00-03', { motivo: 'vencido' });
  await mov(25, 'AJUSTE', -50, 50, 0, '2026-09-09 22:00-03', { motivo: 'contagem' });   // zera: 10, 11, 12 e 13/09 sem Coca
  await mov(25, 'ENTRADA', 60, 0, 60, '2026-09-14 09:00-03', { custo: 360, forn: 'Distribuidora X' });
  // Heineken: quebras e vendas sem estoque registrado
  await mov(56, 'ENTRADA', 120, 0, 120, '2026-06-01 09:00-03', { custo: 600, forn: 'Cervejaria Z' });
  for (const d of [4, 12, 19]) await mov(56, 'AJUSTE', -6, 60, 54, `2026-09-${pad(d)} 23:00-03`, { motivo: 'quebra' });
  for (const d of [6, 13, 20]) await mov(56, 'DIVERGENCIA', 0, 0, 0, `2026-09-${pad(d)} 21:00-03`, { faltou: 2 });
  // Suco Kapo: comprado em quantidade e quase não sai (capital parado)
  await mov(35, 'ENTRADA', 500, 0, 500, '2026-06-02 09:00-03', { custo: 250, forn: 'Kapo' });

  // ---------- fiado ----------
  const fiado = async (cli: number | null, nome: string, desde: string, prometido: string | null, valorItens: number, status = 'PENDING', fechado: string | null = null) => {
    const acc = (await one(`INSERT INTO accounts (empresa_id, number, status, customer_id, customer_name, opened_by, opened_at, pending_at, pending_by, promised_date, closed_at, closed_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$6,$8,$9,$10) RETURNING id`, [EMP, numConta++, status, cli, nome, uid, `${desde} 20:00-03`, prometido, fechado ? `${fechado} 15:00-03` : null, fechado ? uid : null])).id;
    const ord = (await one(`INSERT INTO orders (empresa_id, number, account_id, sequence, status, goes_to_kitchen, created_by, created_at) VALUES ($1,$2,$3,1,'DELIVERED',false,$4,$5) RETURNING id`, [EMP, numPedido++, acc, uid, `${desde} 19:30-03`])).id;
    await q(`INSERT INTO order_items (empresa_id, order_id, product_id, product_name, unit_price_cents, quantity, goes_to_kitchen, unit_cost_cents) VALUES ($1,$2,59,'Chope 300 ml',$3,1,false,250)`, [EMP, ord, valorItens]);
    if (fechado) {
      const reg = (await one(`SELECT id FROM cash_registers WHERE empresa_id=$1 ORDER BY id LIMIT 1`, [EMP])).id;
      await q(`INSERT INTO payments (empresa_id, account_id, method_id, amount_cents, cash_register_id, user_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [EMP, acc, metodos[0], valorItens, reg, uid, `${fechado} 15:00-03`]);
    }
  };
  await fiado(clientes[20], 'Cliente 21', '2026-06-20', '2026-07-05', 18000);           // antigo (30+ dias)
  await fiado(clientes[21], 'Cliente 22', '2026-07-10', '2026-07-25', 9000);            // antigo
  await fiado(clientes[22], 'Cliente 23', '2026-08-03', '2026-08-15', 6000);            // vencido já em agosto
  await fiado(clientes[23], 'Cliente 24', '2026-09-02', '2026-09-10', 7000);
  await fiado(clientes[24], 'Cliente 25', '2026-09-05', '2026-09-12', 5500);
  await fiado(clientes[25], 'Cliente 26', '2026-09-08', null, 4000);                    // sem data: vence depois de 7 dias
  await fiado(clientes[26], 'Cliente 27', '2026-09-22', '2026-10-05', 3000);            // em dia
  for (let i = 0; i < 6; i++) await fiado(clientes[30 + i], `Cliente ${31 + i}`, `2026-07-${pad(1 + i)}`, null, 5000, 'CLOSED', `2026-07-${pad(22 + i)}`); // pagaram em ~21 dias
}

async function main() {
  // ---------- banco, empresa, usuários e servidor ----------
  const admin = new pg.Client({ connectionString: `${PG}/postgres` }); await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS ag_analise WITH (FORCE)'); await admin.query('CREATE DATABASE ag_analise'); await admin.end();
  const envDb = { ...process.env, DATABASE_URL: DB_URL };
  execFileSync('node', ['dist/scripts/setup.js', '--empresa=ana', '--nome=Ana', '--admin-pass=ana-admin', '--caixa-pass=ana-caixa', '--cozinha-pass=ana-coz', '--cardapio=exemplo'], { cwd: SERVER, env: envDb, stdio: 'ignore' });
  execFileSync('node', ['dist/scripts/plataforma.js', 'oneup-usuario', '--empresa=ana', '--login=oneup', '--nome=ONE UP', '--senha=oneup-senha-1'], { cwd: SERVER, env: envDb, stdio: 'ignore' });
  const pgc = new pg.Client({ connectionString: DB_URL }); await pgc.connect();
  const [{ id: EMP }] = (await pgc.query(`SELECT id FROM empresas WHERE slug='ana'`)).rows;
  console.log('Gerando 4 meses de dados sintéticos…');
  await gerarDados(pgc, EMP);
  const srv = spawn('node', ['dist/index.js'], { cwd: SERVER, env: { ...envDb, EMPRESA_HEADER: 'true', PORT: String(PORT), ONEUP_HOJE: HOJE, NODE_ENV: 'test', LOG_LEVEL: 'error' }, stdio: ['ignore', 'ignore', 'inherit'] });
  const fim = async (code: number) => { srv.kill(); await pgc.end().catch(() => undefined); const { closePools } = await import('../db/index.js'); await closePools(); process.exit(code); };
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* subindo */ } await new Promise((r) => setTimeout(r, 250)); }
    const oneup = await new C().login('oneup', 'oneup-senha-1');
    const dono = await new C().login('admin', 'ana-admin');
    const caixa = await new C().login('caixa', 'ana-caixa');
    const coz = await new C().login('cozinha', 'ana-coz');

    console.log('\n[1] Só a ONE UP: Dono, Caixa e Cozinha recebem 404 em TODAS as rotas novas');
    const rotas: [string, string, unknown?][] = [
      ['GET', '/api/oneup/analise'], ['GET', '/api/oneup/analise?mes=2026-08'], ['GET', '/api/oneup/analise/meses'],
      ['GET', '/api/oneup/analise/relatorio/2026-08'], ['PUT', '/api/oneup/analise/relatorio/2026-08', { parecer: 'x' }],
      ['POST', '/api/oneup/analise/relatorio/2026-08/status', { status: 'REVISAO' }],
      ['GET', '/api/oneup/analise/relatorio/2026-08/whatsapp'], ['GET', '/api/oneup/analise/relatorio/2026-08/roteiro'],
    ];
    for (const [quem, cli] of [['Dono', dono], ['Caixa', caixa], ['Cozinha', coz]] as const) {
      const st = await Promise.all(rotas.map(([m, p, b]) => cli.req(m, p, b)));
      check(`${quem}: 404 nas ${rotas.length} rotas da Central de Análise`, st.every((r) => r.status === 404), st.map((r, i) => `${rotas[i][1]}=${r.status}`));
      check(`${quem}: nenhuma resposta traz campos de análise`, st.every((r) => !/dinheiroNaMesa|gargalos|pilares|achados/.test(r.text)));
    }
    check('Sem login: 401', (await new C().get('/api/oneup/analise')).status === 401);
    const chavesAnalise = /"(dinheiroNaMesa|gargalos|pilares|achados|destravas|tecnicas|cardapio|positivos|negativos|resultadoPlanoAnterior|nota)"/;
    for (const p of ['/api/auth/me', '/api/settings', '/api/dashboard?from=2026-09-01&to=2026-09-25', '/api/finance?from=2026-09-01&to=2026-09-25&ano=1', '/api/finance/ritmo', '/api/pendencias/contagem']) {
      const r = await dono.get(p);
      check(`Dono ${p.split('?')[0]}: sem nenhum campo de análise`, r.status === 200 && !chavesAnalise.test(r.text), r.status);
    }
    const ritmoDono = await dono.get('/api/insights');
    check('Dono: /api/insights continua 404', ritmoDono.status === 404);

    console.log('\n[2] Pacote do mês e detectores (setembro em andamento, até o dia 25)');
    const r9 = await oneup.get('/api/oneup/analise?mes=2026-09');
    check('ONE UP recebe o pacote', r9.status === 200, r9.data);
    const P = r9.data;
    const ach = (id: string) => (P.achados as any[]).filter((a) => a.id === id);
    const det = (id: string) => (P.detectores as any[]).find((d) => d.id === id);
    check('Mês em curso: corte no dia 25', P.emCurso === true && P.diaCorte === 25);
    const m02 = ach('M02').find((a: any) => a.codigo === 'produto:24');
    check('M02 dispara: Hambúrguer com custo +50% e preço igual', !!m02 && /Hambúrguer/.test(m02.frase) && /\+50%/.test(m02.frase), ach('M02'));
    check('M02: impacto em R$/mês com premissa e marcado como estimativa', m02?.impacto?.centsMes > 0 && m02.impacto.estimativa === true && m02.impacto.premissa.length > 10);
    check('M01 dispara: Espeto de Contra-filé vende muito com margem baixa', ach('M01').some((a: any) => /Contra-filé/.test(a.frase)), ach('M01').map((a: any) => a.titulo));
    check('C01 dispara: descontos acima do normal', ach('C01').some((a: any) => a.sentido === 'NEGATIVO'), ach('C01'));
    check('C02 dispara: comida pronta cancelada', ach('C02').length === 1);
    check('C03 dispara: diferença de caixa recorrente', ach('C03').some((a: any) => a.sentido === 'NEGATIVO'));
    check('C05 dispara: Energia +62%', ach('C05').some((a: any) => a.codigo === 'despesa:Energia'), ach('C05'));
    check('V01 dispara: vendas 20%+ abaixo da média de 3 meses', ach('V01').length === 1, det('V01'));
    check('V03 dispara: terças fracas', ach('V03').some((a: any) => a.codigo === 'dia:2'), ach('V03'));
    check('V06 dispara: clientes frequentes que sumiram (com consentimento)', ach('V06').length === 1 && /aceitaram/.test(ach('V06')[0].frase), det('V06'));
    check('O01 dispara: cozinha atrasa no pico', ach('O01').length === 1, det('O01'));
    check('E01 dispara: Coca-Cola zerada 4 dias', ach('E01').some((a: any) => /Coca-Cola lata/.test(a.frase) && /4 dia/.test(a.frase)), ach('E01'));
    check('E02 dispara: capital parado (Suco Kapo)', ach('E02').some((a: any) => /Kapo/.test(a.frase)), det('E02'));
    check('E03 dispara: perdas por motivo (quebra, vencido)', ach('E03').some((a: any) => /quebra/.test(a.frase)), ach('E03'));
    check('E04 dispara: Heineken vendida sem estoque 3×', ach('E04').some((a: any) => /Heineken/.test(a.frase)));
    check('E05 dispara: Distribuidora X subiu e há fornecedor mais barato', ach('E05').some((a: any) => /Distribuidora X/.test(a.frase) && /Atacadão Y/.test(a.frase)), ach('E05'));
    check('F01 dispara: fiado vencido crescendo', ach('F01').some((a: any) => a.sentido === 'NEGATIVO'), det('F01'));
    check('F02 dispara: fiado leva mais de 15 dias para voltar', ach('F02').some((a: any) => a.sentido === 'NEGATIVO'), det('F02'));
    check('F04 dispara: fiado antigo (30+ dias)', ach('F04').length === 1, det('F04'));
    check('M07 dispara: combo Hambúrguer + Coca', ach('M07').some((a: any) => /Hambúrguer/.test(a.titulo) && /Coca/.test(a.titulo)), ach('M07'));
    check('Comparativos neutros com mês anterior e média de 3 meses', (P.achados as any[]).some((a) => a.comparativo && a.id.endsWith('.ANT')) && (P.achados as any[]).some((a) => a.comparativo && a.id.endsWith('.M3')));
    check('Mesmo mês do ano anterior sem dados: nenhum comparativo inventado', !(P.achados as any[]).some((a) => a.id.endsWith('.ANO')));
    check('Todo achado tem frase, número, amostra, confiança e limiar', (P.achados as any[]).every((a) => a.frase && a.numero && a.amostra && ['BAIXA', 'MEDIA', 'ALTA'].includes(a.confianca) && a.limiar));
    check('Todo impacto em R$ tem premissa e é estimativa', (P.achados as any[]).filter((a) => a.impacto).every((a) => a.impacto.estimativa === true && a.impacto.premissa));
    check('Pelo menos 25 detectores avaliados', (P.detectores as any[]).length >= 25, (P.detectores as any[]).length);

    console.log('\n[3] Seções: deduplicação, máximo de 5, nota e dinheiro na mesa');
    const secoes = ['gargalos', 'comparativo', 'positivos', 'negativos'];
    check('Nenhuma seção passa de 5', secoes.every((s) => P[s].length <= 5) && ['CURTO', 'MEDIO', 'LONGO'].every((h) => P.destravas[h].length <= 5) && P.plano.length <= 5);
    const cods = secoes.flatMap((s) => P[s].map((a: any) => a.codigo));
    check('Um fato aparece em uma seção só (códigos únicos entre gargalos, comparativo, positivos e negativos)', new Set(cods).size === cods.length, cods);
    check('Gargalo não se repete como negativo', !P.negativos.some((n: any) => P.gargalos.some((g: any) => g.codigo === n.codigo)));
    check('Há gargalos e eles têm ação', P.gargalos.length >= 3 && P.gargalos.every((g: any) => g.acao));
    check('Nota entre 0 e 100', typeof P.nota.valor === 'number' && P.nota.valor >= 0 && P.nota.valor <= 100, P.nota);
    check('6 pilares, cada nota entre 0 e 100 ou "sem dados" (null)', P.nota.pilares.length === 6 && P.nota.pilares.every((p: any) => p.nota === null || (p.nota >= 0 && p.nota <= 100)) && P.nota.pilares.every((p: any) => p.numero && p.comoSubir));
    check('Pilar com ▲▼ vs mês anterior', P.nota.pilares.some((p: any) => typeof p.variacao === 'number'));
    const somaMesa = P.dinheiroNaMesa.itens.reduce((s: number, i: any) => s + i.considerado, 0);
    check('Dinheiro na mesa = soma dos itens considerados', P.dinheiroNaMesa.lucroMesCents === somaMesa && somaMesa > 0, P.dinheiroNaMesa);
    const grupos = P.dinheiroNaMesa.itens.map((i: any) => i.grupo);
    check('Dinheiro na mesa sem dupla contagem (um item por grupo)', new Set(grupos).size === grupos.length, grupos);
    check('Hambúrguer (M02) e Contra-filé (M01) da mesma categoria? Só o maior entra', P.dinheiroNaMesa.itens.filter((i: any) => i.grupo === 'margem:Espetos').length <= 1);
    check('Dinheiro a recuperar (fiado/estoque) fica fora da soma', P.dinheiroNaMesa.caixaCents > 0 && !P.dinheiroNaMesa.itens.some((i: any) => i.grupo === 'fiado'));
    check('Destravas nos 3 horizontes', P.destravas.CURTO.length > 0 && P.destravas.MEDIO.length > 0);
    check('Técnicas de gestão ligadas a achados, com 2–3 passos', P.tecnicas.length > 0 && P.tecnicas.every((t: any) => t.achados.length > 0 && t.passos.length >= 2 && t.passos.length <= 3));
    check('Plano de 30 dias: semanas 1–4 e meta mensurável', P.plano.length > 0 && P.plano.every((a: any) => a.semana >= 1 && a.semana <= 4 && a.meta));
    check('Engenharia de cardápio com os 4 quadrantes e itens sem custo citados', ['ESTRELA', 'BURRO_DE_CARGA', 'QUEBRA_CABECA', 'ABACAXI'].every((q) => P.cardapio.itens.some((i: any) => i.quadrante === q)) && P.cardapio.semCusto.some((s: any) => /Água sem gás/.test(s.name)), P.cardapio.itens.map((i: any) => `${i.name}:${i.quadrante}`));
    check('Resumo executivo com 3 frases', P.resumo.length === 3 && P.resumo.every((f: string) => f.length > 10));
    check('Previsão do próximo mês com a conta', P.previsao.ok && /média/.test(P.previsao.conta));
    check('Clientes e fiado sem nomes de clientes', !/Cliente \d/.test(JSON.stringify(P.clientesFiado)) && P.clientesFiado.recuperacao.length > 0);
    check('Série de 12 meses: meses sem dados = null (nunca zero)', P.serie12.filter((s: any) => s.receita === null).length >= 8 && !P.serie12.some((s: any) => s.receita === 0));

    console.log('\n[4] Amostra mínima, meses sem dados e confiança nos primeiros meses');
    const { runAsEmpresa, db } = await import('../db/index.js');
    const { pacoteDoMes } = await import('../services/analise.js');
    const cedo = await runAsEmpresa(EMP, () => pacoteDoMes(db, { mes: '2026-06', hoje: '2026-06-03' }));
    check('Começo do uso (2 dias): M02 não aparece', !cedo.achados.some((a) => a.id === 'M02'));
    check('Começo do uso: detectores abaixo da amostra marcados (sem achado)', ['V03', 'M01', 'C01', 'O01'].every((id) => ['AMOSTRA', 'SEM_DADOS', 'NAO_DISPAROU'].includes(cedo.detectores.find((d) => d.id === id)!.status)) && !cedo.achados.some((a) => ['V03', 'C01', 'O01'].includes(a.id)), cedo.detectores.map((d) => `${d.id}:${d.status}`));
    check('Começo do uso: confiança BAIXA declarada', cedo.confianca.nivel === 'BAIXA' && cedo.confianca.primeirosMeses === true);
    check('Começo do uso: sem mês anterior, comparativo vazio e explicado', cedo.comparativo.length === 0 && !!cedo.avisosSecoes.comparativo);
    check('Números do mês anterior = "sem dados" (null), nunca zero', cedo.numeros.every((x) => x.anterior === null));
    check('Pilar de vendas sem base = sem nota (não vale zero)', cedo.nota.pilares.find((p) => p.id === 'vendas')!.nota === null);
    const vazio = await runAsEmpresa(EMP, () => pacoteDoMes(db, { mes: '2026-01', hoje: HOJE }));
    check('Mês sem dados: nota "sem dados" e nenhum achado', vazio.nota.valor === null || vazio.nota.pilares.filter((p) => p.nota != null).length <= 1);
    check('Mês sem dados: receita null', vazio.numeros[0].atual === null && vazio.gargalos.length === 0);
    const julho = await runAsEmpresa(EMP, () => pacoteDoMes(db, { mes: '2026-07', hoje: HOJE }));
    check('Julho (2 meses de base insuficiente para V01): V01 sem dados', julho.detectores.find((d) => d.id === 'V01')!.status === 'SEM_DADOS');
    check('Julho: M02 ainda não (custo só subiu em agosto)', !julho.achados.some((a) => a.id === 'M02'));

    console.log('\n[5] Relatório mensal: parecer, ações, rascunho → revisão → finalizado (congela)');
    const r8 = await oneup.get('/api/oneup/analise/relatorio/2026-08');
    check('Relatório de agosto: rascunho virtual com o plano como ações', r8.status === 200 && r8.data.relatorio.salvo === false && r8.data.relatorio.status === 'RASCUNHO');
    const acoes = (r8.data.pacote.plano as any[]).map((a, i) => ({ ...a, status: i === 0 ? 'FEITO' : 'NAO_FEITO' }));
    check('Agosto tem plano para medir em setembro', acoes.length > 0);
    const sv = await oneup.put('/api/oneup/analise/relatorio/2026-08', { parecer: 'Parecer do consultor: foco em preço.', acoes });
    check('Salva parecer e ações com status', sv.status === 200 && sv.data.relatorio.parecer.startsWith('Parecer') && sv.data.relatorio.acoes[0].status === 'FEITO');
    check('Não pula de rascunho para finalizado', (await oneup.post('/api/oneup/analise/relatorio/2026-08/status', { status: 'FINALIZADO' })).status === 409);
    check('Rascunho → revisão', (await oneup.post('/api/oneup/analise/relatorio/2026-08/status', { status: 'REVISAO' })).status === 200);
    const fin = await oneup.post('/api/oneup/analise/relatorio/2026-08/status', { status: 'FINALIZADO' });
    check('Revisão → finalizado', fin.status === 200, fin.data);
    const antes = (await oneup.get('/api/oneup/analise?mes=2026-08')).data;
    check('Finalizado devolve o retrato congelado', antes.congelado === true && antes.relatorio.status === 'FINALIZADO');
    // venda nova em agosto depois de finalizar: o retrato não muda
    const reg = (await pgc.query(`SELECT id FROM cash_registers WHERE empresa_id=$1 ORDER BY id LIMIT 1`, [EMP])).rows[0].id;
    const acc = (await pgc.query(`INSERT INTO accounts (empresa_id, number, status, opened_at) VALUES ($1, 999999, 'CLOSED', '2026-08-10 12:00-03') RETURNING id`, [EMP])).rows[0].id;
    const ord = (await pgc.query(`INSERT INTO orders (empresa_id, number, account_id, sequence, status, goes_to_kitchen, created_at) VALUES ($1, 999999, $2, 1, 'DELIVERED', false, '2026-08-10 12:00-03') RETURNING id`, [EMP, acc])).rows[0].id;
    await pgc.query(`INSERT INTO order_items (empresa_id, order_id, product_id, product_name, unit_price_cents, quantity, goes_to_kitchen, unit_cost_cents) VALUES ($1,$2,59,'Chope 300 ml',500000,1,false,250)`, [EMP, ord]);
    void reg;
    const depois = (await oneup.get('/api/oneup/analise?mes=2026-08')).data;
    check('Finalizar congela: venda nova não muda o retrato', depois.numeros[0].atual === antes.numeros[0].atual && depois.geradoEm === antes.geradoEm);
    check('Finalizado não aceita mudar parecer (409)', (await oneup.put('/api/oneup/analise/relatorio/2026-08', { parecer: 'outro' })).status === 409);
    check('Finalizado não volta para rascunho (409)', (await oneup.post('/api/oneup/analise/relatorio/2026-08/status', { status: 'RASCUNHO' })).status === 409);
    await oneup.post('/api/oneup/analise/relatorio/2026-09/status', { status: 'REVISAO' });
    check('Mês em andamento não pode ser finalizado', (await oneup.post('/api/oneup/analise/relatorio/2026-09/status', { status: 'FINALIZADO' })).status === 409);
    check('Mês futuro é recusado', (await oneup.get('/api/oneup/analise?mes=2026-11')).status === 400);

    console.log('\n[6] Resultado do plano do mês passado, WhatsApp e roteiro');
    const s9 = (await oneup.get('/api/oneup/analise?mes=2026-09')).data;
    check('Setembro mede o plano de agosto (feito/não feito + efeito)', s9.resultadoPlanoAnterior.existe && s9.resultadoPlanoAnterior.itens.length === acoes.length && s9.resultadoPlanoAnterior.itens[0].status === 'FEITO' && s9.resultadoPlanoAnterior.itens.every((i: any) => i.efeito), s9.resultadoPlanoAnterior);
    const wa = await oneup.get('/api/oneup/analise/relatorio/2026-09/whatsapp');
    const linhas = String(wa.data?.texto ?? '').split('\n');
    check('Resumo WhatsApp: até 10 linhas com nota, dinheiro na mesa e top 3 ações', wa.status === 200 && linhas.length <= 10 && /Nota/.test(wa.data.texto) && /Dinheiro na mesa/.test(wa.data.texto) && /1\. /.test(wa.data.texto), wa.data);
    const rt = await oneup.get('/api/oneup/analise/relatorio/2026-09/roteiro');
    check('Roteiro: por onde começar, número, 3 decisões e objeções', rt.status === 200 && rt.data.comecar && rt.data.numero && rt.data.decisoes.length >= 1 && rt.data.decisoes.length <= 3 && rt.data.objecoes.length >= 1 && /ROTEIRO/.test(rt.data.texto));
    const meses = await oneup.get('/api/oneup/analise/meses');
    check('Lista de meses com a situação do relatório', meses.status === 200 && meses.data.meses.some((m: any) => m.mes === '2026-08' && m.status === 'FINALIZADO'));
  } catch (e) {
    console.error(e); failures.push(`erro: ${(e as Error).message}`);
  }
  console.log(`\nResultado análise: ${passed} verificações OK, ${failures.length} falhas.`);
  if (failures.length) console.log(failures.map((f) => ` - ${f}`).join('\n'));
  await fim(failures.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
