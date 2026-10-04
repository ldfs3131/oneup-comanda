/**
 * PLATAFORMA ONE UP — testes da Central de comando, da licença online e do cardápio de exemplo genérico.
 * Autossuficiente: recria o banco, cria duas empresas, sobe o próprio servidor (porta 3503) e o reinicia com o
 * relógio adiantado (ONEUP_HOJE) no fim.
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/ag_plat node dist/scripts/plataforma-test.js
 */
import pg from 'pg';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diasParaVencer, hojeLicenca, statusEfetivo } from '../lib/licenca.js';
import { CARDAPIO_EXEMPLO } from '../seed/cardapio-exemplo.js';
import { MENU } from '../seed/menu.js';
const DB_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ag_plat';
const PORT = Number(process.env.PORT_TESTE ?? 3503);
const BASE = `http://localhost:${PORT}`;
const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
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
class C {
    empresa;
    cookie = '';
    constructor(empresa) {
        this.empresa = empresa;
    }
    async req(method, path, body) {
        const res = await fetch(BASE + path, {
            method,
            headers: { 'x-empresa': this.empresa, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const set = res.headers.get('set-cookie');
        if (set && set.startsWith('oneup_sessao='))
            this.cookie = set.split(';')[0];
        const text = await res.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        }
        catch {
            data = text;
        }
        return { status: res.status, data };
    }
    get = (p) => this.req('GET', p);
    post = (p, b = {}) => this.req('POST', p, b);
    patch = (p, b) => this.req('PATCH', p, b);
    async login(u, p) { const r = await this.post('/api/auth/login', { username: u, password: p }); if (r.status !== 200)
        throw new Error(`login ${u}@${this.empresa}: ${r.status} ${JSON.stringify(r.data)}`); return this; }
}
const node = (script, ...args) => execFileSync('node', [`dist/scripts/${script}`, ...args], { cwd: SERVER, env: { ...process.env, DATABASE_URL: DB_URL }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const somaDias = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
let srv = null;
async function subir(extra = {}) {
    srv = spawn('node', ['dist/index.js'], {
        cwd: SERVER, stdio: ['ignore', 'ignore', 'inherit'],
        env: { ...process.env, DATABASE_URL: DB_URL, EMPRESA_HEADER: 'true', PORT: String(PORT), NODE_ENV: 'test', BASE_DOMAIN: '', DEFAULT_EMPRESA: '', ...extra },
    });
    for (let i = 0; i < 80; i++) {
        try {
            if ((await fetch(BASE + '/api/health')).ok)
                return;
        }
        catch { /* subindo */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('servidor de teste não subiu');
}
async function derrubar() {
    if (!srv)
        return;
    const p = srv;
    srv = null;
    await new Promise((r) => { p.once('exit', () => r()); p.kill('SIGTERM'); setTimeout(() => { p.kill('SIGKILL'); r(); }, 9000); });
}
async function main() {
    console.log('\n[0] Regras puras da licença');
    {
        const semVenc = { licencaStatus: 'ATIVO', licencaVenceEm: null };
        check('ATIVO sem vencimento é ATIVO hoje', statusEfetivo(semVenc) === 'ATIVO');
        check('ATIVO sem vencimento continua ATIVO em 2099 (nunca vence pelo relógio)', statusEfetivo(semVenc, '2099-12-31') === 'ATIVO');
        check('ATIVO vencido ontem vale como SÓ CONSULTA', statusEfetivo({ licencaStatus: 'ATIVO', licencaVenceEm: '2026-01-10' }, '2026-01-11') === 'SO_CONSULTA');
        check('No próprio dia do vencimento ainda é ATIVO', statusEfetivo({ licencaStatus: 'ATIVO', licencaVenceEm: '2026-01-10' }, '2026-01-10') === 'ATIVO');
        check('SUSPENSO vence qualquer data', statusEfetivo({ licencaStatus: 'SUSPENSO', licencaVenceEm: null }) === 'SUSPENSO');
        check('Dias para vencer: 5', diasParaVencer('2026-03-06', '2026-03-01') === 5);
        const antes = { h: process.env.ONEUP_HOJE, n: process.env.NODE_ENV };
        process.env.ONEUP_HOJE = '2099-01-01';
        process.env.NODE_ENV = 'production';
        check('ONEUP_HOJE é ignorado em produção', hojeLicenca() !== '2099-01-01');
        process.env.NODE_ENV = 'test';
        check('ONEUP_HOJE vale fora de produção', hojeLicenca() === '2099-01-01');
        if (antes.h === undefined)
            delete process.env.ONEUP_HOJE;
        else
            process.env.ONEUP_HOJE = antes.h;
        if (antes.n === undefined)
            delete process.env.NODE_ENV;
        else
            process.env.NODE_ENV = antes.n;
    }
    console.log('\n[1] Cardápio de exemplo genérico');
    {
        const nomes = CARDAPIO_EXEMPLO.flatMap((c) => c.products.map((p) => p.name));
        const piloto = new Set(MENU.flatMap((c) => c.products.map((p) => p.name.toLowerCase())));
        const texto = JSON.stringify(CARDAPIO_EXEMPLO).toLowerCase();
        check('Tem porções, pratos, bebidas e sobremesas', ['Porções', 'Pratos', 'Bebidas', 'Sobremesas'].every((c) => CARDAPIO_EXEMPLO.some((x) => x.name === c && x.products.length >= 3)));
        check('Nenhum produto igual ao cardápio do restaurante piloto', nomes.every((n) => !piloto.has(n.toLowerCase())), nomes.filter((n) => piloto.has(n.toLowerCase())));
        check('Sem nome ou marca de cliente (Happy Alpha, Bom Bife, Champion)', !/happy|alpha|bom bife|champion/.test(texto));
        check('Preços plausíveis (R$ 3 a R$ 150)', CARDAPIO_EXEMPLO.every((c) => c.products.every((p) => p.priceCents >= 300 && p.priceCents <= 15000)));
    }
    // ---------- banco e empresas ----------
    const u = new URL(DB_URL);
    const nomeBanco = u.pathname.slice(1);
    u.pathname = '/postgres';
    const adm = new pg.Client({ connectionString: u.toString() });
    await adm.connect();
    await adm.query(`DROP DATABASE IF EXISTS ${nomeBanco} WITH (FORCE)`);
    await adm.query(`CREATE DATABASE ${nomeBanco}`);
    await adm.end();
    node('setup.js', '--empresa=alfa', '--nome=Alfa', '--admin-pass=alfa-admin', '--caixa-pass=alfa-caixa', '--cozinha-pass=alfa-coz', '--cardapio=piloto');
    node('setup.js', '--empresa=beta', '--nome=Beta', '--admin-pass=beta-admin', '--caixa-pass=beta-caixa', '--cozinha-pass=beta-coz', '--cardapio=exemplo');
    for (const e of ['alfa', 'beta'])
        node('plataforma.js', 'oneup-usuario', `--empresa=${e}`, '--login=lucas', '--nome=Lucas (ONE UP)', '--senha=oneup-12345');
    const pgc = new pg.Client({ connectionString: DB_URL });
    await pgc.connect();
    const ids = Object.fromEntries((await pgc.query(`SELECT slug, id FROM empresas`)).rows.map((r) => [r.slug, r.id]));
    const lic = (await pgc.query(`SELECT licenca_status, licenca_vence_em FROM empresas WHERE slug='alfa'`)).rows[0];
    check('Empresa existente fica ATIVO e sem vencimento (migração)', lic.licenca_status === 'ATIVO' && lic.licenca_vence_em === null, lic);
    const prodBeta = (await pgc.query(`SELECT name FROM products WHERE empresa_id=$1`, [ids.beta])).rows.map((r) => r.name);
    check('setup --cardapio=exemplo usa o cardápio genérico', prodBeta.includes('Prato do dia') && !prodBeta.some((n) => /espeto|heineken|monster/i.test(n)), prodBeta.slice(0, 5));
    const priv = (await pgc.query(`SELECT has_table_privilege('oneup_app', 'plataforma_historico', 'SELECT') s, has_table_privilege('oneup_app', 'plataforma_historico', 'INSERT') i`)).rows[0];
    check('Histórico da plataforma: o papel da aplicação não lê nem grava', !priv.s && !priv.i, priv);
    await subir();
    const hoje = hojeLicenca();
    const one = await new C('alfa').login('lucas', 'oneup-12345');
    const donoA = await new C('alfa').login('admin', 'alfa-admin');
    const caixaA = await new C('alfa').login('caixa', 'alfa-caixa');
    const cozA = await new C('alfa').login('cozinha', 'alfa-coz');
    const lista = async () => (await one.get('/api/plataforma/restaurantes')).data;
    const linha = async (slug) => (await lista()).restaurantes.find((r) => r.slug === slug);
    console.log('\n[2] Rotas da plataforma: só a ONE UP');
    for (const [nome, c] of [['Dono', donoA], ['Caixa', caixaA], ['Cozinha', cozA]]) {
        const r1 = await c.get('/api/plataforma/restaurantes');
        const r2 = await c.patch(`/api/plataforma/restaurantes/${ids.alfa}`, { mensalidadeCents: 1 });
        const r3 = await c.post('/api/plataforma/restaurantes', { nome: 'X', slug: 'xx', donoNome: 'Fulano' });
        const r4 = await c.get(`/api/plataforma/restaurantes/${ids.alfa}/cobranca`);
        check(`${nome} recebe 404 nas rotas da plataforma`, [r1, r2, r3, r4].every((r) => r.status === 404), [r1.status, r2.status, r3.status, r4.status]);
    }
    check('ONE UP lista os restaurantes', (await one.get('/api/plataforma/restaurantes')).status === 200);
    console.log('\n[3] Carteira e MRR');
    {
        let r = await one.patch(`/api/plataforma/restaurantes/${ids.alfa}`, { mensalidadeCents: 19900, plano: 'Essencial', donoNome: 'Dono Alfa', donoWhatsapp: '(11) 91234-5678' });
        check('Alterar mensalidade, plano e WhatsApp do Dono', r.status === 200 && r.data.alteradas === 4, r.data);
        r = await one.patch(`/api/plataforma/restaurantes/${ids.beta}`, { mensalidadeCents: 29900 });
        check('WhatsApp inválido é recusado', (await one.patch(`/api/plataforma/restaurantes/${ids.beta}`, { donoWhatsapp: '123' })).status === 400);
        const l = await lista();
        check('MRR = soma das mensalidades dos ativos (199 + 299)', l.carteira.mrrCents === 49800 && l.carteira.ativos === 2, l.carteira);
        const a = l.restaurantes.find((x) => x.slug === 'alfa');
        check('Linha do restaurante: status, mensalidade, plano, contas no mês, versão', a.efetivo === 'ATIVO' && a.mensalidadeCents === 19900 && a.plano === 'Essencial' && typeof a.contasNoMes === 'number' && !!a.versao && a.donoWhatsapp === '11912345678', a);
        const h = (await one.get(`/api/plataforma/restaurantes/${ids.alfa}/historico`)).data;
        check('Mudanças vão para o histórico', h.some((x) => x.tipo === 'MENSALIDADE' && /199,00/.test(x.mensagem)) && h.some((x) => x.tipo === 'PLANO'), h.map((x) => x.mensagem));
    }
    console.log('\n[4] Aviso ao Dono 5 dias antes (sem valores para Caixa/Cozinha)');
    {
        await one.patch(`/api/plataforma/restaurantes/${ids.alfa}`, { licencaVenceEm: somaDias(hoje, 6) });
        let s = (await donoA.get('/api/settings')).data;
        check('6 dias antes: sem aviso', s.licenca.diasParaVencer === 6 && s.licenca.avisar === false, s.licenca);
        await one.patch(`/api/plataforma/restaurantes/${ids.alfa}`, { licencaVenceEm: somaDias(hoje, 5) });
        s = (await donoA.get('/api/settings')).data;
        check('5 dias antes: aviso no painel do Dono, com a data', s.licenca.diasParaVencer === 5 && s.licenca.avisar === true && s.licenca.venceEm === somaDias(hoje, 5), s.licenca);
        check('Dono não recebe o valor da mensalidade nem o plano', !/mensalidade|plano|19900/i.test(JSON.stringify(s.licenca)));
        for (const [nome, c] of [['Caixa', caixaA], ['Cozinha', cozA]]) {
            const t = (await c.get('/api/settings')).data;
            check(`${nome} vê só o status da licença (sem vencimento nem valores)`, t.licenca && Object.keys(t.licenca).join() === 'status' && !/mensalidade|19900|plano/i.test(JSON.stringify(t)), t.licenca);
        }
        check('Carteira: 1 a vencer em 5 dias', (await lista()).carteira.aVencer === 1);
    }
    console.log('\n[5] Vencimento: só consulta apenas no próximo "abrir o dia"');
    {
        await pgc.query(`UPDATE restaurant_settings SET qr_enabled = true WHERE id = $1`, [ids.alfa]);
        let r = await caixaA.post('/api/day/open', { openingCashCents: 10000 });
        check('Licença ativa: abre o dia', r.status === 200, r.data);
        const menu = (await caixaA.get('/api/menu')).data;
        const prod = menu.flatMap((c) => c.products).find((p) => !p.trackStock && !p.groups?.some((g) => g.required));
        const conta1 = await caixaA.post('/api/accounts', { customerName: 'Cliente Um', items: [{ productId: prod.id, quantity: 1 }] });
        check('Conta aberta com pedido', conta1.status === 200, conta1.data);
        await one.patch(`/api/plataforma/restaurantes/${ids.alfa}`, { licencaVenceEm: somaDias(hoje, -1) });
        const a = await linha('alfa');
        check('Central mostra vencida → só consulta, com o dia ainda aberto', a.vencida && a.efetivo === 'SO_CONSULTA' && a.diaAberto, a);
        r = await caixaA.post('/api/accounts', { customerName: 'Cliente Dois', items: [{ productId: prod.id, quantity: 2 }] });
        check('Dia aberto continua: nova conta com pedido no meio do serviço', r.status === 200, r.data);
        r = await caixaA.post(`/api/accounts/${conta1.data.id}/orders`, { items: [{ productId: prod.id, quantity: 1 }] });
        check('Dia aberto continua: complemento de pedido', r.status === 200, r.data);
        const pub = new C('alfa');
        r = await pub.get('/api/public/menu');
        check('Dia aberto continua: cardápio online no ar', r.status === 200 && r.data.enabled === true && !r.data.foraDoAr, r.data?.enabled);
        r = await pub.post('/api/public/orders', { customerName: 'Cliente QR', phone: '11987654321', mode: 'BALCAO', items: [{ productId: prod.id, quantity: 1 }] });
        check('Dia aberto continua: pedido pelo cardápio online', r.status === 200, r.data);
        r = await caixaA.post('/api/day/close', { countedCashCents: 10000 });
        check('Encerra o dia normalmente', r.status === 200, r.data);
        r = await caixaA.post('/api/day/open', { openingCashCents: 10000 });
        check('Próximo "abrir o dia": bloqueado com mensagem clara', r.status === 409 && r.data.code === 'LICENCA_SO_CONSULTA' && /só consulta/i.test(r.data.error), r.data);
        r = await caixaA.post('/api/accounts', { customerName: 'Cliente Três', items: [{ productId: prod.id, quantity: 1 }] });
        check('Só consulta: nova conta/pedido sem dia aberto bloqueado (mensagem da licença)', r.status === 409 && r.data.code === 'LICENCA_SO_CONSULTA', r.data);
        r = await pub.get('/api/public/menu');
        check('Só consulta: cardápio online fora do ar', r.status === 200 && r.data.enabled === false && r.data.foraDoAr === true, r.data);
        r = await pub.post('/api/public/orders', { customerName: 'Cliente QR', phone: '11987654321', mode: 'BALCAO', items: [{ productId: prod.id, quantity: 1 }] });
        check('Só consulta: pedido online recusado', r.status === 403 && r.data.code === 'CARDAPIO_FORA_DO_AR', r.data);
        const s = (await donoA.get('/api/settings')).data;
        check('Dono vê "Só consulta" e a data vencida', s.licenca.status === 'SO_CONSULTA' && s.licenca.vencida && s.licenca.avisar, s.licenca);
        check('Histórico continua visível (contas)', (await donoA.get('/api/accounts')).status === 200);
        r = await caixaA.post('/api/day/open', { openingCashCents: 5000, somenteReceber: true });
        check('Só consulta: abre o caixa só para receber contas abertas', r.status === 200 && r.data.somenteReceber === true, r.data);
        r = await caixaA.post('/api/day/establishment', { isOpen: true });
        check('Caixa só para receber: não reabre o estabelecimento', r.status === 409, r.data);
        r = await caixaA.post('/api/accounts', { customerName: 'Cliente Quatro', items: [{ productId: prod.id, quantity: 1 }] });
        check('Caixa só para receber: pedido novo bloqueado', r.status === 409 && /só para receber/.test(r.data.error), r.data);
        const det = (await caixaA.get(`/api/accounts/${conta1.data.id}`)).data;
        const pix = (await caixaA.get('/api/payment-methods')).data.find((m) => m.code === 'PIX');
        r = await caixaA.post(`/api/accounts/${conta1.data.id}/payments`, { payments: [{ methodId: pix.id, amountCents: det.totals.balance }], close: true });
        check('Só consulta: recebe conta aberta', r.status === 200 && r.data.balance === 0, r.data);
        check('Encerra o caixa de recebimento', (await caixaA.post('/api/day/close', { countedCashCents: 5000 })).status === 200);
        r = await one.post(`/api/plataforma/restaurantes/${ids.alfa}/pagamento`, {});
        const novo = r.data.venceEm;
        check('Pagamento registrado: novo vencimento (+1 mês) e volta a Ativo', r.status === 200 && r.data.licencaStatus === 'ATIVO' && novo > somaDias(hoje, 27) && novo < somaDias(hoje, 32), r.data);
        r = await caixaA.post('/api/day/open', { openingCashCents: 10000 });
        check('Depois do pagamento: abre o dia', r.status === 200 && !r.data.somenteReceber, r.data);
        await caixaA.post('/api/day/close', { countedCashCents: 10000 });
        await one.patch(`/api/plataforma/restaurantes/${ids.alfa}`, { licencaStatus: 'SO_CONSULTA' });
        r = await caixaA.post('/api/day/open', { openingCashCents: 10000 });
        check('"Só consulta" definido pela ONE UP também bloqueia o abrir o dia', r.status === 409 && r.data.code === 'LICENCA_SO_CONSULTA', r.data);
        await one.patch(`/api/plataforma/restaurantes/${ids.alfa}`, { licencaStatus: 'ATIVO' });
        const aud = (await pgc.query(`SELECT message FROM audit_logs WHERE empresa_id=$1 AND action='licenca.status' ORDER BY id`, [ids.alfa])).rows.map((x) => x.message);
        check('Dono vê na Auditoria a mudança de licença (sem valores)', aud.length >= 2 && aud.every((m) => !/R\$/.test(m)), aud);
    }
    console.log('\n[6] Suspenso: a equipe não entra, a ONE UP entra');
    {
        const donoB = await new C('beta').login('admin', 'beta-admin');
        await one.patch(`/api/plataforma/restaurantes/${ids.beta}`, { licencaStatus: 'SUSPENSO' });
        let r = await new C('beta').post('/api/auth/login', { username: 'admin', password: 'beta-admin' });
        check('Dono suspenso não entra: "Acesso suspenso — fale com a ONE UP"', r.status === 403 && r.data.code === 'LICENCA_SUSPENSA' && /Acesso suspenso — fale com a ONE UP/.test(r.data.error), r.data);
        r = await new C('beta').post('/api/auth/login', { username: 'caixa', password: 'beta-caixa' });
        check('Caixa suspenso não entra', r.status === 403 && r.data.code === 'LICENCA_SUSPENSA', r.data);
        r = await new C('beta').post('/api/auth/login', { username: 'admin', password: 'senha-errada' });
        check('Senha errada continua "usuário ou senha incorretos" (não revela a suspensão)', r.status === 400, r.data);
        r = await donoB.get('/api/auth/me');
        check('Sessão já aberta da equipe é barrada na API', r.status === 403 && r.data.code === 'LICENCA_SUSPENSA', r.data);
        const oneB = new C('beta');
        r = await oneB.post('/api/auth/login', { username: 'lucas', password: 'oneup-12345' });
        check('ONE UP entra no restaurante suspenso', r.status === 200, r.data);
        check('ONE UP usa a API no restaurante suspenso', (await oneB.get('/api/settings')).status === 200);
        const meta = (await new C('beta').get('/api/meta')).data;
        check('Tela de entrada sabe que está suspenso (sem datas/valores)', meta.acessoSuspenso === true && !/vence|mensal/i.test(JSON.stringify(meta)), meta);
        check('Suspenso: cardápio online fora do ar', (await new C('beta').get('/api/public/menu')).data.foraDoAr === true);
        const l = await lista();
        check('Carteira: 1 suspenso e MRR só dos ativos (199)', l.carteira.suspensos === 1 && l.carteira.mrrCents === 19900, l.carteira);
        await one.patch(`/api/plataforma/restaurantes/${ids.beta}`, { licencaStatus: 'ATIVO' });
        r = await new C('beta').post('/api/auth/login', { username: 'admin', password: 'beta-admin' });
        check('Reativado: o Dono volta a entrar', r.status === 200, r.data);
    }
    console.log('\n[7] Cobrar no WhatsApp (um toque, nunca automático)');
    {
        let r = await one.get(`/api/plataforma/restaurantes/${ids.alfa}/cobranca`);
        check('Mensagem pronta com restaurante e valor', r.status === 200 && /Alfa/.test(r.data.mensagem) && /199,00/.test(r.data.mensagem) && r.data.link.startsWith('https://wa.me/5511912345678?text='), r.data);
        check('Ainda não registrou envio (só preparou)', (await linha('alfa')).cobrancaEnviadaEm === null);
        const editada = 'Olá! Mensagem editada pela ONE UP: sua mensalidade vence logo.';
        r = await one.post(`/api/plataforma/restaurantes/${ids.alfa}/cobranca`, { mensagem: editada });
        check('Envio registrado e link com o texto editado', r.status === 200 && r.data.link === `https://wa.me/5511912345678?text=${encodeURIComponent(editada)}`, r.data);
        check('Central mostra quando a cobrança foi enviada', !!(await linha('alfa')).cobrancaEnviadaEm);
        const h = (await one.get(`/api/plataforma/restaurantes/${ids.alfa}/historico`)).data;
        check('Cobrança no histórico com a mensagem enviada', h.some((x) => x.tipo === 'COBRANCA' && x.depois?.mensagem === editada));
        r = await one.get(`/api/plataforma/restaurantes/${ids.beta}/cobranca`);
        check('Sem WhatsApp do Dono: pede para cadastrar', r.status === 400, r.data);
    }
    console.log('\n[8] Criar restaurante pela tela');
    {
        check('Endereço inválido recusado', (await one.post('/api/plataforma/restaurantes', { nome: 'Cantina', slug: 'Cantina Nova!', donoNome: 'Maria' })).status === 400);
        check('Endereço reservado recusado', (await one.post('/api/plataforma/restaurantes', { nome: 'Cantina', slug: 'www', donoNome: 'Maria' })).status === 400);
        check('Endereço já usado recusado', (await one.post('/api/plataforma/restaurantes', { nome: 'Cantina', slug: 'alfa', donoNome: 'Maria' })).status === 409);
        check('Checagem do endereço na tela', (await one.get('/api/plataforma/slug/alfa')).data.ok === false && (await one.get('/api/plataforma/slug/cantina-nova')).data.ok === true);
        const r = await one.post('/api/plataforma/restaurantes', {
            nome: 'Cantina Nova', slug: 'cantina-nova', donoNome: 'Maria Teste', donoLogin: 'maria', donoWhatsapp: '21998765432',
            cardapio: 'exemplo', mensalidadeCents: 15000, plano: 'Essencial', licencaVenceEm: somaDias(hoje, 30),
        });
        check('Restaurante criado com senhas geradas (mostradas uma vez)', r.status === 200 && r.data.acessos.dono.login === 'maria' && r.data.acessos.dono.senha.length >= 10 && /^\d{6}$/.test(r.data.acessos.caixa.senha) && r.data.produtos > 20, r.data);
        const novo = await new C('cantina-nova').login('maria', r.data.acessos.dono.senha);
        await new C('cantina-nova').login('caixa', r.data.acessos.caixa.senha);
        await new C('cantina-nova').login('cozinha', r.data.acessos.cozinha.senha);
        check('Dono, Caixa e Cozinha entram com as senhas geradas', true);
        const menuNovo = (await novo.get('/api/menu')).data.flatMap((c) => c.products.map((p) => p.name));
        check('Restaurante novo recebe o cardápio genérico (nada do piloto)', menuNovo.includes('Prato do dia') && !menuNovo.some((n) => /espeto|heineken|monster|jantinha|cozumel/i.test(n)), menuNovo.slice(0, 6));
        const menuAlfa = (await donoA.get('/api/menu')).data.flatMap((c) => c.products.map((p) => p.name));
        check('Isolado: o restaurante novo não aparece no cardápio de outro', !menuAlfa.includes('Prato do dia'));
        const ehOneup = (await pgc.query(`SELECT oneup FROM users u JOIN empresas e ON e.id=u.empresa_id WHERE e.slug='cantina-nova' AND u.username='lucas'`)).rows[0];
        check('Acesso ONE UP criado no restaurante novo (mesma senha, invisível ao Dono)', ehOneup?.oneup === true);
        check('ONE UP entra no restaurante novo', (await new C('cantina-nova').post('/api/auth/login', { username: 'lucas', password: 'oneup-12345' })).status === 200);
        const vazio = await one.post('/api/plataforma/restaurantes', { nome: 'Lanche Vazio', slug: 'lanche-vazio', donoNome: 'João Teste', cardapio: 'vazio' });
        const nVazio = (await pgc.query(`SELECT count(*)::int n FROM products p JOIN empresas e ON e.id=p.empresa_id WHERE e.slug='lanche-vazio'`)).rows[0].n;
        check('Opção "cardápio vazio"', vazio.status === 200 && nVazio === 0, vazio.data);
        const l = await lista();
        check('Carteira: 4 restaurantes; MRR soma o novo (199 + 299 + 150)', l.carteira.restaurantes === 4 && l.carteira.mrrCents === 64800, l.carteira);
        const hc = (await one.get(`/api/plataforma/restaurantes/${r.data.empresa.id}/historico`)).data;
        check('Criação no histórico da plataforma', hc.some((x) => x.tipo === 'CRIACAO'));
    }
    console.log('\n[9] Relógio adiantado para 2099 (ONEUP_HOJE): ATIVO sem vencimento nunca vira só consulta');
    {
        await derrubar();
        await subir({ ONEUP_HOJE: '2099-06-15' });
        const caixaB = await new C('beta').login('caixa', 'beta-caixa');
        const donoB = await new C('beta').login('admin', 'beta-admin');
        const s = (await donoB.get('/api/settings')).data;
        check('2099: empresa ATIVA sem vencimento continua Ativa, sem aviso', s.licenca.status === 'ATIVO' && s.licenca.venceEm === null && s.licenca.avisar === false, s.licenca);
        const r = await caixaB.post('/api/day/open', { openingCashCents: 0 });
        check('2099: abre o dia normalmente', r.status === 200 && !r.data.somenteReceber, r.data);
        check('2099: cardápio online no ar', !(await new C('beta').get('/api/public/menu')).data.foraDoAr);
        const one2 = await new C('alfa').login('lucas', 'oneup-12345');
        const l = (await one2.get('/api/plataforma/restaurantes')).data;
        const b = l.restaurantes.find((x) => x.slug === 'beta');
        const a = l.restaurantes.find((x) => x.slug === 'alfa');
        check('2099: Central mostra a empresa sem vencimento como Ativa', b.efetivo === 'ATIVO' && b.diasParaVencer === null, b);
        check('2099: (controle) quem tem vencimento cai em só consulta', a.efetivo === 'SO_CONSULTA', a);
        await caixaB.post('/api/day/close', { countedCashCents: 0 });
    }
    await pgc.end();
}
main()
    .catch((e) => { failures.push(`erro: ${e.message}`); console.error(e); })
    .finally(async () => {
    await derrubar();
    console.log(`\n${passed} ok, ${failures.length} falha(s)${failures.length ? ':\n - ' + failures.join('\n - ') : ''}`);
    process.exit(failures.length ? 1 : 0);
});
