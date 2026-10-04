/**
 * Teste automatizado do cenário de aceite da V1 (seção 38 do briefing).
 * Uso: com o servidor rodando num banco de TESTE recém-configurado:
 *   BASE_URL=http://localhost:3000 node dist/scripts/e2e.js
 */
import { io } from 'socket.io-client';
import pg from 'pg';
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const DB_URL = process.env.DATABASE_URL;
let passed = 0;
const failures = [];
export function check(label, cond, extra) {
    if (cond) {
        passed++;
        console.log(`  ✔ ${label}`);
    }
    else {
        failures.push(label);
        console.log(`  ✘ ${label}`, extra ?? '');
    }
}
export class Client {
    name;
    cookie = '';
    constructor(name) {
        this.name = name;
    }
    async req(method, path, body, extra) {
        const res = await fetch(BASE + path, {
            method,
            headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...(extra ?? {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        const set = res.headers.get('set-cookie');
        if (set)
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
    put = (p, b) => this.req('PUT', p, b);
    patch = (p, b) => this.req('PATCH', p, b);
    socket() {
        return new Promise((resolve, reject) => {
            const s = io(BASE, { extraHeaders: { cookie: this.cookie }, transports: ['websocket'] });
            s.on('connect', () => resolve(s));
            s.on('connect_error', reject);
        });
    }
}
export function waitEvent(s, ev, ms = 3000) {
    return new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), ms);
        s.once(ev, (p) => { clearTimeout(t); resolve(p ?? true); });
    });
}
async function main() {
    const admin = new Client('admin'), caixa = new Client('caixa'), coz = new Client('cozinha');
    console.log('\n[1-2] Administrador e cardápio');
    check('1. Administrador faz login', (await admin.post('/api/auth/login', { username: 'admin', password: 'admin123' })).status === 200);
    const menu = (await admin.get('/api/menu?all=1')).data;
    const find = (name) => menu.flatMap((c) => c.products).find((p) => p.name === name);
    const bebidas = menu.find((c) => c.name === 'Bebidas');
    const names = menu.map((c) => c.name);
    check('Cardápio R2 carregado (9 categorias, bebidas com preço real, Monster inativo)', ['Petiscos', 'Espetos', 'Pratos', 'Hambúrguer', 'Bebidas', 'Cervejas', 'Chope', 'Drinks', 'Outros'].every((n) => names.includes(n))
        && find('Coca-Cola lata')?.priceCents === 600 && find('Monster Mango Loco')?.active === false && find('Chope IPA 500 ml')?.priceCents === 1500, names);
    const chope = await admin.post('/api/products', { categoryId: bebidas.id, name: 'Chope Teste', priceCents: 1000, sendsToKitchen: false, groups: [] });
    check('2. Administrador cadastra produto (bebida)', chope.status === 200, chope.data);
    const batata = find('Batata Simples');
    const edit = await admin.put(`/api/products/${batata.id}`, { ...batata, description: 'Porção de batata', groups: [] });
    check('2. Administrador edita produto', edit.status === 200, edit.data);
    const espeto = find('Espeto de Coração');
    const farofa = espeto.groups[0].options[0];
    const strog = find('Strogonoff de Frango');
    const jantinha = find('Jantinha Completa');
    console.log('\n[3-9] Caixa, conta e total');
    check('3. Caixa faz login', (await caixa.post('/api/auth/login', { username: 'caixa', password: 'caixa123' })).status === 200);
    check('Caixa fechado bloqueia nova conta', (await caixa.post('/api/accounts', { tableLabel: 'Mesa 1' })).status === 409);
    check('4. Caixa abre o caixa (R$ 200)', (await caixa.post('/api/register/open', { openingCashCents: 20000 })).status === 200);
    check('Kitchen login', (await coz.post('/api/auth/login', { username: 'cozinha', password: 'cozinha123' })).status === 200);
    const kSock = await coz.socket();
    const cSock = await caixa.socket();
    const kitchenNew = waitEvent(kSock, 'kitchen:new');
    const acc = await caixa.post('/api/accounts', {
        customerName: '', note: 'camisa azul, próximo à piscina',
        items: [
            { productId: batata.id, quantity: 1 },
            { productId: chope.data.id, quantity: 2 },
            { productId: espeto.id, quantity: 1, optionIds: [farofa.id] },
            // tentativa de manipular preço pelo navegador: campo ignorado
            { productId: strog.id, quantity: 1, optionIds: [strog.groups[0].options[1].id], unitPriceCents: 1 },
        ],
    });
    check('5-6. Nova conta criada sem nome', acc.status === 200 && acc.data.orderNumber, acc.data);
    const accId = acc.data.id;
    let detail = (await caixa.get(`/api/accounts/${accId}`)).data;
    check('7. Observação registrada', detail.note === 'camisa azul, próximo à piscina' && detail.customerName === null);
    // 25 + 2×10 + (13+5) + (25,99+3) = 91,99
    check('8-9. Total calculado no servidor (R$ 91,99, preço manipulado ignorado)', detail.totals.total === 9199, detail.totals);
    check('Opção obrigatória validada (jantinha sem espeto é recusada)', (await caixa.post(`/api/accounts/${accId}/orders`, { items: [{ productId: jantinha.id, quantity: 1 }] })).status === 400);
    check('Quantidade inválida recusada', (await caixa.post(`/api/accounts/${accId}/orders`, { items: [{ productId: batata.id, quantity: -1 }] })).status === 400);
    console.log('\n[10-14] Cozinha em tempo real');
    check('10-11. Tablet da cozinha recebe o pedido em tempo real', await kitchenNew);
    let kOrders = (await coz.get('/api/kitchen/orders')).data;
    const kOrder = kOrders.find((o) => o.account.id === accId);
    check('Cozinha vê só comida (chope fica fora do tablet)', kOrder && kOrder.items.length === 3 && !kOrder.items.some((i) => i.name === 'Chope Teste'), kOrder?.items);
    check('Cozinha sem acesso ao financeiro', (await coz.get('/api/dashboard')).status === 403 && (await coz.get(`/api/accounts/${accId}`)).status === 403);
    check('12. Cozinha inicia preparo', (await coz.post(`/api/kitchen/orders/${kOrder.id}/start`)).status === 200);
    const readyEv = waitEvent(cSock, 'order:ready');
    check('13. Cozinha marca como pronto', (await coz.post(`/api/kitchen/orders/${kOrder.id}/ready`)).status === 200);
    const readyPayload = await readyEv;
    check('14. Caixa recebe alerta de pronto com pedido e conta', readyPayload && readyPayload.orderNumber === kOrder.number && readyPayload.accountId === accId, readyPayload);
    check('Caixa marca pedido como entregue', (await caixa.post(`/api/orders/${kOrder.id}/deliver`)).status === 200);
    console.log('\n[15-18] Complemento na mesma conta');
    const kitchenNew2 = waitEvent(kSock, 'kitchen:new');
    const comp = await caixa.post(`/api/accounts/${accId}/orders`, {
        items: [{ productId: find('Carne de Sol com Mandioca').id, quantity: 1 }, { productId: jantinha.id, quantity: 1, optionIds: [jantinha.groups[0].options[3].id] }],
    });
    check('15-16. Caixa adiciona novo pedido à mesma conta', comp.status === 200, comp.data);
    const ev2 = await kitchenNew2;
    check('17. Cozinha recebe o complemento (sequência 2)', ev2 && ev2.sequence === 2, ev2);
    detail = (await caixa.get(`/api/accounts/${accId}`)).data;
    check('18. Conta continua aberta com 2 pedidos', detail.status === 'OPEN' && detail.orders.length === 2);
    check('Total atualizado (91,99 + 65 + 30 = R$ 186,99)', detail.totals.total === 18699, detail.totals);
    console.log('\n[19-25] Pagamento, desconto, cancelamento');
    const methods = (await caixa.get('/api/payment-methods')).data;
    const M = (c) => methods.find((m) => m.code === c).id;
    check('Pagamento maior que o saldo é recusado', (await caixa.post(`/api/accounts/${accId}/payments`, { payments: [{ methodId: M('PIX'), amountCents: 999999 }] })).status === 400);
    const p1 = await caixa.post(`/api/accounts/${accId}/payments`, { payments: [{ methodId: M('PIX'), amountCents: 10000 }] });
    check('19-20. Pagamento parcial (R$ 100 PIX)', p1.status === 200 && p1.data.status === 'PARTIALLY_PAID', p1.data);
    check('22. Com saldo, conta segue aberta (parcialmente paga)', p1.data.balance === 8699);
    check('Desconto sem motivo é recusado', (await caixa.post(`/api/accounts/${accId}/discounts`, { amountCents: 1000, reason: '' })).status === 400);
    check('23. Desconto registrado com motivo', (await caixa.post(`/api/accounts/${accId}/discounts`, { amountCents: 1000, reason: 'Item lançado em duplicidade' })).status === 200);
    detail = (await caixa.get(`/api/accounts/${accId}`)).data;
    check('23. Desconto guarda usuário e motivo', detail.discounts[0].userName === 'Caixa' && detail.discounts[0].reason === 'Item lançado em duplicidade' && detail.discounts[0].kind === 'ADJUSTMENT');
    const chopeItem = detail.orders[0].items.find((i) => i.productName === 'Chope Teste');
    check('Cancelamento sem motivo é recusado', (await caixa.post(`/api/order-items/${chopeItem.id}/cancel`, { reason: '' })).status === 400);
    check('24. Cancelamento de item com motivo', (await caixa.post(`/api/order-items/${chopeItem.id}/cancel`, { reason: 'Cliente desistiu' })).status === 200);
    detail = (await caixa.get(`/api/accounts/${accId}`)).data;
    const cancelled = detail.orders[0].items.find((i) => i.id === chopeItem.id);
    check('24. Item fica CANCELADO (não apagado) com usuário e motivo', cancelled.status === 'CANCELLED' && cancelled.cancellation.reason === 'Cliente desistiu' && cancelled.cancellation.userName === 'Caixa');
    check('24. Item já entregue fica marcado como perda', cancelled.cancellation.wasInPreparation === true);
    // 186,99 - 10 desconto - 20 chope = 156,99 ; pago 100 ; saldo 56,99
    check('Saldo recalculado (R$ 56,99)', detail.totals.balance === 5699, detail.totals);
    check('Encerrar com saldo é recusado', (await caixa.post(`/api/accounts/${accId}/close`)).status === 409);
    const p2 = await caixa.post(`/api/accounts/${accId}/payments`, {
        payments: [{ methodId: M('DINHEIRO'), amountCents: 3000, tenderedCents: 5000 }, { methodId: M('CARTAO'), amountCents: 2699 }],
        close: true,
    });
    check('21. Combinação dinheiro (com troco) + cartão', p2.status === 200, p2.data);
    check('25. Quitada, conta encerrada', p2.data.status === 'CLOSED' && p2.data.balance === 0);
    check('Conta encerrada não recebe pedidos', (await caixa.post(`/api/accounts/${accId}/orders`, { items: [{ productId: batata.id, quantity: 1 }] })).status === 409);
    console.log('\n[29] Conta pendente');
    const acc2 = await caixa.post('/api/accounts', { tableLabel: 'Mesa 2', items: [{ productId: find('Frango à Passarinho').id, quantity: 1 }, { productId: chope.data.id, quantity: 3 }] });
    const acc2Id = acc2.data.id;
    await caixa.post(`/api/accounts/${acc2Id}/payments`, { payments: [{ methodId: M('PIX'), amountCents: 3000 }] });
    check('Pendente sem nome/contato é recusada', (await caixa.post(`/api/accounts/${acc2Id}/pending`, { customerName: '', contact: '' })).status === 400);
    check('Marca pendente com nome + casa', (await caixa.post(`/api/accounts/${acc2Id}/pending`, { customerName: 'João', contact: 'casa 12' })).status === 200);
    const recv = (await admin.get('/api/accounts/receivable')).data;
    const pend = recv.find((a) => a.id === acc2Id);
    check('29. Admin consulta contas a receber (total 78, pago 30, pendente 48)', pend && pend.total === 7800 && pend.paid === 3000 && pend.balance === 4800, pend);
    check('Pendente não recebe novos pedidos', (await caixa.post(`/api/accounts/${acc2Id}/orders`, { items: [{ productId: batata.id, quantity: 1 }] })).status === 409);
    console.log('\n[31] Alteração de preço não mexe em vendas antigas');
    const batataNow = (await admin.get('/api/menu?all=1')).data.flatMap((c) => c.products).find((p) => p.id === batata.id);
    await admin.put(`/api/products/${batata.id}`, { ...batataNow, priceCents: 2900, groups: [] });
    detail = (await caixa.get(`/api/accounts/${accId}`)).data;
    const oldBatata = detail.orders[0].items.find((i) => i.productName === 'Batata Simples');
    check('31. Venda antiga continua R$ 25,00 após preço mudar para R$ 29,00', oldBatata.unitPriceCents === 2500 && detail.totals.total === 15699);
    console.log('\n[16/Reabertura] Reabertura e estorno');
    check('Caixa não pode reabrir conta', (await caixa.post(`/api/accounts/${accId}/reopen`, { reason: 'teste' })).status === 403);
    check('Admin reabre conta com motivo', (await admin.post(`/api/accounts/${accId}/reopen`, { reason: 'Cliente esqueceu de pagar um chope' })).status === 200);
    const addAfter = await caixa.post(`/api/accounts/${accId}/orders`, { items: [{ productId: chope.data.id, quantity: 1 }] });
    detail = (await caixa.get(`/api/accounts/${accId}`)).data;
    check('Conta reaberta recebe o chope esquecido (balcão, sem cozinha)', addAfter.status === 200 && detail.status === 'PARTIALLY_PAID' && detail.totals.balance === 1000 && detail.orders[2].status === 'DELIVERED', detail.totals);
    await caixa.post(`/api/accounts/${accId}/payments`, { payments: [{ methodId: M('PIX'), amountCents: 1000 }], close: true });
    console.log('\n[Pendência paga depois / fechamento de caixa]');
    const regNow = (await caixa.get('/api/register/current')).data;
    const regAdmin = (await admin.get('/api/register/current')).data;
    const pix = regAdmin.summary.byMethod.find((m) => m.code === 'PIX').cents;
    const din = regAdmin.summary.byMethod.find((m) => m.code === 'DINHEIRO').cents;
    const car = regAdmin.summary.byMethod.find((m) => m.code === 'CARTAO').cents;
    check('28. Totais por forma corretos (admin)', pix === 14000 && din === 3000 && car === 2699, { pix, din, car });
    check('Fechamento às cegas: caixa não vê esperado, PIX, cartão nem total', regNow.blind === true && regNow.summary.expectedCashCents === null
        && regNow.summary.byMethod.length === 0 && regNow.summary.salesCents === null && regNow.summary.receivedCents === null, regNow.summary);
    check('Dinheiro esperado (admin) = 200 abertura + 30 recebido', regAdmin.summary.expectedCashCents === 23000, regAdmin.summary.expectedCashCents);
    check('Resumo (admin) mostra pendência criada no caixa', regAdmin.summary.pendingCreated.length === 1 && regAdmin.summary.pendingCreatedCents === 4800);
    check('Resumo (admin) mostra desconto por operador', regAdmin.summary.discountsByUser[0]?.name === 'Caixa' && regAdmin.summary.discountsCents === 1000);
    check('Sangria registrada', (await caixa.post('/api/register/movements', { type: 'SANGRIA', amountCents: 5000, reason: 'Troco para o banco' })).status === 200);
    const close = await caixa.post('/api/register/close', { countedCashCents: 17000 });
    const vazou = ['expectedCashCents', 'differenceCents', 'receivedCents', 'summary'].filter((k) => k in (close.data ?? {}));
    check('Fechamento do caixa: só "contagem registrada", sem esperado nem diferença', close.status === 200 && close.data.cego === true && vazou.length === 0, close.data);
    check('Diferença de R$ 10 acima da tolerância (R$ 5): "confira com o responsável"', close.data.conferir === true);
    const fechado = (await admin.get(`/api/registers/${close.data.id}`)).data;
    check('Admin vê: esperado 180, contado 170, diferença -10', fechado.register.expectedCashCents === 18000 && fechado.register.differenceCents === -1000, fechado.register);
    // Pendência paga no dia seguinte entra no novo caixa
    await caixa.post('/api/register/open', { openingCashCents: 10000 });
    const payLater = await caixa.post(`/api/accounts/${acc2Id}/payments`, { payments: [{ methodId: M('PIX'), amountCents: 4800 }], close: true });
    check('Pendência quitada depois e encerrada', payLater.status === 200 && payLater.data.status === 'CLOSED', payLater.data);
    const reg2 = (await admin.get('/api/register/current')).data;
    check('Recebimento da pendência entra no caixa do dia em que foi pago', reg2.summary.fromPreviousPendingCents === 4800 && reg2.summary.receivedCents === 4800);
    console.log('\n[26-27, 30] Histórico e dashboard');
    const log = (await admin.get('/api/audit')).data;
    const msgs = log.map((l) => l.message).join('\n');
    check('26/30. Histórico registra abertura, pedido, pronto, desconto, pagamento, encerramento', /abriu a conta/.test(msgs) && /marcou como PRONTO/.test(msgs) && /ajuste de R\$ 10,00/.test(msgs) && /recebeu/.test(msgs) && /encerrou a conta/.test(msgs) && /reabriu/.test(msgs));
    check('Histórico registra alteração de preço', /preço R\$ 25,00 → R\$ 29,00/.test(msgs));
    const dash = (await admin.get('/api/dashboard')).data;
    check('27. Venda aparece no dashboard', dash.revenueCents > 0 && dash.ordersCount >= 4, dash);
    check('Dashboard mostra cancelamentos e descontos', dash.cancellationsCount >= 1 && dash.discountsCents === 1000);
    check('Caixa não acessa dashboard nem usuários', (await caixa.get('/api/dashboard')).status === 403 && (await caixa.get('/api/users')).status === 403);
    console.log('\n[32] Nada é apagado');
    if (DB_URL) {
        const c = new pg.Client({ connectionString: DB_URL });
        await c.connect();
        let blocked = false;
        try {
            await c.query('DELETE FROM orders WHERE id = (SELECT MIN(id) FROM orders)');
        }
        catch {
            blocked = true;
        }
        let frozen = false;
        try {
            await c.query('UPDATE order_items SET unit_price_cents = 1 WHERE id = (SELECT MIN(id) FROM order_items)');
        }
        catch {
            frozen = true;
        }
        await c.end();
        check('32. Banco recusa apagar pedido', blocked);
        check('Banco recusa alterar preço de item vendido', frozen);
    }
    console.log('\n[QR Code desligado/ligado]');
    check('Cardápio público desligado por padrão', (await fetch(BASE + '/api/public/menu').then((r) => r.json())).enabled === false);
    check('Pedido público recusado com QR desligado', (await new Client('x').post('/api/public/orders', { mode: 'BALCAO', items: [{ productId: batata.id, quantity: 1 }] })).status === 403);
    await admin.patch('/api/settings', { qrEnabled: true, isOpen: true });
    const qrEv = waitEvent(cSock, 'qr:new');
    const db = new pg.Client({ connectionString: DB_URL });
    await db.connect();
    const semZap = await new Client('cliente0').post('/api/public/orders', { customerName: 'Visitante', mode: 'BALCAO', items: [{ productId: batata.id, quantity: 1 }] });
    check('Cardápio digital exige WhatsApp', semZap.status === 400, semZap.data);
    const zapRuim = await new Client('cliente0').post('/api/public/orders', { customerName: 'Visitante', phone: '1234', mode: 'BALCAO', items: [{ productId: batata.id, quantity: 1 }] });
    check('WhatsApp inválido é recusado com explicação', zapRuim.status === 400 && /WhatsApp/.test(zapRuim.data.error), zapRuim.data);
    const semNome = await new Client('cliente0').post('/api/public/orders', { customerName: ' ', phone: '(11) 91234-5678', mode: 'BALCAO', items: [{ productId: batata.id, quantity: 1 }] });
    check('Cardápio digital exige nome', semNome.status === 400);
    const qr = await new Client('cliente').post('/api/public/orders', { customerName: 'Visitante', phone: '+55 (11) 91234-5678', aceitaOfertas: true, mode: 'BALCAO', items: [{ productId: batata.id, quantity: 1 }] });
    check('Com QR ligado, cliente envia pedido', qr.status === 200, qr.data);
    check('Pedido devolve código aleatório de acompanhamento', typeof qr.data.token === 'string' && qr.data.token.length >= 16);
    const acomp = await new Client('x').get(`/api/public/pedido/${qr.data.token}`);
    check('Acompanhamento: "aguardando confirmação", sem nome nem telefone', acomp.status === 200 && acomp.data.etapa === 'aguardando'
        && !JSON.stringify(acomp.data).includes('Visitante') && !JSON.stringify(acomp.data).includes('91234'), acomp.data);
    check('Código errado não encontra pedido', (await new Client('x').get('/api/public/pedido/AAAAAAAAAAAAAAAA')).status === 404);
    const cons = (await db.query(`SELECT phone, aceita_ofertas, aceita_ofertas_em, aceita_ofertas_texto FROM customers WHERE name='Visitante'`)).rows[0];
    check('Consentimento de ofertas guardado com texto e data/hora; WhatsApp normalizado', cons?.aceita_ofertas === true && !!cons.aceita_ofertas_em && /WhatsApp/.test(cons.aceita_ofertas_texto) && cons.phone === '11912345678', cons);
    check('Caixa é avisado do pedido aguardando confirmação', await qrEv);
    const board = (await caixa.get('/api/cashier/board')).data;
    const aw = board.awaiting.find((o) => o.orderNumber === qr.data.orderNumber);
    check('Pedido QR aguarda confirmação e não entra na cozinha', aw && !(await coz.get('/api/kitchen/orders')).data.some((o) => o.number === qr.data.orderNumber));
    const kn3 = waitEvent(kSock, 'kitchen:new');
    check('Caixa confirma → cozinha recebe', (await caixa.post(`/api/orders/${aw.orderId}/confirm`)).status === 200 && await kn3);
    check('Acompanhamento: confirmado', (await new Client('x').get(`/api/public/pedido/${qr.data.token}`)).data.etapa === 'confirmado');
    const qrRec = await new Client('cliente2').post('/api/public/orders', { customerName: 'Outra Pessoa', phone: '11987654321', mode: 'BALCAO', items: [{ productId: batata.id, quantity: 1 }] });
    const awRec = (await caixa.get('/api/cashier/board')).data.awaiting.find((o) => o.orderNumber === qrRec.data.orderNumber);
    await caixa.post(`/api/orders/${awRec.orderId}/cancel`, { reason: 'Acabou a batata por hoje', returnStock: false });
    const rec = (await new Client('x').get(`/api/public/pedido/${qrRec.data.token}`)).data;
    check('Pedido recusado mostra o motivo ao cliente', rec.etapa === 'recusado' && rec.motivo === 'Acabou a batata por hoje', rec);
    const semCons = (await db.query(`SELECT aceita_ofertas FROM customers WHERE name='Outra Pessoa'`)).rows[0];
    check('Sem a caixinha marcada, cliente NÃO aceita ofertas', semCons?.aceita_ofertas === false);
    await db.end();
    await admin.patch('/api/settings', { qrEnabled: false });
    await r2Tests({ admin, caixa, coz, kSock, cSock, find, M: (c) => methods.find((m) => m.code === c).id });
    kSock.close();
    cSock.close();
    console.log(`\nResultado: ${passed} verificações OK, ${failures.length} falhas.`);
    if (failures.length) {
        console.log('Falhas:\n - ' + failures.join('\n - '));
        process.exit(1);
    }
}
import { r2Tests } from './e2e-r2.js';
main().catch((e) => { console.error(e); process.exit(1); });
