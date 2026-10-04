/**
 * Auditoria do comitê (04/10/2026) — cada correção CRÍTICA/ALTA tem aqui o teste que falhava antes.
 * Roda na empresa "beta" do banco de duas empresas (EMPRESA_HEADER=true; veja testes.sh), depois da suíte leva1.
 */
import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = process.env.BASE_URL ?? 'http://localhost:3200';
const DB_URL = process.env.DATABASE_URL;
let passed = 0;
const failures = [];
function check(label, cond, extra) {
    if (cond) {
        passed++;
        console.log(`  ✔ ${label}`);
    }
    else {
        failures.push(label);
        console.log(`  ✘ ${label}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 500));
    }
}
/** Cliente HTTP com "pote" de cookies (sessão + aparelho da equipe). */
class C {
    empresa;
    ua;
    jar = new Map();
    constructor(empresa = 'beta', ua = 'Mozilla/5.0 (Linux; Android 14) Teste') {
        this.empresa = empresa;
        this.ua = ua;
    }
    async req(method, path, body, extra = {}) {
        const res = await fetch(BASE + path, {
            method,
            headers: {
                'x-empresa': this.empresa, 'user-agent': this.ua, ...extra,
                ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
                ...(this.jar.size ? { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        for (const c of res.headers.getSetCookie()) {
            const [kv] = c.split(';');
            const i = kv.indexOf('=');
            const k = kv.slice(0, i), v = kv.slice(i + 1);
            if (!v || /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c))
                this.jar.delete(k);
            else
                this.jar.set(k, v);
        }
        const text = await res.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        }
        catch {
            data = text;
        }
        return { status: res.status, data, text };
    }
    get = (p) => this.req('GET', p);
    post = (p, b = {}) => this.req('POST', p, b);
    patch = (p, b) => this.req('PATCH', p, b);
    put = (p, b) => this.req('PUT', p, b);
    async login(u, p) { const r = await this.post('/api/auth/login', { username: u, password: p }); if (r.status !== 200)
        throw new Error(`login ${u}: ${r.status} ${JSON.stringify(r.data)}`); return r; }
}
async function main() {
    const db = new pg.Client({ connectionString: DB_URL });
    await db.connect();
    const [{ id: BETA }] = (await db.query(`SELECT id FROM empresas WHERE slug='beta'`)).rows;
    const dono = new C();
    await dono.login('admin', 'beta-admin');
    const caixa = new C();
    await caixa.login('caixa', 'beta-caixa');
    const users = (await dono.get('/api/users')).data;
    const uCaixa = users.find((u) => u.role === 'CAIXA');
    console.log('\n[Saúde] o "ok" confere o banco de verdade');
    const h = await new C().get('/api/health');
    check('/api/health responde 200 com a versão (consulta ao banco feita)', h.status === 200 && h.data.ok === true && !!h.data.versao, h.data);
    console.log('\n[Segurança] rajada no login não fura o limite nem trava os outros');
    const rajada = await Promise.all(Array.from({ length: 30 }, () => new C().post('/api/auth/login', { username: 'cozinha', password: 'errada' })));
    const aceitas = rajada.filter((r) => r.status === 400).length;
    check(`30 senhas erradas ao mesmo tempo: no máximo 8 conferidas (foram ${aceitas}), o resto 429`, aceitas <= 8 && rajada.every((r) => r.status === 400 || r.status === 429), rajada.map((r) => r.status));
    const t0 = Date.now();
    const meta = await new C('alfa').get('/api/meta');
    check('Outro restaurante continua respondendo rápido (< 1 s)', meta.status === 200 && Date.now() - t0 < 1000, Date.now() - t0);
    console.log('\n[Segurança] PIN: tentativas simultâneas não furam o bloqueio');
    await dono.patch(`/api/users/${uCaixa.id}`, { pin: '2468' });
    await caixa.login('caixa', 'beta-caixa'); // trocar um PIN que já existia derruba as sessões da pessoa (correto)
    const tablet = new C('beta', 'Mozilla/5.0 (Linux; Android 13; Tab) Auditoria');
    await tablet.login('admin', 'beta-admin');
    await tablet.post('/api/auth/logout');
    await db.query(`UPDATE users SET pin_falhas = 0, pin_bloqueado_ate = NULL WHERE id = $1`, [uCaixa.id]);
    await Promise.all(Array.from({ length: 6 }, (_, i) => tablet.post('/api/auth/pin', { userId: uCaixa.id, pin: String(1000 + i) })));
    const depois = await tablet.post('/api/auth/pin', { userId: uCaixa.id, pin: '2468' });
    check('6 PINs errados em paralelo → o PIN certo fica bloqueado (429)', depois.status === 429, depois);
    await db.query(`UPDATE users SET pin_falhas = 0, pin_bloqueado_ate = NULL WHERE id = $1`, [uCaixa.id]);
    console.log('\n[Segurança] tirar o acesso do aparelho derruba quem está logado nele');
    const tab2 = new C('beta', 'Mozilla/5.0 (Linux; Android 14; Tab) Perdido');
    await tab2.login('admin', 'beta-admin');
    await tab2.post('/api/auth/logout');
    const entrou = await tab2.post('/api/auth/pin', { userId: uCaixa.id, pin: '2468' });
    check('Caixa entra com PIN no tablet', entrou.status === 200, entrou.data);
    const ap = (await dono.get('/api/aparelhos')).data.find((a) => /Android/.test(a.nome ?? '') && a.ultimoUso);
    await dono.post(`/api/aparelhos/${ap.id}/revogar`);
    await new Promise((r) => setTimeout(r, 50));
    check('Depois de revogar, a sessão do tablet não vale mais (401)', (await tab2.get('/api/auth/me')).status === 401);
    console.log('\n[Segurança] formulário forjado de outro site é recusado');
    const forjado = await fetch(BASE + '/api/expenses', { method: 'POST', headers: { 'x-empresa': 'beta', origin: 'https://outro.oneupsistemas.com.br', cookie: [...dono.jar].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/json' }, body: '{}' });
    check('POST com Origin de outro endereço → 403', forjado.status === 403);
    console.log('\n[Dinheiro] desconto de conta cancelada não vira venda negativa');
    const menu = (await dono.get('/api/menu?all=1')).data;
    const prods = menu.flatMap((c) => c.products);
    const p1 = prods.find((p) => p.active && p.priceCents > 0 && !p.trackStock);
    const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const fin0 = (await dono.get(`/api/finance?from=${hoje}&to=${hoje}`)).data;
    const acc = await caixa.post('/api/accounts', { tableLabel: '9', items: [{ productId: p1.id, quantity: 1 }] });
    await caixa.post(`/api/accounts/${acc.data.id}/discounts`, { amountCents: 100, reason: 'Teste da auditoria' });
    await caixa.post(`/api/accounts/${acc.data.id}/cancel`, { reason: 'Cliente desistiu', returnStock: false });
    const fin1 = (await dono.get(`/api/finance?from=${hoje}&to=${hoje}`)).data;
    check('Financeiro: o desconto da conta cancelada não é subtraído', fin1.discountsCents === fin0.discountsCents, { antes: fin0.discountsCents, depois: fin1.discountsCents });
    console.log('\n[Dinheiro] cortesia de 100% encerra a conta');
    const cort = await caixa.post('/api/accounts', { tableLabel: '8', items: [{ productId: p1.id, quantity: 1 }] });
    await dono.post(`/api/accounts/${cort.data.id}/discounts`, { amountCents: p1.priceCents, reason: 'Cortesia da casa' });
    const fechou = await caixa.post(`/api/accounts/${cort.data.id}/close`);
    check('Conta com 100% de desconto fica PAGA e encerra', fechou.status === 200, fechou.data);
    console.log('\n[Dinheiro] o caixa não perdoa fiado nem some com comida entregue');
    const fi = await caixa.post('/api/accounts', { customerName: 'Fiado Auditoria', items: [{ productId: p1.id, quantity: 1 }] });
    await caixa.post(`/api/accounts/${fi.data.id}/pending`, { customerName: 'Fiado Auditoria', contact: 'casa 7' });
    const aj = await caixa.post(`/api/accounts/${fi.data.id}/discounts`, { amountCents: p1.priceCents, reason: 'Zerar' });
    check('Caixa não dá desconto em conta a receber (403)', aj.status === 403 && aj.data.code === 'DESCONTO_FIADO_SO_DONO', aj.data);
    await dono.patch('/api/configuracoes', { valores: { cancelar_pronto_so_dono: true } });
    const pk = prods.find((p) => p.active && p.sendsToKitchen && !p.trackStock && p.priceCents > 0);
    const ent = await caixa.post('/api/accounts', { tableLabel: '7', items: [{ productId: pk.id, quantity: 1 }] });
    const coz = dono; // o login da cozinha está em espera depois da rajada acima (correto); o Dono opera a cozinha
    const ped = (await coz.get('/api/kitchen/orders')).data.find((o) => o.account?.id === ent.data.id);
    await coz.post(`/api/kitchen/orders/${ped.id}/start`);
    await coz.post(`/api/kitchen/orders/${ped.id}/ready`);
    const cc = await caixa.post(`/api/accounts/${ent.data.id}/cancel`, { reason: 'Tentando sumir', returnStock: false });
    check('Com a trava ligada, o caixa não cancela a CONTA com comida pronta (403)', cc.status === 403, cc.data);
    await dono.patch('/api/configuracoes', { valores: { cancelar_pronto_so_dono: false } });
    console.log('\n[Dinheiro] despesa repetida pela rede lenta entra uma vez só');
    const cats = (await dono.get('/api/expense-categories')).data;
    const corpo = { description: 'Gelo auditoria', categoryId: cats[0].id, amountCents: 1234 };
    const k = 'aud-' + Date.now();
    const r1 = await dono.req('POST', '/api/expenses', corpo, { 'idempotency-key': k });
    const r2 = await dono.req('POST', '/api/expenses', corpo, { 'idempotency-key': k });
    const n = (await db.query(`SELECT count(*)::int n FROM expenses WHERE empresa_id=$1 AND description='Gelo auditoria'`, [BETA])).rows[0].n;
    check('Mesma chave duas vezes → uma despesa', r1.status === 200 && r2.status === 200 && n === 1, { n });
    console.log('\n[Produto] o que é da ONE UP não vaza');
    const st = (await dono.get('/api/settings')).data;
    check('/api/settings do Dono não traz as chaves da seção ONE UP', !('cobranca_whatsapp' in st.config) && !('mensagem_cobranca' in st.config) && !('backup_externo_em' in st.config), Object.keys(st.config));
    const stc = (await caixa.get('/api/settings')).data;
    check('/api/settings do Caixa também não', !('cobranca_whatsapp' in stc.config));
    const hist = (await dono.get('/api/configuracoes/historico')).data;
    check('Histórico de Configurações do Dono sem as mudanças da ONE UP', !hist.some((x) => ['cobranca_whatsapp', 'backup_externo_em', 'backup_externo_adiado'].includes(x.chave)));
    const mc = (await caixa.get('/api/menu')).data;
    check('Caixa não recebe o custo dos produtos', mc.flatMap((c) => c.products).every((p) => !('costCents' in p)));
    const dash = (await dono.get('/api/dashboard')).data;
    check('Painel do Dono sem o tempo de cozinha (leitura da ONE UP)', dash.kitchenMedianMin === null);
    check('Painel do Dono sem ranking de mais vendidos e sem movimento por hora', dash.topProducts.length === 0 && dash.byHour.length === 0);
    check('Ritmo do mês (projeção) não abre para o Dono', (await dono.get('/api/finance/ritmo')).status === 404);
    console.log('\n[Happy Alpha 3.3] "Permitir suporte": a ONE UP só vê dados de clientes com o Dono liberando');
    execFileSync('node', ['dist/scripts/plataforma.js', 'oneup-usuario', '--empresa=beta', '--login=lucas.beta', '--nome=Lucas', '--senha=segredo-beta-1'], { cwd: SERVER, env: { ...process.env, DATABASE_URL: DB_URL }, stdio: 'ignore' });
    const one = new C();
    await one.login('lucas.beta', 'segredo-beta-1');
    const recOne = JSON.stringify((await one.get('/api/accounts/receivable')).data);
    check('Sem liberação: telefone/contato do cliente chegam mascarados para a ONE UP', !/casa 7/.test(recOne) && /\*\*\*\*|••••/.test(recOne), recOne.slice(0, 300));
    check('A ONE UP não consegue se liberar sozinha', (await one.post('/api/suporte/liberar', { minutos: 30 })).status === 403);
    check('O Dono libera por 30 minutos', (await dono.post('/api/suporte/liberar', { minutos: 30 })).status === 200);
    await new Promise((r) => setTimeout(r, 30));
    const recLib = JSON.stringify((await one.get('/api/accounts/receivable?x=1')).data);
    check('Com liberação: a ONE UP vê os dados', /casa 7/.test(recLib), recLib.slice(0, 200));
    await dono.post('/api/suporte/encerrar');
    const audS = (await db.query(`SELECT message, user_role FROM audit_logs WHERE empresa_id=$1 AND user_id=(SELECT id FROM users WHERE empresa_id=$1 AND username='lucas.beta') ORDER BY id DESC LIMIT 1`, [BETA])).rows[0];
    check('Ações da ONE UP aparecem como "Suporte ONE UP" para o Dono', audS?.user_role === 'ONEUP' && /^Suporte ONE UP · /.test(audS.message), audS);
    console.log('\n[Happy Alpha 3.3] Autorização do Dono no aparelho do caixa');
    const caixa2 = new C();
    await caixa2.login('caixa', 'beta-caixa');
    const ac = await caixa2.post('/api/accounts', { tableLabel: '3', items: [{ productId: p1.id, quantity: 1 }] });
    const methods = (await dono.get('/api/payment-methods')).data;
    const PIX = methods.find((m) => m.code === 'PIX').id, CART = methods.find((m) => m.code === 'CARTAO').id, DIN = methods.find((m) => m.code === 'DINHEIRO').id;
    await caixa2.post(`/api/accounts/${ac.data.id}/payments`, { payments: [{ methodId: CART, amountCents: p1.priceCents }], close: false });
    const det = (await caixa2.get(`/api/accounts/${ac.data.id}`)).data;
    const pg1 = det.payments[0];
    const troca = await caixa2.req('POST', `/api/payments/${pg1.id}/forma`, { methodId: PIX, reason: 'Era PIX, lancei cartão' });
    const det2 = (await caixa2.get(`/api/accounts/${ac.data.id}`)).data;
    check('Caixa troca a forma do pagamento do dia (cartão → PIX), valor igual', troca.status === 200 && det2.payments.some((p) => p.methodCode === 'PIX' && !p.reversedAt && p.amountCents === p1.priceCents) && det2.payments.some((p) => p.methodCode === 'CARTAO' && p.reversedAt), det2.payments);
    const novo = det2.payments.find((p) => !p.reversedAt);
    const semAut = await caixa2.post(`/api/payments/${novo.id}/reverse`, { reason: 'Cliente pagou duas vezes' });
    check('Estorno pelo caixa sem o Dono → pede autorização (403 AUTORIZACAO_DONO)', semAut.status === 403 && semAut.data.code === 'AUTORIZACAO_DONO', semAut.data);
    check('Senha errada do Dono não autoriza', (await caixa2.post('/api/auth/autorizar', { username: 'admin', password: 'errada' })).status === 400);
    const aut = await caixa2.post('/api/auth/autorizar', { username: 'admin', password: 'beta-admin' });
    check('Dono digita a senha no aparelho do caixa → código de autorização', aut.status === 200 && typeof aut.data.token === 'string', aut.data);
    const comAut = await caixa2.req('POST', `/api/payments/${novo.id}/reverse`, { reason: 'Cliente pagou duas vezes' }, { 'x-autorizacao-dono': aut.data.token });
    check('Com a autorização, o caixa estorna (e continua no próprio acesso)', comAut.status === 200 && (await caixa2.get('/api/auth/me')).data.user.role === 'CAIXA', comAut.data);
    const reuso = await caixa2.req('POST', `/api/payments/${novo.id}/reverse`, { reason: 'De novo' }, { 'x-autorizacao-dono': aut.data.token });
    check('O código vale uma vez só', reuso.status === 403);
    void DIN;
    await db.end();
    console.log(`\nResultado auditoria: ${passed} verificações OK, ${failures.length} falhas.`);
    if (failures.length) {
        console.log(' - ' + failures.join('\n - '));
        process.exit(1);
    }
}
main().catch((e) => { console.error(e); process.exit(1); });
