/**
 * Clientes e LGPD (3.3): cliente pelo telefone normalizado, tela Clientes do Dono (corrigir, parar ofertas, juntar,
 * apagar dados, exportar), auditoria sem dados pessoais, busca do caixa (3+ letras, telefone mascarado, limite),
 * retenção, código de acompanhamento que expira 48 h depois e política de privacidade.
 *
 *   createdb ag_cli; DATABASE_URL=.../ag_cli node dist/scripts/setup.js --empresa=cli --nome="Restaurante Teste" \
 *     --admin-pass=cli-admin --caixa-pass=cli-caixa --cozinha-pass=cli-coz --cardapio=piloto
 *   DATABASE_URL=.../ag_cli EMPRESA_HEADER=true PORT=3508 node dist/index.js &
 *   DATABASE_URL=.../ag_cli BASE_URL=http://localhost:3508 node dist/scripts/clientes-test.js
 */
import pg from 'pg';
import { closePools, db, runAsEmpresa } from '../db/index.js';
import { aplicarRetencao } from '../services/clientes.js';
import { mascararTelefone, normalizarWhatsapp } from '../lib/telefone.js';
const BASE = process.env.BASE_URL ?? 'http://localhost:3508';
const DB_URL = process.env.DATABASE_URL;
const EMP = process.env.EMPRESA ?? 'cli';
let passed = 0;
const failures = [];
function check(label, cond, extra) {
    if (cond) {
        passed++;
        console.log(`  ✔ ${label}`);
    }
    else {
        failures.push(label);
        console.log(`  ✘ ${label}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 600));
    }
}
class C {
    ua;
    jar = new Map();
    constructor(ua = 'Mozilla/5.0 (Linux; Android 14) Teste') {
        this.ua = ua;
    }
    async req(method, path, body, extra = {}) {
        const res = await fetch(BASE + path, {
            method,
            headers: {
                'x-empresa': EMP, 'user-agent': this.ua, ...extra,
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
        return { status: res.status, data, text, headers: res.headers };
    }
    get = (p) => this.req('GET', p);
    post = (p, b = {}, h = {}) => this.req('POST', p, b, h);
    patch = (p, b) => this.req('PATCH', p, b);
    async login(u, p) { const r = await this.post('/api/auth/login', { username: u, password: p }); if (r.status !== 200)
        throw new Error(`login ${u}: ${r.status} ${JSON.stringify(r.data)}`); return r; }
}
async function main() {
    const pgc = new pg.Client({ connectionString: DB_URL });
    await pgc.connect();
    const q = async (s, p = []) => (await pgc.query(s, p)).rows;
    const [{ id: EID }] = await q(`SELECT id FROM empresas WHERE slug = $1`, [EMP]);
    const [{ inicio }] = await q(`SELECT max(id) AS inicio FROM audit_logs`);
    const dono = new C();
    await dono.login('admin', 'cli-admin');
    const caixa = new C();
    await caixa.login('caixa', 'cli-caixa');
    const cozinha = new C();
    await cozinha.login('cozinha', 'cli-coz');
    const publico = new C('Mozilla/5.0 (iPhone) Cliente');
    await dono.req('PATCH', '/api/settings', { qrEnabled: true, isOpen: true, whatsappNumber: '61988887777' });
    if ((await caixa.get('/api/register/current')).data?.register == null)
        await caixa.post('/api/register/open', { openingCashCents: 10000 });
    const menu = (await dono.get('/api/menu?all=1')).data;
    const prod = menu.flatMap((c) => c.products).find((p) => p.active !== false && !p.trackStock && !(p.groups ?? []).some((g) => g.required));
    const metodos = (await caixa.get('/api/payment-methods')).data;
    const pix = metodos.find((m) => !m.isCash) ?? metodos[0];
    const cliente = async (id) => (await q(`SELECT * FROM customers WHERE id = $1`, [id]))[0];
    const contaCli = async (accId) => (await q(`SELECT customer_id FROM accounts WHERE id = $1`, [accId]))[0].customer_id;
    console.log('\n[0] Regras do telefone');
    check('Formatos diferentes viram os mesmos dígitos', normalizarWhatsapp('(61) 99876-5432') === '61998765432' && normalizarWhatsapp('+55 61 99876-5432') === '61998765432' && normalizarWhatsapp('61998765432') === '61998765432');
    check('Fixo vale; número curto não', normalizarWhatsapp('(61) 3333-4444') === '6133334444' && normalizarWhatsapp('1234') === null);
    check('Máscara do caixa: (61) 9****-5432', mascararTelefone('61998765432') === '(61) 9****-5432', mascararTelefone('61998765432'));
    console.log('\n[1] Mesmo telefone em formatos diferentes = um cliente');
    const a1 = await caixa.post('/api/accounts', { customerName: 'Maria Teste', phone: '(61) 99876-5432', items: [] });
    check('Caixa abre conta com telefone formatado', a1.status === 200, a1.data);
    const pub1 = await publico.post('/api/public/orders', { customerName: 'Maria T.', phone: '61998765432', aceitaOfertas: true, mode: 'BALCAO', items: [{ productId: prod.id, quantity: 1 }] }, { 'x-aparelho': 'aparelho-teste-0001' });
    check('Cardápio aceita o pedido com só dígitos', pub1.status === 200, pub1.data);
    const a3 = await caixa.post('/api/accounts', { customerName: 'Maria Teste', phone: '+55 61 99876-5432', items: [{ productId: prod.id, quantity: 2 }] });
    const [accPub] = await q(`SELECT a.id FROM accounts a JOIN orders o ON o.account_id = a.id WHERE o.public_token = $1`, [pub1.data.token]);
    const ids = [await contaCli(a1.data.id), await contaCli(accPub.id), await contaCli(a3.data.id)];
    const MARIA = ids[0];
    check('As 3 contas apontam para o MESMO cliente', MARIA && ids.every((i) => i === MARIA), ids);
    const [{ n: nMaria }] = await q(`SELECT count(*)::int n FROM customers WHERE regexp_replace(coalesce(phone,''),'\\D','','g') = '61998765432'`);
    check('Só um cadastro com esse telefone (gravado só com dígitos)', nMaria === 1 && (await cliente(MARIA)).phone === '61998765432', nMaria);
    check('Nome é atributo: atualiza para o último informado', (await cliente(MARIA)).name === 'Maria Teste');
    check('Aceite de ofertas do cardápio gravado (data e texto)', (await cliente(MARIA)).aceita_ofertas === true && !!(await cliente(MARIA)).aceita_ofertas_texto);
    console.log('\n[2] Corrigir o telefone na conta não duplica o cliente');
    const b1 = await caixa.post('/api/accounts', { customerName: 'João Silva', phone: '(61) 98888-0000', items: [] });
    const JOAO = await contaCli(b1.data.id);
    const [{ n: antes }] = await q(`SELECT count(*)::int n FROM customers`);
    const corr = await caixa.patch(`/api/accounts/${b1.data.id}`, { customerName: 'João Silva', phone: '(61) 98888-0001' });
    const [{ n: depois }] = await q(`SELECT count(*)::int n FROM customers`);
    check('Correção aceita', corr.status === 200, corr.data);
    check('Mesmo cliente, telefone corrigido, nenhum cadastro novo', (await contaCli(b1.data.id)) === JOAO && (await cliente(JOAO)).phone === '61988880001' && antes === depois, { antes, depois });
    const inval = await caixa.post('/api/accounts', { customerName: 'Pedro Casa', phone: '1234', items: [] });
    const PEDRO = await contaCli(inval.data.id);
    check('Telefone inválido vira contato livre (não telefone)', !!PEDRO && (await cliente(PEDRO)).phone === null && /1234/.test((await cliente(PEDRO)).contact ?? ''), await cliente(PEDRO));
    console.log('\n[3] Auditoria sem dados pessoais');
    // conta a receber (fiado) com nome e casa: a auditoria cita só a conta e o cliente #id
    const c1 = await caixa.post('/api/accounts', { customerName: 'Carlos Fiado', items: [{ productId: prod.id, quantity: 1 }] });
    const pend = await caixa.post(`/api/accounts/${c1.data.id}/pending`, { customerName: 'Carlos Fiado', contact: 'Casa 12' });
    check('Marca como PENDENTE', pend.status === 200, pend.data);
    await caixa.patch(`/api/accounts/${a1.data.id}`, { customerName: 'Maria Teste', phone: '(61) 99876-5432', note: 'mesa da piscina' });
    const aud = await q(`SELECT message, data::text AS data FROM audit_logs WHERE id > $1 ORDER BY id`, [inicio ?? 0]);
    const tudo = aud.map((x) => `${x.message} ${x.data ?? ''}`).join('\n');
    check('Nenhuma mensagem nova com nome, telefone ou casa', !/Maria|Jo[aã]o|Carlos|Pedro|Casa 12|99876|98888|5432/.test(tudo), aud.filter((x) => /Maria|Jo[aã]o|Carlos|Casa 12|99876|98888/.test(`${x.message} ${x.data}`)).slice(0, 4));
    check('PENDENTE cita conta e cliente #id', aud.some((x) => /marcou a conta #\d+ \(cliente #\d+\) como PENDENTE/.test(x.message)));
    check('Pedido pelo QR cita só cliente #id e conta', aud.some((x) => /^Cliente #\d+ enviou pelo QR Code o pedido #\d+ da conta #\d+/.test(x.message)));
    check('Edição de identificação diz o que mudou, sem os valores', aud.some((x) => /alterou a identificação da conta #\d+ \(observação\)/.test(x.message) && !/piscina/.test(x.data ?? '')));
    console.log('\n[4] Busca do caixa');
    check('Menos de 3 letras: recusado', (await caixa.get('/api/customers/suggest?q=Ma')).status === 400);
    const sug = await caixa.get('/api/customers/suggest?q=Mar');
    const sMaria = sug.data.find((c) => c.id === MARIA);
    check('Caixa vê o telefone mascarado', sMaria?.phone === '(61) 9****-5432', sug.data);
    check('Caixa acha pelo fim do telefone (mascarado)', (await caixa.get('/api/customers/suggest?q=5432')).data.some((c) => c.id === MARIA && c.phone.includes('*')));
    const sugD = await dono.get('/api/customers/suggest?q=Mar');
    check('Dono vê o telefone completo', sugD.data.find((c) => c.id === MARIA)?.phone === '(61) 99876-5432', sugD.data);
    const viaSug = await caixa.post('/api/accounts', { customerId: MARIA, phone: sMaria.phone, items: [] });
    const [contaSug] = await q(`SELECT customer_id, customer_name, phone FROM accounts WHERE id = $1`, [viaSug.data.id]);
    check('Conta aberta pela sugestão leva o cliente pelo id (telefone real, não o mascarado)', contaSug.customer_id === MARIA && contaSug.customer_name === 'Maria Teste' && !String(contaSug.phone).includes('*'), contaSug);
    console.log('\n[5] Tela Clientes: só o Dono');
    for (const [nome, u] of [['Caixa', caixa], ['Cozinha', cozinha]]) {
        const rs = await Promise.all([u.get('/api/clientes'), u.post(`/api/clientes/${MARIA}/parar-ofertas`), u.post(`/api/clientes/${MARIA}/apagar`),
            u.post(`/api/clientes/${MARIA}/juntar`, { outroId: JOAO }), u.get(`/api/clientes/${MARIA}/exportar`), u.patch(`/api/clientes/${MARIA}`, { nome: 'X' })]);
        check(`${nome}: 403 em todas as rotas de clientes`, rs.every((r) => r.status === 403), rs.map((r) => r.status));
    }
    check('Busca da tela com menos de 3 letras: recusada', (await dono.get('/api/clientes?q=Ma')).status === 400);
    const lista = (await dono.get('/api/clientes?q=Mar')).data;
    const lMaria = lista.find((c) => c.id === MARIA);
    check('Lista mostra nome, telefone, nº de contas, último pedido e aceite', lMaria && lMaria.telefone === '(61) 99876-5432' && lMaria.contas === 4 && !!lMaria.ultimoPedido && lMaria.aceitaOfertas === true && !!lMaria.aceiteEm && !!lMaria.textoDoAceite, lMaria);
    const lCarlos = (await dono.get('/api/clientes?q=Carlos')).data[0];
    check('Saldo a receber aparece', lCarlos?.aReceberCents > 0, lCarlos);
    console.log('\n[6] Corrigir e parar ofertas');
    const cj = await dono.patch(`/api/clientes/${JOAO}`, { nome: 'João da Silva', telefone: '(61) 98888-0002' });
    check('Dono corrige nome e telefone', cj.status === 200 && (await cliente(JOAO)).name === 'João da Silva' && (await cliente(JOAO)).phone === '61988880002', cj.data);
    check('Telefone que já é de outro cliente: recusa e sugere juntar', (await dono.patch(`/api/clientes/${JOAO}`, { telefone: '61998765432' })).status === 409);
    const po = await dono.post(`/api/clientes/${MARIA}/parar-ofertas`);
    const mPos = await cliente(MARIA);
    check('Parar ofertas: zera o aceite e grava quando', po.status === 200 && mPos.aceita_ofertas === false && !!mPos.ofertas_revogadas_em, mPos);
    const [audPo] = await q(`SELECT message, user_id FROM audit_logs WHERE action = 'cliente.ofertas_revogadas' AND entity_id = $1`, [MARIA]);
    check('Auditoria: "cliente #id: ofertas revogadas" com quem fez', audPo && audPo.message.startsWith(`cliente #${MARIA}: ofertas revogadas`) && !!audPo.user_id, audPo);
    console.log('\n[7] Juntar duplicados');
    const dup = await caixa.post('/api/accounts', { customerName: 'Maria Teste', contact: 'Casa 5', items: [] });
    const DUP = await contaCli(dup.data.id);
    check('Sem telefone: cadastro separado (nome + casa)', DUP && DUP !== MARIA);
    const jt = await dono.post(`/api/clientes/${MARIA}/juntar`, { outroId: DUP });
    check('Juntar: o escolhido fica', jt.status === 200 && jt.data.contas === 1, jt.data);
    check('Contas do outro passam para o que fica; o outro fica marcado', (await contaCli(dup.data.id)) === MARIA && (await cliente(DUP)).juntado_em === MARIA);
    check('Juntado some da lista e da busca do caixa', !(await dono.get('/api/clientes?q=Maria')).data.some((c) => c.id === DUP) && !(await caixa.get('/api/customers/suggest?q=Maria')).data.some((c) => c.id === DUP));
    check('Contato que faltava passa para o que fica', (await cliente(MARIA)).contact === 'Casa 5');
    console.log('\n[8] Exportar os dados de um cliente');
    const ej = await dono.get(`/api/clientes/${MARIA}/exportar?formato=json`);
    check('JSON com o cadastro, o aceite e todas as contas', ej.status === 200 && ej.data.cliente.telefone === '61998765432' && ej.data.contas.length === 5 && 'textoDoAceite' in ej.data.cliente, { s: ej.status, n: ej.data?.contas?.length });
    const ec = await dono.get(`/api/clientes/${MARIA}/exportar?formato=csv`);
    check('CSV (planilha) para download', ec.status === 200 && /text\/csv/.test(ec.headers.get('content-type') ?? '') && /attachment/.test(ec.headers.get('content-disposition') ?? '') && ec.text.includes('conta;abertaEm'), ec.headers.get('content-type'));
    check('Exportação registrada sem dados pessoais', (await q(`SELECT 1 FROM audit_logs WHERE action = 'cliente.exportado' AND message = $1`, [`cliente #${MARIA}: dados exportados (CSV) a pedido do titular.`])).length === 1);
    console.log('\n[9] Apagar dados (anonimizar)');
    const bloq = await dono.post(`/api/clientes/${MARIA}/apagar`);
    check('Com conta aberta: não apaga e explica', bloq.status === 409 && /conta aberta ou a receber/.test(bloq.data.error), bloq.data);
    // fecha a conta com consumo (venda real) e cancela as vazias
    const t3 = (await caixa.get(`/api/accounts/${a3.data.id}`)).data.totals;
    const pg3 = await caixa.post(`/api/accounts/${a3.data.id}/payments`, { payments: [{ methodId: pix.id, amountCents: t3.balance }], close: true });
    check('Conta com consumo paga e encerrada', pg3.status === 200 && pg3.data.status === 'CLOSED', pg3.data);
    for (const id of [a1.data.id, accPub.id, viaSug.data.id, dup.data.id])
        await caixa.post(`/api/accounts/${id}/cancel`, { reason: 'teste de LGPD' });
    const [vendaAntes] = await q(`SELECT (SELECT count(*)::int FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.account_id = $1) itens, (SELECT sum(amount_cents)::int FROM payments WHERE account_id = $1) pago`, [a3.data.id]);
    const ap = await dono.post(`/api/clientes/${MARIA}/apagar`);
    check('Apaga quando não há conta aberta', ap.status === 200, ap.data);
    const mAn = await cliente(MARIA);
    check('Cadastro anonimizado (nome genérico, sem telefone/contato, ofertas revogadas)', mAn.name === `Cliente anonimizado #${MARIA}` && mAn.phone === null && mAn.contact === null && !!mAn.anonimizado_em && mAn.aceita_ofertas === false && !!mAn.ofertas_revogadas_em, mAn);
    check('Juntado junto também anonimizado', !!(await cliente(DUP)).anonimizado_em && (await cliente(DUP)).contact === null);
    const contasM = await q(`SELECT customer_name, phone, contact, status FROM accounts WHERE customer_id = $1`, [MARIA]);
    check('Contas encerradas/canceladas sem nome, telefone e contato', contasM.length === 5 && contasM.every((c) => c.customer_name === null && c.phone === null && c.contact === null), contasM);
    const [vendaDepois] = await q(`SELECT (SELECT count(*)::int FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.account_id = $1) itens, (SELECT sum(amount_cents)::int FROM payments WHERE account_id = $1) pago, (SELECT status FROM accounts WHERE id = $1) status`, [a3.data.id]);
    check('As vendas continuam (itens, pagamento, conta encerrada)', vendaDepois.itens === vendaAntes.itens && vendaDepois.pago === vendaAntes.pago && vendaDepois.status === 'CLOSED', { vendaAntes, vendaDepois });
    const audAn = await q(`SELECT message, data::text d FROM audit_logs WHERE entity_type = 'customer' AND entity_id = $1`, [MARIA]);
    check('Auditoria da anonimização sem telefone nem nome', audAn.some((x) => /dados apagados a pedido/.test(x.message)) && !audAn.some((x) => /99876|Maria|5432/.test(`${x.message} ${x.d}`)), audAn);
    check('Anonimizado some da busca do caixa e da lista', !(await caixa.get('/api/customers/suggest?q=anonimizado')).data.length && !(await dono.get('/api/clientes?q=anonimizado')).data.length);
    check('Apagar de novo: avisa que já foi apagado', (await dono.post(`/api/clientes/${MARIA}/apagar`)).status === 409);
    const volta = await caixa.post('/api/accounts', { customerName: 'Maria Voltou', phone: '61998765432', items: [] });
    const NOVA = await contaCli(volta.data.id);
    check('Mesmo telefone depois de apagar: cadastro novo (o antigo não volta)', NOVA && NOVA !== MARIA);
    await caixa.post(`/api/accounts/${volta.data.id}/cancel`, { reason: 'teste de LGPD' });
    console.log('\n[10] Código de acompanhamento expira 48 h depois');
    const pub2 = await publico.post('/api/public/orders', { customerName: 'Ana Pedido', phone: '61977776666', mode: 'BALCAO', items: [{ productId: prod.id, quantity: 1 }] }, { 'x-aparelho': 'aparelho-teste-0002' });
    const tk = pub2.data.token;
    check('Acompanhamento responde enquanto o pedido anda', (await publico.get(`/api/public/pedido/${tk}`)).status === 200);
    await q(`UPDATE orders SET status = 'DELIVERED', delivered_at = now() - interval '47 hours' WHERE public_token = $1`, [tk]);
    check('Entregue há 47 h: ainda responde', (await publico.get(`/api/public/pedido/${tk}`)).status === 200);
    await q(`UPDATE orders SET delivered_at = now() - interval '49 hours' WHERE public_token = $1`, [tk]);
    const exp = await publico.get(`/api/public/pedido/${tk}`);
    check('Entregue há 49 h: "acompanhamento encerrado"', exp.status === 410 && exp.data.encerrado === true && /Acompanhamento encerrado/.test(exp.data.error), exp.data);
    check('…sem itens nem número do pedido na resposta', !('itens' in (exp.data ?? {})) && !('numero' in (exp.data ?? {})));
    console.log('\n[11] Retenção (24 meses sem pedido)');
    const [velho] = await q(`INSERT INTO customers (empresa_id, name, phone, created_at) VALUES ($1, 'Cliente Antigo', '61955554444', now() - interval '25 months') RETURNING id`, [EID]);
    const [ativo] = await q(`INSERT INTO customers (empresa_id, name, phone, created_at) VALUES ($1, 'Cliente Ativo', '61955553333', now() - interval '30 months') RETURNING id`, [EID]);
    const ca = await caixa.post('/api/accounts', { customerName: 'Cliente Ativo', phone: '61955553333', items: [] });
    check('Conta recente liga ao cadastro antigo pelo telefone', (await contaCli(ca.data.id)) === ativo.id);
    const [fiadoVelho] = await q(`INSERT INTO customers (empresa_id, name, phone, created_at) VALUES ($1, 'Fiado Antigo', '61955552222', now() - interval '30 months') RETURNING id`, [EID]);
    await q(`UPDATE accounts SET customer_id = $1, opened_at = now() - interval '26 months' WHERE id = $2`, [fiadoVelho.id, c1.data.id]);
    const n = await runAsEmpresa(EID, () => db.transaction((tx) => aplicarRetencao(tx)));
    check('Rotina anonimiza quem está há 24 meses sem pedido', n >= 1 && !!(await cliente(velho.id)).anonimizado_em && (await cliente(velho.id)).phone === null, { n });
    check('Quem pediu nos últimos 24 meses fica', !(await cliente(ativo.id)).anonimizado_em);
    check('Quem tem saldo a receber fica (mesmo antigo)', !(await cliente(fiadoVelho.id)).anonimizado_em);
    check('Retenção registrada sem dados pessoais', (await q(`SELECT 1 FROM audit_logs WHERE action = 'cliente.retencao' AND entity_id = $1 AND message NOT LIKE '%Antigo%'`, [velho.id])).length === 1);
    await caixa.post(`/api/accounts/${ca.data.id}/cancel`, { reason: 'teste de LGPD' });
    console.log('\n[12] Política de privacidade');
    const pag = await publico.get('/privacidade');
    check('/privacidade abre (página pública)', pag.status === 200 && /<html/i.test(pag.text) || pag.status === 200, pag.status);
    const pol = await publico.get('/api/public/privacidade');
    const txt = JSON.stringify(pol.data);
    const [{ name: restaurante }] = await q(`SELECT name FROM restaurant_settings WHERE empresa_id = $1`, [EID]);
    check('Política com o nome do restaurante (controlador) e o WhatsApp dele', pol.status === 200 && txt.includes(restaurante) && txt.includes('(61) 98888-7777'), pol.data?.secoes?.[0]);
    check('…cita a ONE UP como operadora, os dados, a finalidade, o prazo e como pedir exclusão', /operadora/.test(txt) && /ONE UP/.test(txt) && /Nome e WhatsApp/.test(txt) && /24 meses/.test(txt) && /apagar/.test(txt));
    console.log('\n[13] Limite de buscas do caixa');
    let bloqueou = 0;
    for (let i = 0; i < 70 && !bloqueou; i++) {
        const r = await caixa.get(`/api/customers/suggest?q=Jo%C3%A3o${i % 3}`);
        if (r.status === 429)
            bloqueou = i + 1;
    }
    check('Depois de 60 buscas em 5 min, o caixa recebe "aguarde" (429)', bloqueou > 0 && bloqueou <= 61, bloqueou);
    check('O limite é por usuário (o Dono continua buscando)', (await dono.get('/api/customers/suggest?q=Jo%C3%A3o')).status === 200);
    await pgc.end();
}
main()
    .catch((e) => { console.error(e); failures.push(`erro: ${e.message}`); })
    .finally(async () => {
    await closePools().catch(() => undefined);
    console.log(`\n${passed} ok, ${failures.length} falha(s)`);
    if (failures.length) {
        console.log(failures.map((f) => ` - ${f}`).join('\n'));
        process.exit(1);
    }
    process.exit(0);
});
