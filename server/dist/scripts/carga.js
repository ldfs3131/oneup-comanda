/**
 * COMITÊ DE TESTES — CARGA E ISOLAMENTO
 *
 * Simula pessoas de verdade usando o sistema ao mesmo tempo (caixas, cozinha, dono e clientes do cardápio
 * digital), com o mesmo comportamento das telas: cada evento em tempo real faz a tela buscar de novo.
 * No fim confere o dinheiro, a numeração, o estoque, o fechamento de caixa e o isolamento entre empresas.
 *
 *   node dist/scripts/carga.js --base=http://localhost:3400 --dominio=carga.local --empresas=r001 \
 *        --caixas=6 --cozinhas=3 --donos=1 --clientes=90 --minutos=3 --ritmo=pico --ips=wifi --pid=<pid do servidor>
 *   (várias empresas: --empresas=r001..r100)
 * Pré-requisito: empresas criadas com setup.js (--cardapio=piloto) e senhas <slug>-admin / <slug>-caixa / <slug>-coz.
 * O nome de cada cliente/conta leva a marca da empresa (ex.: "R037 Mesa 4") para provar que nada vaza.
 */
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';
import pg from 'pg';
const A = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || 'true']; }));
const BASE = new URL(A.base ?? 'http://localhost:3400');
const DOMINIO = A.dominio ?? 'carga.local';
const DB_URL = process.env.DATABASE_URL;
const MINUTOS = Number(A.minutos ?? 3);
const RITMO = (A.ritmo ?? 'pico');
const IPS = (A.ips ?? 'wifi');
const N = { caixas: Number(A.caixas ?? 6), cozinhas: Number(A.cozinhas ?? 3), donos: Number(A.donos ?? 1), clientes: Number(A.clientes ?? 90) };
const SAIDA = A.saida ?? '/tmp/carga-resultado.json';
const slugs = (() => {
    const e = A.empresas ?? 'r001';
    const m = /^([a-z]+)(\d+)\.\.[a-z]+(\d+)$/.exec(e);
    if (!m)
        return e.split(',');
    const w = m[2].length;
    const out = [];
    for (let i = Number(m[2]); i <= Number(m[3]); i++)
        out.push(m[1] + String(i).padStart(w, '0'));
    return out;
})();
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (l) => l[Math.floor(Math.random() * l.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let parar = false;
const fimEm = Date.now() + MINUTOS * 60_000;
// ---------------- medições ----------------
const lat = new Map();
const latRegime = []; // depois do aquecimento (logins e preparação de todas as empresas)
const T0 = Date.now();
const AQUECIMENTO_MS = Number(A.aquecimento ?? 45) * 1000;
const erros = new Map();
let totalReq = 0;
const vazamentos = [];
const eventos = { recebidos: 0, porTipo: new Map() };
const rota = (m, p) => `${m} ${p.split('?')[0].replace(/\/\d+/g, '/:id')}`;
function anotaErro(chave, msg) {
    const e = erros.get(chave) ?? { n: 0, exemplo: msg.slice(0, 160) };
    e.n++;
    erros.set(chave, e);
}
const agent = new http.Agent({ keepAlive: true, maxSockets: 2000 });
class Pessoa {
    slug;
    nome;
    ip;
    cookie = '';
    sock;
    constructor(slug, nome, ip) {
        this.slug = slug;
        this.nome = nome;
        this.ip = ip;
    }
    get host() { return `${this.slug}.${DOMINIO}`; }
    req(method, path, body, extra = {}) {
        const r0 = performance.now();
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const headers = { host: this.host, ...extra };
        if (payload !== undefined) {
            headers['content-type'] = 'application/json';
            headers['content-length'] = String(Buffer.byteLength(payload));
        }
        if (this.cookie)
            headers.cookie = this.cookie;
        if (this.ip)
            headers['x-forwarded-for'] = this.ip;
        totalReq++;
        return new Promise((resolve) => {
            const rq = http.request({ hostname: BASE.hostname, port: BASE.port, path, method, headers, agent, timeout: 30_000 }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const ms = performance.now() - r0;
                    const k = rota(method, path);
                    (lat.get(k) ?? lat.set(k, []).get(k)).push(ms);
                    if (r0 + performance.timeOrigin - T0 > AQUECIMENTO_MS && !parar)
                        latRegime.push(ms);
                    const set = res.headers['set-cookie'];
                    if (set?.length)
                        this.cookie = set[0].split(';')[0];
                    const text = Buffer.concat(chunks).toString();
                    let data = null;
                    try {
                        data = text ? JSON.parse(text) : null;
                    }
                    catch {
                        data = text;
                    }
                    const st = res.statusCode ?? 0;
                    if (st >= 400)
                        anotaErro(`${st} ${k}`, typeof data === 'object' ? (data?.error ?? JSON.stringify(data)) : String(data));
                    // isolamento: nenhuma resposta pode conter a marca de outra empresa
                    if (text && st < 400) {
                        const marcas = text.match(/\bR\d{3}\b/g);
                        if (marcas)
                            for (const mk of new Set(marcas))
                                if (mk !== this.slug.toUpperCase())
                                    vazamentos.push(`${this.slug} recebeu ${mk} em ${k}`);
                    }
                    resolve({ status: st, data });
                });
            });
            rq.on('timeout', () => rq.destroy(new Error('timeout 30 s')));
            rq.on('error', (e) => { anotaErro(`ERRO ${rota(method, path)}`, e.message); resolve({ status: 0, data: { error: e.message } }); });
            if (payload !== undefined)
                rq.write(payload);
            rq.end();
        });
    }
    get = (p) => this.req('GET', p);
    post = (p, b = {}, h) => this.req('POST', p, b, h);
    async login(username, password) {
        const r = await this.post('/api/auth/login', { username, password });
        if (r.status !== 200)
            throw new Error(`${this.slug}/${username}: login ${r.status} ${JSON.stringify(r.data)}`);
    }
    conectar(onEvento) {
        return new Promise((resolve, reject) => {
            const s = io(`${BASE.protocol}//${this.host}:${BASE.port}`, { extraHeaders: { cookie: this.cookie }, transports: ['websocket'], reconnectionDelayMax: 4000 });
            this.sock = s;
            const t = setTimeout(() => reject(new Error(`${this.slug} ${this.nome}: tempo real não conectou`)), 15_000);
            s.on('connect', () => { clearTimeout(t); resolve(); });
            s.on('connect_error', (e) => anotaErro('SOCKET connect_error', e.message));
            s.onAny((ev, p) => {
                eventos.recebidos++;
                eventos.porTipo.set(ev, (eventos.porTipo.get(ev) ?? 0) + 1);
                const txt = JSON.stringify(p ?? '');
                const marcas = txt.match(/\bR\d{3}\b/g);
                if (marcas)
                    for (const mk of new Set(marcas))
                        if (mk !== this.slug.toUpperCase())
                            vazamentos.push(`${this.slug} recebeu ${mk} no evento ${ev}`);
                onEvento(ev, p);
            });
        });
    }
}
/** Igual ao react-query: uma busca por vez; eventos no meio marcam "buscar de novo" ao terminar. */
function buscador(fn, atrasoMs = 300) {
    let rodando = false, sujo = false, agendado = false;
    const executar = async () => {
        agendado = false;
        if (parar)
            return;
        if (rodando) {
            sujo = true;
            return;
        }
        rodando = true;
        try {
            do {
                sujo = false;
                await fn();
            } while (sujo && !parar);
        }
        finally {
            rodando = false;
        }
    };
    // como as telas: junta os avisos que chegam em sequência (0,3 s) e busca uma vez
    return () => { if (!agendado) {
        agendado = true;
        setTimeout(executar, atrasoMs);
    } };
}
function itensAleatorios(prods, max = 4) {
    const n = 1 + Math.floor(Math.random() * max);
    return Array.from({ length: n }, () => {
        const p = pick(prods);
        const optionIds = p.groups.filter((g) => g.required).map((g) => (g.options.find((o) => o.available !== false) ?? g.options[0]).id);
        return { productId: p.id, quantity: 1 + Math.floor(Math.random() * 2), optionIds };
    });
}
// ---------------- uma empresa ----------------
async function empresa(slug, idx) {
    const M = slug.toUpperCase();
    const pausa = (a, b) => sleep(RITMO === 'pico' ? rnd(a, b) : rnd(a * 4, b * 4));
    const admin = new Pessoa(slug, 'dono-prep');
    await admin.login('admin', `${slug}-admin`);
    await admin.req('PATCH', '/api/configuracoes', { valores: { cardapio_digital_ligado: true } });
    const users = (await admin.get('/api/users')).data;
    const garantir = async (username, role, pass) => {
        if (!users.some((u) => u.username === username))
            await admin.post('/api/users', { name: `${role} ${username}`, username, password: pass, role });
    };
    for (let i = 2; i <= N.caixas; i++)
        await garantir(`caixa${i}`, 'CAIXA', `${slug}-caixa`);
    for (let i = 2; i <= N.cozinhas; i++)
        await garantir(`cozinha${i}`, 'COZINHA', `${slug}-coz`);
    const menu = (await admin.get('/api/menu?all=1')).data;
    const todos = menu.flatMap((c) => c.products).filter((p) => p.active && p.available !== false);
    for (const p of todos.filter((x) => x.trackStock))
        await admin.post(`/api/stock/${p.id}`, { type: 'ENTRADA', quantity: 50000, reason: 'Carga de teste' });
    const prods = todos;
    const login = async (nome, user, pass, ip) => { const p = new Pessoa(slug, nome, ip); await p.login(user, pass); return p; };
    const caixas = await Promise.all(Array.from({ length: N.caixas }, (_, i) => login(`caixa${i + 1}`, i === 0 ? 'caixa' : `caixa${i + 1}`, `${slug}-caixa`)));
    const cozinhas = await Promise.all(Array.from({ length: N.cozinhas }, (_, i) => login(`cozinha${i + 1}`, i === 0 ? 'cozinha' : `cozinha${i + 1}`, `${slug}-coz`)));
    const donos = await Promise.all(Array.from({ length: N.donos }, (_, i) => login(`dono${i + 1}`, 'admin', `${slug}-admin`)));
    const reg = (await caixas[0].get('/api/register/current')).data;
    if (!reg.register) {
        const r = await caixas[0].post('/api/register/open', { openingCashCents: 20000 });
        if (r.status !== 200)
            throw new Error(`${slug}: abrir caixa ${r.status} ${JSON.stringify(r.data)}`);
    }
    const metodos = (await caixas[0].get('/api/payment-methods')).data;
    const MID = (c) => metodos.find((m) => m.code === c).id;
    // ---- Caixas ----
    const minhasContas = caixas.map(() => new Set());
    const tarefasCaixa = caixas.map(async (cx, ci) => {
        const contas = minhasContas[ci];
        const emAndamento = new Set();
        const atualizarBoard = buscador(async () => {
            const b = (await cx.get('/api/cashier/board')).data;
            if (!b?.awaiting)
                return;
            for (const q of b.awaiting) {
                if (q.orderId % caixas.length !== ci || emAndamento.has(q.orderId))
                    continue;
                emAndamento.add(q.orderId);
                void (async () => {
                    await pausa(500, 2500);
                    const r = await cx.post(`/api/orders/${q.orderId}/confirm`, {});
                    if (r.status === 200)
                        contas.add(q.accountId);
                })();
            }
        });
        const atualizarMenu = buscador(async () => { await cx.get('/api/menu'); });
        await cx.conectar((ev, p) => {
            if (ev === 'menu:changed')
                void atualizarMenu();
            if (['orders:changed', 'accounts:changed', 'register:changed', 'qr:new'].includes(ev))
                void atualizarBoard();
            if (ev === 'order:ready' && p?.orderId % caixas.length === ci)
                void (async () => { await pausa(1000, 4000); await cx.post(`/api/orders/${p.orderId}/deliver`, {}); })();
        });
        const timer = setInterval(() => void atualizarBoard(), 20_000);
        let k = 0;
        while (Date.now() < fimEm) {
            await pausa(800, 2500);
            const roll = Math.random();
            if (roll < 0.5 || contas.size === 0) {
                const r = await cx.post('/api/accounts', { customerName: `${M} Mesa ${ci}-${++k}`, items: itensAleatorios(prods) }, { 'idempotency-key': randomUUID() });
                if (r.status === 200)
                    contas.add(r.data.id);
            }
            else if (roll < 0.65) {
                const id = pick([...contas]);
                await cx.post(`/api/accounts/${id}/orders`, { items: itensAleatorios(prods, 2) }, { 'idempotency-key': randomUUID() });
            }
            else {
                const id = pick([...contas]);
                await pagar(cx, id);
                contas.delete(id);
            }
        }
        clearInterval(timer);
    });
    async function pagar(cx, id) {
        const d = await cx.get(`/api/accounts/${id}`);
        const saldo = d.data?.totals?.balance;
        if (!(saldo > 0)) {
            if (d.data?.status === 'PAID')
                await cx.post(`/api/accounts/${id}/close`, {});
            return;
        }
        const forma = Math.random();
        const payments = forma < 0.35 ? [{ methodId: MID('PIX'), amountCents: saldo }]
            : forma < 0.65 ? [{ methodId: MID('CARTAO'), amountCents: saldo }]
                : forma < 0.85 ? [{ methodId: MID('DINHEIRO'), amountCents: saldo, tenderedCents: Math.ceil(saldo / 5000) * 5000 }]
                    : [{ methodId: MID('PIX'), amountCents: Math.floor(saldo / 2) }, { methodId: MID('CARTAO'), amountCents: saldo - Math.floor(saldo / 2) }];
        await cx.post(`/api/accounts/${id}/payments`, { payments, close: true }, { 'idempotency-key': randomUUID() });
    }
    // ---- Cozinha ----
    const tarefasCozinha = cozinhas.map(async (kz, ki) => {
        const vistos = new Set();
        const atualizar = buscador(async () => {
            const lista = (await kz.get('/api/kitchen/orders')).data;
            if (!Array.isArray(lista))
                return;
            for (const o of lista) {
                if (o.status !== 'CONFIRMED' || o.id % cozinhas.length !== ki || vistos.has(o.id))
                    continue;
                vistos.add(o.id);
                void (async () => {
                    await pausa(2000, 8000);
                    await kz.post(`/api/kitchen/orders/${o.id}/start`, {});
                    await pausa(3000, 12000);
                    await kz.post(`/api/kitchen/orders/${o.id}/ready`, {});
                })();
            }
        });
        await kz.conectar((ev) => { if (ev === 'kitchen:new' || ev === 'orders:changed')
            void atualizar(); });
        const timer = setInterval(() => void atualizar(), 15_000);
        while (Date.now() < fimEm)
            await sleep(1000);
        clearInterval(timer);
    });
    // ---- Dono no painel (atualiza a cada evento, como a tela faz hoje) ----
    const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    const tarefasDono = donos.map(async (dn) => {
        const painel = buscador(async () => { await dn.get(`/api/dashboard?from=${hoje}&to=${hoje}`); });
        let ultimo = 0; // a tela atualiza o painel por aviso no máximo a cada 30 s
        await dn.conectar((ev) => { if ((ev === 'orders:changed' || ev === 'accounts:changed') && Date.now() - ultimo > 30_000) {
            ultimo = Date.now();
            void painel();
        } });
        const t1 = setInterval(() => void painel(), 60_000);
        const t2 = setInterval(() => void dn.get(`/api/finance?from=${hoje}&to=${hoje}`), 45_000);
        const t3 = setInterval(() => void dn.get('/api/register/current'), 30_000);
        void painel();
        while (Date.now() < fimEm)
            await sleep(1000);
        clearInterval(t1);
        clearInterval(t2);
        clearInterval(t3);
    });
    // ---- Clientes do cardápio digital ----
    let pedidosQr = 0, recusadosQr = 0;
    const tarefasClientes = Array.from({ length: N.clientes }, async (_, ci) => {
        const ip = IPS === '4g' ? `100.${64 + (idx % 60)}.${Math.floor(ci / 250)}.${(ci % 250) + 1}` : undefined;
        const cl = new Pessoa(slug, `cliente${ci}`, ip);
        await sleep(rnd(0, 10_000));
        const m = await cl.get('/api/public/menu');
        const cats = (m.data?.categories ?? []);
        const ps = cats.flatMap((c) => c.products);
        const quando = [Date.now() + rnd(5_000, MINUTOS * 60_000 * 0.8)];
        if (Math.random() < 0.3)
            quando.push(quando[0] + rnd(20_000, 60_000));
        let proxMenu = Date.now() + 60_000;
        const aparelho = `cel-${idx}-${ci}-${randomUUID().slice(0, 8)}`;
        while (Date.now() < fimEm) {
            await sleep(500);
            if (Date.now() >= proxMenu) {
                proxMenu += 60_000;
                await cl.get('/api/public/menu');
            }
            if (quando.length && Date.now() >= quando[0] && ps.length) {
                quando.shift();
                const r = await cl.post('/api/public/orders', { customerName: `${M} Cliente ${ci}`, phone: `2198${String(ci).padStart(7, '0')}`, mode: pick(['LOCAL', 'BALCAO']), location: `Mesa ${1 + (ci % 40)}`, items: itensAleatorios(ps, 3) }, { 'x-aparelho': aparelho, 'idempotency-key': randomUUID() });
                if (r.status === 200)
                    pedidosQr++;
                else
                    recusadosQr++;
            }
        }
    });
    await Promise.all([...tarefasCaixa, ...tarefasCozinha, ...tarefasDono, ...tarefasClientes]);
    // ---- Encerramento: confirma QR pendentes, cobra todas as contas e fecha o caixa ----
    parar = true;
    await sleep(1500);
    const cx0 = caixas[0];
    const board = (await cx0.get('/api/cashier/board')).data;
    for (const q of board?.awaiting ?? [])
        await cx0.post(`/api/orders/${q.orderId}/confirm`, {});
    const board2 = (await cx0.get('/api/cashier/board')).data;
    for (const a of board2?.accounts ?? [])
        await pagar(cx0, a.id);
    const atual = (await donos[0].get('/api/register/current')).data;
    const esperado = atual?.summary?.expectedCashCents ?? 0;
    const fech = await cx0.post('/api/register/close', { countedCashCents: esperado });
    for (const p of [...caixas, ...cozinhas, ...donos])
        p.sock?.close();
    return { slug, pedidosQr, recusadosQr, fechamento: fech.status === 200 ? fech.data : { erro: fech.data }, registerId: fech.data?.id };
}
// ---------------- conferências no banco ----------------
async function conferir(slugsAlvo) {
    const c = new pg.Client({ connectionString: DB_URL });
    await c.connect();
    const q = async (s, p = []) => (await c.query(s, p)).rows;
    const ids = await q('SELECT id, slug FROM empresas WHERE slug = ANY($1)', [slugsAlvo]);
    const emp = ids.map((r) => r.id);
    const out = {};
    out.contasPagasAMais = await q(`
    WITH t AS (
      SELECT a.empresa_id, a.id, a.status,
        COALESCE((SELECT SUM(oi.unit_price_cents*oi.quantity) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.account_id=a.id AND oi.status='ACTIVE' AND o.status<>'AWAITING_CONFIRMATION'),0)
        - COALESCE((SELECT SUM(amount_cents) FROM discounts d WHERE d.account_id=a.id),0) AS total,
        COALESCE((SELECT SUM(amount_cents) FROM payments p WHERE p.account_id=a.id AND p.reversed_at IS NULL),0) AS pago
      FROM accounts a WHERE a.empresa_id = ANY($1))
    SELECT * FROM t WHERE pago > total OR (status='CLOSED' AND pago <> total)`, [emp]);
    out.contasNaoEncerradas = (await q(`SELECT count(*)::int AS n FROM accounts WHERE empresa_id = ANY($1) AND status IN ('OPEN','PARTIALLY_PAID','PAID')`, [emp]))[0].n;
    out.numerosRepetidos = [
        ...await q('SELECT empresa_id, number, count(*) FROM accounts WHERE empresa_id = ANY($1) GROUP BY 1,2 HAVING count(*)>1', [emp]),
        ...await q('SELECT empresa_id, number, count(*) FROM orders WHERE empresa_id = ANY($1) GROUP BY 1,2 HAVING count(*)>1', [emp]),
    ];
    // o fechamento congelado tem que bater com o que ficou gravado no caixa
    out.fechamentoDiferente = await q(`
    SELECT r.empresa_id, r.id, (r.summary->>'receivedCents')::int AS resumo_recebido,
      COALESCE((SELECT SUM(amount_cents) FROM payments p WHERE p.cash_register_id=r.id AND p.reversed_at IS NULL),0)::int AS banco_recebido,
      (r.summary->>'salesCents')::int AS resumo_vendas,
      COALESCE((SELECT SUM(oi.unit_price_cents*oi.quantity) FROM orders o JOIN order_items oi ON oi.order_id=o.id WHERE o.cash_register_id=r.id AND oi.status='ACTIVE' AND o.status<>'AWAITING_CONFIRMATION'),0)::int AS banco_vendas
    FROM cash_registers r WHERE r.empresa_id = ANY($1) AND r.status='CLOSED'`, [emp]).then((l) => l.filter((r) => r.resumo_recebido !== r.banco_recebido || r.resumo_vendas !== r.banco_vendas));
    out.estoqueDivergente = await q(`
    SELECT p.empresa_id, p.id, p.name, p.stock_qty, (SELECT after FROM stock_movements m WHERE m.product_id=p.id ORDER BY m.id DESC LIMIT 1) AS ultimo
    FROM products p WHERE p.empresa_id = ANY($1) AND p.track_stock`, [emp]).then((l) => l.filter((r) => r.ultimo != null && r.ultimo !== r.stock_qty));
    out.estoqueNegativo = (await q('SELECT count(*)::int AS n FROM products WHERE empresa_id = ANY($1) AND stock_qty < 0', [emp]))[0].n;
    out.vazamentoNoBanco = await q(`
    SELECT a.empresa_id, e.slug, a.customer_name FROM accounts a JOIN empresas e ON e.id=a.empresa_id
    WHERE a.empresa_id = ANY($1) AND a.customer_name ~ '^R[0-9]{3} ' AND upper(e.slug) <> split_part(a.customer_name,' ',1)`, [emp]);
    out.conexoesPresas = (await q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state LIKE 'idle in transaction%'`))[0].n;
    out.totais = (await q(`SELECT
    (SELECT count(*)::int FROM accounts WHERE empresa_id = ANY($1)) AS contas,
    (SELECT count(*)::int FROM orders WHERE empresa_id = ANY($1)) AS pedidos,
    (SELECT count(*)::int FROM payments WHERE empresa_id = ANY($1)) AS pagamentos,
    (SELECT COALESCE(SUM(amount_cents),0)::bigint FROM payments WHERE empresa_id = ANY($1) AND reversed_at IS NULL) AS recebido_cents`, [emp]))[0];
    await c.end();
    return out;
}
// ---------------- recursos do servidor ----------------
const amostras = [];
import { readdirSync } from 'node:fs';
const ticks = (pid) => { try {
    const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return Number(f[11]) + Number(f[12]);
}
catch {
    return 0;
} };
const ticksBanco = () => readdirSync('/proc').filter((d) => /^\d+$/.test(d)).reduce((s, d) => { try {
    return readFileSync(`/proc/${d}/comm`, 'utf8').startsWith('postgres') ? s + ticks(d) : s;
}
catch {
    return s;
} }, 0);
async function monitorar() {
    const c = new pg.Client({ connectionString: DB_URL });
    await c.connect();
    while (!parar || amostras.length === 0) {
        let rssMb = 0;
        try {
            rssMb = Math.round(Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${A.pid}/status`, 'utf8'))?.[1] ?? 0) / 1024);
        }
        catch { /* sem pid */ }
        const r = await c.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()');
        const n0 = ticks(A.pid), b0 = ticksBanco();
        await sleep(2000);
        // CPU em "núcleos usados" (1.0 = um núcleo inteiro)
        amostras.push({ t: Date.now(), rssMb, conexoesBanco: r.rows[0].n, cpuNode: (ticks(A.pid) - n0) / 200, cpuBanco: (ticksBanco() - b0) / 200 });
    }
    await c.end();
}
const pct = (l, p) => { if (!l.length)
    return 0; const s = [...l].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]); };
async function main() {
    const t0 = Date.now();
    console.log(`Carga: ${slugs.length} empresa(s) × (${N.caixas} caixas + ${N.cozinhas} cozinhas + ${N.donos} dono + ${N.clientes} clientes) = ${slugs.length * (N.caixas + N.cozinhas + N.donos + N.clientes)} pessoas · ${MINUTOS} min · ritmo ${RITMO} · rede ${IPS}`);
    const mon = monitorar();
    const res = await Promise.allSettled(slugs.map((s, i) => sleep(i * 50).then(() => empresa(s, i))));
    parar = true;
    await mon;
    const falhasEmpresa = res.flatMap((r, i) => r.status === 'rejected' ? [`${slugs[i]}: ${r.reason.message}`] : []);
    const ok = res.flatMap((r) => r.status === 'fulfilled' ? [r.value] : []);
    const conf = await conferir(slugs);
    const durS = (Date.now() - t0) / 1000;
    const todasLat = [...lat.values()].flat();
    const porRota = [...lat.entries()].map(([k, l]) => ({ rota: k, n: l.length, p50: pct(l, 50), p95: pct(l, 95), p99: pct(l, 99), max: Math.round(Math.max(...l)) })).sort((a, b) => b.p95 - a.p95);
    const resumo = {
        cenario: { empresas: slugs.length, pessoasPorEmpresa: N, minutos: MINUTOS, ritmo: RITMO, rede: IPS },
        duracaoS: Math.round(durS), requisicoes: totalReq, porSegundo: Math.round(totalReq / durS),
        latenciaGeral: { p50: pct(todasLat, 50), p95: pct(todasLat, 95), p99: pct(todasLat, 99), max: Math.round(Math.max(...todasLat)) },
        latenciaEmRegime: { depoisDeS: AQUECIMENTO_MS / 1000, n: latRegime.length, p50: pct(latRegime, 50), p95: pct(latRegime, 95), p99: pct(latRegime, 99), max: Math.round(Math.max(0, ...latRegime)) },
        erros: Object.fromEntries([...erros.entries()].sort((a, b) => b[1].n - a[1].n)),
        eventosTempoReal: { total: eventos.recebidos, porTipo: Object.fromEntries(eventos.porTipo) },
        pedidosQr: ok.reduce((s, r) => s + r.pedidosQr, 0), recusadosQr: ok.reduce((s, r) => s + r.recusadosQr, 0),
        fechamentosComErro: ok.filter((r) => r.fechamento?.erro).map((r) => ({ slug: r.slug, erro: r.fechamento.erro })),
        falhasEmpresa,
        vazamentos: vazamentos.slice(0, 50), vazamentosTotal: vazamentos.length,
        servidor: {
            rssMaxMb: Math.max(...amostras.map((a) => a.rssMb)), conexoesBancoMax: Math.max(...amostras.map((a) => a.conexoesBanco)),
            cpuNodeMedia: +(amostras.reduce((s, a) => s + a.cpuNode, 0) / Math.max(1, amostras.length)).toFixed(2), cpuNodeMax: +Math.max(...amostras.map((a) => a.cpuNode)).toFixed(2),
            cpuBancoMedia: +(amostras.reduce((s, a) => s + a.cpuBanco, 0) / Math.max(1, amostras.length)).toFixed(2), cpuBancoMax: +Math.max(...amostras.map((a) => a.cpuBanco)).toFixed(2),
            nucleosMaquina: (await import('node:os')).cpus().length,
        },
        conferencias: conf,
        rotasMaisLentas: porRota.slice(0, 15),
    };
    writeFileSync(SAIDA, JSON.stringify({ ...resumo, porRota }, null, 2));
    console.log(JSON.stringify(resumo, null, 2));
    agent.destroy();
}
main().catch((e) => { console.error(e); process.exit(1); });
