/**
 * Recuperação de vendas (CRM de cobrança do fiado) — 3.3, Etapa 4.
 * Cria o próprio banco (ag_crm) e sobe o próprio servidor na porta 3502, reiniciando-o com CRM_AGORA diferentes
 * para simular os dias passando (régua, promessa, alerta de baixa).
 *   cd server && npx tsc -p tsconfig.json && node dist/scripts/crm-test.js
 */
import pg from 'pg';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const PG = process.env.PG ?? 'postgres://postgres:postgres@localhost:5432';
const DB_URL = `${PG}/ag_crm`;
const PORT = 3502;
const BASE = `http://localhost:${PORT}`;
const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = mkdtempSync(join(tmpdir(), 'crm-test-'));
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
    empresa;
    cookie = '';
    constructor(empresa = 'crm') {
        this.empresa = empresa;
    }
    async req(method, path, body) {
        const isForm = body instanceof FormData;
        const res = await fetch(BASE + path, {
            method,
            headers: { 'x-empresa': this.empresa, ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
            body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
        });
        for (const c of res.headers.getSetCookie())
            if (c.startsWith('oneup_sessao='))
                this.cookie = c.split(';')[0];
        const buf = Buffer.from(await res.arrayBuffer());
        const text = buf.toString('utf8');
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        }
        catch {
            data = text;
        }
        return { status: res.status, data, headers: res.headers, buf };
    }
    get = (p) => this.req('GET', p);
    post = (p, b = {}) => this.req('POST', p, b);
    put = (p, b) => this.req('PUT', p, b);
    patch = (p, b) => this.req('PATCH', p, b);
    del = (p) => this.req('DELETE', p);
    async login(u, p) { const r = await this.post('/api/auth/login', { username: u, password: p }); if (r.status !== 200)
        throw new Error(`login ${u}: ${r.status} ${JSON.stringify(r.data)}`); return r; }
}
// ---------- datas ----------
const diaSP = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
const addDias = (iso, n) => { const x = new Date(iso + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const semana = (iso) => new Date(iso + 'T12:00:00Z').getUTCDay();
// D = próximo dia útil (seg–sáb) a partir de amanhã: os guarda-corpos padrão valem nele
let D = addDias(diaSP(new Date()), 1);
while (semana(D) === 0)
    D = addDias(D, 1);
const agora = (dia, hora = '10:00') => `${dia}T${hora}:00-03:00`;
// ---------- servidor ----------
let srv = null;
async function subir(crmAgora) {
    await parar();
    srv = spawn('node', ['dist/index.js'], {
        cwd: SERVER,
        env: { ...process.env, DATABASE_URL: DB_URL, EMPRESA_HEADER: 'true', PORT: String(PORT), NODE_ENV: 'test', CRM_AGORA: crmAgora, UPLOADS_DIR: join(TMP, 'uploads'), CRM_PRIVADO_DIR: join(TMP, 'privado'), LOG_LEVEL: 'error' },
        stdio: ['ignore', 'ignore', 'inherit'],
    });
    for (let i = 0; i < 80; i++) {
        try {
            const r = await fetch(`${BASE}/api/health`);
            if (r.ok)
                return;
        }
        catch { /* subindo */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('servidor de teste não subiu');
}
async function parar() {
    if (!srv)
        return;
    const p = srv;
    srv = null;
    await new Promise((r) => { p.once('exit', () => r()); p.kill('SIGTERM'); setTimeout(() => { p.kill('SIGKILL'); r(); }, 9000).unref(); });
}
async function main() {
    // banco novo
    const adm = new pg.Client({ connectionString: `${PG}/postgres` });
    await adm.connect();
    await adm.query('DROP DATABASE IF EXISTS ag_crm WITH (FORCE)');
    await adm.query('CREATE DATABASE ag_crm');
    await adm.end();
    const run = (script, ...args) => execFileSync('node', [`dist/scripts/${script}`, ...args], { cwd: SERVER, env: { ...process.env, DATABASE_URL: DB_URL }, encoding: 'utf8' });
    run('setup.js', '--empresa=crm', '--nome=Restaurante Teste', '--admin-pass=crm-admin', '--caixa-pass=crm-caixa', '--cozinha-pass=crm-coz', '--cardapio=exemplo');
    run('plataforma.js', 'oneup-usuario', '--empresa=crm', '--login=oneup', '--nome=ONE UP Teste', '--senha=oneup-1234');
    const db = new pg.Client({ connectionString: DB_URL });
    await db.connect();
    await subir(agora(D));
    const dono = new C();
    await dono.login('admin', 'crm-admin');
    const caixa = new C();
    await caixa.login('caixa', 'crm-caixa');
    const coz = new C();
    await coz.login('cozinha', 'crm-coz');
    const one = new C();
    await one.login('oneup', 'oneup-1234');
    if ((await caixa.get('/api/register/current')).data?.register == null)
        await caixa.post('/api/register/open', { openingCashCents: 10000 });
    const metodos = (await caixa.get('/api/payment-methods')).data;
    const PIX = metodos.find((m) => m.code === 'PIX').id;
    /** Conta a receber de R$ valor, pendente há `dias` dias (pending_at recuado direto no banco). */
    async function fiado(nome, contato, cents, dias) {
        const r = await caixa.post('/api/accounts', { customerName: nome, items: [{ quantity: 1, custom: { description: 'Consumo', priceCents: cents, goesToKitchen: false } }] });
        if (r.status !== 200)
            throw new Error('conta: ' + JSON.stringify(r.data));
        const p = await caixa.post(`/api/accounts/${r.data.id}/pending`, { customerName: nome, contact: contato });
        if (p.status !== 200)
            throw new Error('pendente: ' + JSON.stringify(p.data));
        await db.query(`UPDATE accounts SET pending_at = now() - ($1 || ' days')::interval WHERE id = $2`, [String(dias), r.data.id]);
        return r.data.id;
    }
    const pagar = (id, cents, close = false) => caixa.post(`/api/accounts/${id}/payments`, { payments: [{ methodId: PIX, amountCents: cents }], close });
    const A = await fiado('Ana Souza', '(61) 99999-0001', 5000, 20); // faixa ≥15 → 10%
    const B = await fiado('Bruno Lima', '(61) 99999-0002', 8000, 40); // ≥30 → 15%
    const Cc = await fiado('Carla Dias', '(61) 99999-0003', 12000, 70); // ≥60 → 20%
    const Dd = await fiado('Davi Rocha', '(61) 99999-0004', 3000, 5); // ainda não entra
    const E = await fiado('Elisa Mota', '(61) 99999-0005', 4000, 25);
    const F = await fiado('Fabio Nunes', '(61) 99999-0006', 6000, 18);
    const G = await fiado('Gil Prado', '(61) 99999-0007', 2500, 22);
    const H = await fiado('Hugo Reis', '(61) 99999-0008', 3500, 30);
    const I = await fiado('Iara Melo', 'Casa 12, sem telefone', 9000, 65);
    const recDono0 = (await dono.get('/api/accounts/receivable')).data;
    const chavesDono0 = Object.keys(recDono0[0] ?? {}).sort().join(',');
    // ------------------------------------------------------------------------------------------
    console.log('\n[1] Só a ONE UP: Dono, Caixa e Cozinha recebem 404 em TODAS as rotas do CRM');
    const rotas = [
        ['GET', '/api/oneup/crm/estado'], ['POST', '/api/oneup/crm/sincronizar', {}], ['GET', '/api/oneup/crm/hoje'], ['GET', '/api/oneup/crm/funil'],
        ['GET', '/api/oneup/crm/fichas'], ['GET', '/api/oneup/crm/fichas/1'], ['POST', '/api/oneup/crm/fichas/1/contato', { canal: 'WHATSAPP' }],
        ['POST', '/api/oneup/crm/fichas/1/resultado', { resultado: 'PAGOU' }], ['POST', '/api/oneup/crm/fichas/1/nao-cobrar', { motivo: 'teste teste' }],
        ['POST', '/api/oneup/crm/fichas/1/retomar', {}], ['POST', '/api/oneup/crm/fichas/1/encerrar', { motivo: 'teste teste' }],
        ['POST', '/api/oneup/crm/fichas/1/nota', { nota: 'oi oi' }], ['POST', '/api/oneup/crm/fichas/1/comprovante', {}],
        ['GET', '/api/oneup/crm/comprovantes/1'], ['DELETE', '/api/oneup/crm/comprovantes/1'], ['GET', '/api/oneup/crm/relatorio'],
        ['GET', '/api/oneup/crm/insights'], ['GET', '/api/oneup/crm/config'], ['PUT', '/api/oneup/crm/config', { config: {} }],
    ];
    async function todos404(rotulo) {
        for (const [quem, c] of [['Dono', dono], ['Caixa', caixa], ['Cozinha', coz]]) {
            const ruins = [];
            for (const [m, p, b] of rotas) {
                const r = await c.req(m, p, b);
                if (r.status !== 404)
                    ruins.push(`${m} ${p} → ${r.status}`);
            }
            check(`${quem}: 404 em todas as ${rotas.length} rotas (${rotulo})`, ruins.length === 0, ruins);
        }
    }
    await todos404('serviço desligado');
    console.log('\n[2] Serviço desligado → as rotas da ONE UP recusam');
    const est = await one.get('/api/oneup/crm/estado');
    check('Estado: desligado', est.status === 200 && est.data.ligado === false, est.data);
    const des = await one.get('/api/oneup/crm/hoje');
    check('Fila Hoje recusada com o serviço desligado (403 CRM_DESLIGADO)', des.status === 403 && des.data.code === 'CRM_DESLIGADO', des);
    check('Sincronizar também recusa', (await one.post('/api/oneup/crm/sincronizar')).status === 403);
    check('Nenhuma ficha criada com o serviço desligado', Number((await db.query('SELECT count(*) FROM crm_cobrancas')).rows[0].count) === 0);
    check('Dono não liga o serviço (é da ONE UP)', (await dono.patch('/api/configuracoes', { valores: { servico_recuperacao: true } })).status === 403);
    const telaDono = (await dono.get('/api/configuracoes')).data;
    check('Dono não vê a chave do serviço nas Configurações', !telaDono.itens.some((i) => i.chave === 'servico_recuperacao'));
    check('ONE UP liga o serviço', (await one.patch('/api/configuracoes', { valores: { servico_recuperacao: true } })).status === 200);
    await todos404('serviço ligado');
    console.log('\n[3] Ligado → conta vencida há N dias entra na fila');
    const s1 = await one.post('/api/oneup/crm/sincronizar');
    check('Sincronização cria fichas para as 8 vencidas há 15+ dias', s1.status === 200 && s1.data.resumo.entraram === 8, s1.data);
    const fichas = (await db.query(`SELECT c.*, a.id AS acc FROM crm_cobrancas c JOIN accounts a ON a.id = c.account_id`)).rows;
    const fid = (acc) => fichas.find((f) => f.acc === acc)?.id;
    check('Conta com 5 dias de atraso não entra', !fid(Dd));
    check('Percentual pela faixa NA ENTRADA: 20 dias → 10%, 40 → 15%, 70 → 20%', fichas.find((f) => f.acc === A).percentual_bp === 1000 && fichas.find((f) => f.acc === B).percentual_bp === 1500 && fichas.find((f) => f.acc === Cc).percentual_bp === 2000, fichas.map((f) => [f.acc, f.dias_atraso_entrada, f.percentual_bp]));
    check('Valor de entrada = saldo da conta', fichas.find((f) => f.acc === A).valor_entrada_cents === 5000);
    const s1b = await one.post('/api/oneup/crm/sincronizar');
    check('Sincronizar de novo não duplica', s1b.data.resumo.entraram === 0);
    let hoje = (await one.get('/api/oneup/crm/hoje')).data;
    check('Fila Hoje traz as novas como "Primeiro contato"', hoje.contatar.length === 8 && hoje.contatar.every((c) => /Primeiro contato/.test(c.motivo)), hoje.contatar.map((c) => c.motivo));
    const itemA = hoje.contatar.find((c) => c.id === fid(A));
    check('Item da fila: canal sugerido pela régua, WhatsApp e saldo', itemA?.canais?.[0] === 'WHATSAPP' && itemA.whatsapp === '5561999990001' && itemA.saldoCents === 5000, itemA);
    check('Fila não traz itens/pedidos da conta (só o mínimo do devedor)', !JSON.stringify(hoje).includes('Consumo'));
    const fichaA = (await one.get(`/api/oneup/crm/fichas/${fid(A)}`)).data;
    check('Ficha: dados mínimos, mensagem pronta com nome, valor e restaurante', fichaA.devedor.nome === 'Ana Souza' && /Ana/.test(fichaA.mensagem) && /50,00/.test(fichaA.mensagem) && /Restaurante Teste/.test(fichaA.mensagem), fichaA.mensagem);
    check('Ficha: linha do tempo com a entrada', fichaA.linhaDoTempo.length === 1 && fichaA.linhaDoTempo[0].tipo === 'SISTEMA');
    const fun = (await one.get('/api/oneup/crm/funil')).data;
    check('Funil: 8 novos somando o valor de entrada', fun.etapas.find((e) => e.status === 'NOVO').n === 8 && fun.totais.emAbertoCents === 5000 + 8000 + 12000 + 4000 + 6000 + 2500 + 3500 + 9000, fun.totais);
    console.log('\n[4] Guarda-corpos no servidor (horário, dia da semana, 1 contato por dia)');
    const cfg0 = (await one.get('/api/oneup/crm/config')).data.config;
    check('Configuração padrão: 8h–20h seg–sáb, 1/dia, 4 tentativas a cada 3 dias, faixas 10/15/20%', cfg0.horario.inicio === 8 && cfg0.horario.fim === 20 && cfg0.horario.dias.join() === '1,2,3,4,5,6' && cfg0.max_contatos_dia === 1
        && cfg0.sem_resposta.intervalo_dias === 3 && cfg0.sem_resposta.max_tentativas === 4 && cfg0.faixas.map((f) => f.bp).join() === '1000,1500,2000' && cfg0.regua.length === 5, cfg0);
    check('Configuração inválida é recusada (início depois do fim)', (await one.put('/api/oneup/crm/config', { config: { ...cfg0, horario: { ...cfg0.horario, inicio: 21 } } })).status === 400);
    await one.put('/api/oneup/crm/config', { config: { ...cfg0, horario: { ...cfg0.horario, inicio: 11 } } });
    const fora = await one.post(`/api/oneup/crm/fichas/${fid(A)}/contato`, { canal: 'WHATSAPP' });
    check('Fora do horário (10h com início às 11h) → recusa com explicação', fora.status === 409 && fora.data.code === 'CRM_GUARDA' && /horário/.test(fora.data.error), fora.data);
    await one.put('/api/oneup/crm/config', { config: { ...cfg0, horario: { ...cfg0.horario, dias: [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== semana(D)) } } });
    const dia = await one.post(`/api/oneup/crm/fichas/${fid(A)}/contato`, { canal: 'WHATSAPP' });
    check('Dia da semana não permitido → recusa com explicação', dia.status === 409 && /não é dia de contato/.test(dia.data.error), dia.data);
    // daqui em diante qualquer dia vale (os testes atravessam domingos)
    const cfgTodo = { ...cfg0, horario: { ...cfg0.horario, dias: [0, 1, 2, 3, 4, 5, 6] }, chave_pix: 'pix@restaurante.teste' };
    check('ONE UP salva a configuração (régua/limites/Pix)', (await one.put('/api/oneup/crm/config', { config: cfgTodo })).status === 200);
    const c1 = await one.post(`/api/oneup/crm/fichas/${fid(A)}/contato`, { canal: 'WHATSAPP' });
    check('Contato pelo WhatsApp registrado (o sistema não envia; devolve o número para abrir wa.me)', c1.status === 200 && c1.data.whatsapp === '5561999990001', c1.data);
    const c2 = await one.post(`/api/oneup/crm/fichas/${fid(A)}/contato`, { canal: 'LIGACAO' });
    check('Segundo contato no mesmo dia → recusa (1 por dia por conta)', c2.status === 409 && /já foi contatada hoje/.test(c2.data.error), c2.data);
    const semZap = await one.post(`/api/oneup/crm/fichas/${fid(I)}/contato`, { canal: 'WHATSAPP' });
    check('WhatsApp sem número válido → recusa e sugere ligação', semZap.status === 400, semZap.data);
    check('Ligação registrada para quem não tem WhatsApp', (await one.post(`/api/oneup/crm/fichas/${fid(I)}/contato`, { canal: 'LIGACAO' })).status === 200);
    let fa = (await one.get(`/api/oneup/crm/fichas/${fid(A)}`)).data;
    check('Depois do contato: Contatado, próximo lembrete no próximo passo da régua (D+3)', fa.status === 'CONTATADO' && fa.proximoContato === addDias(D, 3) && fa.tentativas === 1, fa);
    check('Ficha avisa que já foi contatada hoje', fa.contatadoHoje === true && /já foi contatada/.test(fa.bloqueioContato ?? ''));
    check('Auditoria registra o acesso da ONE UP (sem status da cobrança)', (await db.query(`SELECT count(*) FROM audit_logs WHERE action = 'crm.contato'`)).rows[0].count >= 1);
    console.log('\n[5] Resultados mudam o status e o próximo lembrete');
    const srSem = await one.post(`/api/oneup/crm/fichas/${fid(H)}/resultado`, { resultado: 'SEM_RESPOSTA' });
    check('"Sem resposta" sem contato hoje → recusa', srSem.status === 409 && srSem.data.code === 'CRM_SEM_CONTATO', srSem.data);
    const sr = await one.post(`/api/oneup/crm/fichas/${fid(A)}/resultado`, { resultado: 'SEM_RESPOSTA' });
    fa = (await one.get(`/api/oneup/crm/fichas/${fid(A)}`)).data;
    check('Sem resposta → status Sem resposta, nova tentativa em 3 dias (1/4)', sr.status === 200 && fa.status === 'SEM_RESPOSTA' && fa.proximoContato === addDias(D, 3) && fa.semRespostaSeguidas === 1, fa);
    check('"Sem resposta" repetido para o mesmo contato → recusa', (await one.post(`/api/oneup/crm/fichas/${fid(A)}/resultado`, { resultado: 'SEM_RESPOSTA' })).status === 409);
    await one.post(`/api/oneup/crm/fichas/${fid(B)}/contato`, { canal: 'WHATSAPP' });
    check('Vai pagar com data no passado → recusa', (await one.post(`/api/oneup/crm/fichas/${fid(B)}/resultado`, { resultado: 'VAI_PAGAR', data: addDias(D, -1) })).status === 400);
    await one.post(`/api/oneup/crm/fichas/${fid(B)}/resultado`, { resultado: 'VAI_PAGAR', data: addDias(D, 1) });
    let fb = (await one.get(`/api/oneup/crm/fichas/${fid(B)}`)).data;
    check('Vai pagar (data) → Prometeu, lembrete no dia prometido', fb.status === 'PROMETEU' && fb.prometidoPara === addDias(D, 1) && fb.proximoContato === addDias(D, 1), fb);
    await one.post(`/api/oneup/crm/fichas/${fid(Cc)}/contato`, { canal: 'WHATSAPP' });
    await one.post(`/api/oneup/crm/fichas/${fid(Cc)}/resultado`, { resultado: 'PAGOU', nota: 'Mandou Pix direto para o restaurante' });
    let fc = (await one.get(`/api/oneup/crm/fichas/${fid(Cc)}`)).data;
    check('Pagou (Pix direto, sem baixa) → "Pago — aguardando baixa", SEM comissão', fc.status === 'PAGO_AGUARDANDO_BAIXA' && fc.comissaoCents === 0 && fc.recuperadoCents === 0, fc);
    await one.post(`/api/oneup/crm/fichas/${fid(F)}/contato`, { canal: 'LIGACAO' });
    check('Contestou sem nota → recusa (anotar o motivo)', (await one.post(`/api/oneup/crm/fichas/${fid(F)}/resultado`, { resultado: 'CONTESTOU' })).status === 400);
    await one.post(`/api/oneup/crm/fichas/${fid(F)}/resultado`, { resultado: 'CONTESTOU', nota: 'Diz que já pagou em dinheiro' });
    check('Contestou → pausa (Contestado)', (await one.get(`/api/oneup/crm/fichas/${fid(F)}`)).data.status === 'CONTESTADO');
    await one.post(`/api/oneup/crm/fichas/${fid(G)}/contato`, { canal: 'WHATSAPP' });
    await one.post(`/api/oneup/crm/fichas/${fid(G)}/resultado`, { resultado: 'NUMERO_ERRADO' });
    hoje = (await one.get('/api/oneup/crm/hoje')).data;
    check('Número errado → sai da fila e vai para "pedir correção do contato"', hoje.corrigirContato.some((x) => x.id === fid(G)) && !hoje.contatar.some((x) => x.id === fid(G)));
    check('Contestado aparece separado (pausado)', hoje.contestadas.some((x) => x.id === fid(F)));
    check('Aguardando baixa aparece separado, ainda sem alerta', hoje.aguardandoBaixa.some((x) => x.id === fid(Cc) && x.alerta === false), hoje.aguardandoBaixa);
    check('Já contatadas hoje vão para o fim da fila', hoje.contatar.filter((x) => x.contatadoHoje).every((x) => hoje.contatar.indexOf(x) >= hoje.contatar.filter((y) => !y.contatadoHoje).length));
    const corr = await caixa.patch(`/api/accounts/${G}`, { customerName: 'Gil Prado', contact: '(61) 98888-0007' });
    check('Restaurante corrige o contato da conta (Caixa)', corr.status === 200, corr.data);
    await one.post('/api/oneup/crm/sincronizar');
    check('Contato corrigido → ficha volta sozinha para a fila', (await one.get(`/api/oneup/crm/fichas/${fid(G)}`)).data.status === 'CONTATADO');
    console.log('\n[6] "Não cobrar" é definitivo');
    check('"Não cobrar" exige motivo', (await one.post(`/api/oneup/crm/fichas/${fid(E)}/nao-cobrar`, {})).status === 400);
    check('"Não cobrar" registrado', (await one.post(`/api/oneup/crm/fichas/${fid(E)}/nao-cobrar`, { motivo: 'Funcionário da casa, o Dono pediu' })).status === 200);
    check('Contato depois de "Não cobrar" → recusa', (await one.post(`/api/oneup/crm/fichas/${fid(E)}/contato`, { canal: 'WHATSAPP' })).status === 409);
    check('Resultado depois de "Não cobrar" → recusa', (await one.post(`/api/oneup/crm/fichas/${fid(E)}/resultado`, { resultado: 'VAI_PAGAR', data: D })).status === 409);
    check('"Retomar" não desfaz "Não cobrar"', (await one.post(`/api/oneup/crm/fichas/${fid(E)}/retomar`, {})).status === 409);
    check('Marcar de novo não muda nada (409)', (await one.post(`/api/oneup/crm/fichas/${fid(E)}/nao-cobrar`, { motivo: 'outra vez' })).status === 409);
    await one.post('/api/oneup/crm/sincronizar');
    check('Nunca volta a entrar pela sincronização', Number((await db.query(`SELECT count(*) FROM crm_cobrancas WHERE account_id = $1`, [E])).rows[0].count) === 1 && (await one.get(`/api/oneup/crm/fichas/${fid(E)}`)).data.status === 'NAO_COBRAR');
    console.log('\n[7] Comprovante (só ONE UP, com opção de apagar)');
    const png = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D4944415478DA63F8FFFF3F0005FE02FEA7D6A1E90000000049454E44AE426082', 'hex');
    const fd = new FormData();
    fd.append('arquivo', new Blob([png], { type: 'image/png' }), 'comprovante.png');
    const up = await one.post(`/api/oneup/crm/fichas/${fid(Cc)}/comprovante`, fd);
    check('Comprovante (PNG) anexado', up.status === 200 && up.data.id > 0, up.data);
    const fdBad = new FormData();
    fdBad.append('arquivo', new Blob([Buffer.from('nao sou imagem')], { type: 'text/plain' }), 'x.txt');
    check('Arquivo que não é imagem/PDF → recusa', (await one.post(`/api/oneup/crm/fichas/${fid(Cc)}/comprovante`, fdBad)).status === 400);
    const fdPdf = new FormData();
    fdPdf.append('arquivo', new Blob([Buffer.from('%PDF-1.4\n%teste\n')], { type: 'application/pdf' }), 'c.pdf');
    check('PDF aceito', (await one.post(`/api/oneup/crm/fichas/${fid(Cc)}/comprovante`, fdPdf)).status === 200);
    const dl = await one.get(`/api/oneup/crm/comprovantes/${up.data.id}`);
    check('ONE UP abre o comprovante', dl.status === 200 && dl.headers.get('content-type') === 'image/png' && dl.buf.length === png.length);
    check('Dono não abre o comprovante (404)', (await dono.get(`/api/oneup/crm/comprovantes/${up.data.id}`)).status === 404);
    check('Arquivo não fica na pasta pública /uploads', (await one.get(`/uploads/1/${(await db.query('SELECT arquivo FROM crm_comprovantes WHERE id=$1', [up.data.id])).rows[0].arquivo}`)).status === 404);
    check('ONE UP apaga o comprovante', (await one.del(`/api/oneup/crm/comprovantes/${up.data.id}`)).status === 200);
    check('Apagado: não abre mais', (await one.get(`/api/oneup/crm/comprovantes/${up.data.id}`)).status === 404);
    fc = (await one.get(`/api/oneup/crm/fichas/${fid(Cc)}`)).data;
    check('Ficha mostra o comprovante como apagado (registro fica)', fc.comprovantes.some((x) => x.id === up.data.id && x.apagadoEm));
    // ------------------------------------------------------------------------------------------
    console.log('\n[8] Os dias passam: prometeu → lembra no dia e no seguinte; promessa quebrada 2× → ligação');
    await subir(agora(addDias(D, 1)));
    hoje = (await one.get('/api/oneup/crm/hoje')).data;
    const iB1 = hoje.contatar.find((x) => x.id === fid(B));
    check('D+1: quem prometeu para hoje aparece na fila', /Prometeu pagar hoje/.test(iB1?.motivo ?? ''), iB1);
    check('D+1: quem teve "sem resposta" ontem ainda não aparece (só em 3 dias)', !hoje.contatar.some((x) => x.id === fid(A)));
    check('D+1: pagamento sem baixa há 1 dia ainda sem alerta', hoje.aguardandoBaixa.find((x) => x.id === fid(Cc))?.alerta === false);
    await one.post(`/api/oneup/crm/fichas/${fid(B)}/contato`, { canal: 'WHATSAPP' });
    check('Lembrete do dia registrado → próximo no dia seguinte', (await one.get(`/api/oneup/crm/fichas/${fid(B)}`)).data.proximoContato === addDias(D, 2));
    await subir(agora(addDias(D, 2)));
    hoje = (await one.get('/api/oneup/crm/hoje')).data;
    check('D+2: lembra de novo no dia seguinte à promessa', /Prometeu para ontem/.test(hoje.contatar.find((x) => x.id === fid(B))?.motivo ?? ''), hoje.contatar.map((x) => [x.id, x.motivo]));
    await subir(agora(addDias(D, 3)));
    const s3 = await one.post('/api/oneup/crm/sincronizar');
    fb = (await one.get(`/api/oneup/crm/fichas/${fid(B)}`)).data;
    check('D+3: promessa não cumprida → quebrada (1ª), volta para a fila', s3.data.resumo.quebradas >= 1 && fb.promessasQuebradas === 1 && fb.status === 'CONTATADO' && fb.proximoContato === addDias(D, 3), fb);
    hoje = (await one.get('/api/oneup/crm/hoje')).data;
    const iA3 = hoje.contatar.find((x) => x.id === fid(A));
    check('D+3: sem resposta volta na fila (tentativa 2/4) com o passo da régua do dia', /tentativa \(2\/4\)/.test(iA3?.motivo ?? '') && iA3.passo === 'Reforço com chave Pix', iA3);
    const fA3 = (await one.get(`/api/oneup/crm/fichas/${fid(A)}`)).data;
    check('Mensagem do passo "Reforço com chave Pix" já vem com a chave Pix', /pix@restaurante\.teste/.test(fA3.mensagem), fA3.mensagem);
    await one.post(`/api/oneup/crm/fichas/${fid(B)}/contato`, { canal: 'WHATSAPP' });
    await one.post(`/api/oneup/crm/fichas/${fid(B)}/resultado`, { resultado: 'VAI_PAGAR', data: addDias(D, 3) });
    // limite de tentativas sem resposta: com máximo 2, a segunda pausa a ficha
    await one.put('/api/oneup/crm/config', { config: { ...cfgTodo, sem_resposta: { intervalo_dias: 3, max_tentativas: 2 } } });
    await one.post(`/api/oneup/crm/fichas/${fid(A)}/contato`, { canal: 'WHATSAPP' });
    await one.post(`/api/oneup/crm/fichas/${fid(A)}/resultado`, { resultado: 'SEM_RESPOSTA' });
    fa = (await one.get(`/api/oneup/crm/fichas/${fid(A)}`)).data;
    check('Sem resposta no limite de tentativas → pausa', fa.status === 'PAUSADO' && fa.proximoContato === null, fa);
    check('Pausada não aceita contato', (await one.post(`/api/oneup/crm/fichas/${fid(A)}/contato`, { canal: 'LIGACAO' })).status === 409);
    check('Retomar volta a ficha para a fila', (await one.post(`/api/oneup/crm/fichas/${fid(A)}/retomar`, { nota: 'Cliente respondeu por outro número' })).status === 200
        && (await one.get(`/api/oneup/crm/fichas/${fid(A)}`)).data.status === 'CONTATADO');
    await one.put('/api/oneup/crm/config', { config: cfgTodo });
    await subir(agora(addDias(D, 5)));
    await one.post('/api/oneup/crm/sincronizar');
    fb = (await one.get(`/api/oneup/crm/fichas/${fid(B)}`)).data;
    hoje = (await one.get('/api/oneup/crm/hoje')).data;
    const iB5 = hoje.contatar.find((x) => x.id === fid(B));
    check('D+5: promessa quebrada 2× → próximo contato por LIGAÇÃO', fb.promessasQuebradas === 2 && iB5?.canais?.join() === 'LIGACAO', { fb: fb.promessasQuebradas, iB5 });
    check('D+5: "Pago — aguardando baixa" há 5 dias → alerta para combinar com o Dono', hoje.aguardandoBaixa.find((x) => x.id === fid(Cc))?.alerta === true, hoje.aguardandoBaixa);
    check('Ainda sem baixa: nenhuma comissão gerada', Number((await db.query('SELECT COALESCE(SUM(comissao_cents),0) AS s FROM crm_cobrancas')).rows[0].s) === 0);
    console.log('\n[9] Baixa feita pelo Caixa → Recuperado com comissão pela faixa certa (e nunca sem baixa)');
    check('Caixa recebe o pagamento total da Carla (baixa)', (await pagar(Cc, 12000)).status === 200);
    check('Caixa recebe só PARTE do Bruno', (await pagar(B, 3000)).status === 200);
    check('Caixa recebe a Ana e encerra a conta', (await pagar(A, 5000, true)).status === 200);
    check('Caixa recebe o Hugo (nunca contatado)', (await pagar(H, 3500)).status === 200);
    check('Caixa recebe a Elisa ("não cobrar")', (await pagar(E, 4000)).status === 200);
    const s9 = await one.post('/api/oneup/crm/sincronizar');
    check('Sincronização encontra as baixas', s9.data.resumo.recuperadas === 3, s9.data.resumo);
    fc = (await one.get(`/api/oneup/crm/fichas/${fid(Cc)}`)).data;
    check('Carla: Recuperado, R$ 120,00, comissão 20% (entrou com 70 dias) = R$ 24,00', fc.status === 'RECUPERADO' && fc.recuperadoCents === 12000 && fc.comissaoCents === 2400, fc);
    fa = (await one.get(`/api/oneup/crm/fichas/${fid(A)}`)).data;
    check('Ana: Recuperado, comissão 10% (entrou com 20 dias) = R$ 5,00', fa.status === 'RECUPERADO' && fa.comissaoCents === 500, fa);
    fb = (await one.get(`/api/oneup/crm/fichas/${fid(B)}`)).data;
    check('Bruno: pagamento parcial NÃO é baixa → sem comissão, continua na cobrança', fb.status !== 'RECUPERADO' && fb.comissaoCents === 0 && fb.saldoCents === 5000, fb);
    const fh = (await one.get(`/api/oneup/crm/fichas/${fid(H)}`)).data;
    check('Hugo: pago antes de qualquer contato → "Pago sem contato", sem comissão', fh.status === 'PAGO_SEM_CONTATO' && fh.comissaoCents === 0, fh);
    const fe = (await one.get(`/api/oneup/crm/fichas/${fid(E)}`)).data;
    check('Elisa ("não cobrar") quitada: continua "Não cobrar", sem comissão', fe.status === 'NAO_COBRAR' && fe.comissaoCents === 0 && fe.encerradoEm, fe);
    check('Linha do tempo da Carla registra a baixa e a comissão', fc.linhaDoTempo.some((e) => e.tipo === 'SISTEMA' && /Baixa feita pelo restaurante/.test(e.nota)));
    check('Caixa recebe o resto do Bruno', (await pagar(B, 5000)).status === 200);
    await one.post('/api/oneup/crm/sincronizar');
    fb = (await one.get(`/api/oneup/crm/fichas/${fid(B)}`)).data;
    check('Bruno: baixa completa → Recuperado R$ 80,00 (as duas parcelas depois da entrada), 15% = R$ 12,00', fb.status === 'RECUPERADO' && fb.recuperadoCents === 8000 && fb.comissaoCents === 1200, fb);
    check('Recuperada não aceita mais contato', (await one.post(`/api/oneup/crm/fichas/${fid(B)}/contato`, { canal: 'WHATSAPP' })).status === 409);
    check('Comissão total = só das baixas (5 + 24 + 12)', Number((await db.query('SELECT SUM(comissao_cents) AS s FROM crm_cobrancas')).rows[0].s) === 4100);
    console.log('\n[10] Relatório mensal e insights (só ONE UP)');
    const mes = diaSP(new Date()).slice(0, 7);
    const rel = (await one.get(`/api/oneup/crm/relatorio?mes=${mes}`)).data;
    check('Relatório: entraram 8, recuperadas 3 (R$ 250,00), comissão R$ 41,00, líquido R$ 209,00', rel.entraram.n === 8 && rel.recuperado.n === 3 && rel.recuperado.cents === 25000 && rel.comissaoCents === 4100 && rel.liquidoRestauranteCents === 20900, rel);
    check('Relatório: pago sem contato separado, em negociação conta as abertas', rel.pagoSemContato.n === 1 && rel.emNegociacao.n === 3, rel.emNegociacao);
    check('Relatório: taxa de recuperação com a premissa escrita', rel.taxaRecuperacao === 1 && /÷/.test(rel.taxaPremissa));
    check('Relatório: por faixa (10%, 15%, 20%)', rel.porFaixa.map((f) => f.bp).join() === '1000,1500,2000', rel.porFaixa);
    check('Relatório não traz telefone do devedor', !JSON.stringify(rel).includes('99999'));
    const ins = (await one.get('/api/oneup/crm/insights')).data;
    check('Insights: valor parado há 60+ dias (a Iara, 65 dias)', ins.insights.some((i) => i.id === 'parado_60' && /90,00/.test(i.numero)), ins);
    check('Insights abaixo da amostra mínima não aparecem (e dizem por quê)', !ins.insights.some((i) => i.id === 'canal') && ins.semAmostra.length >= 1);
    check('Todo insight traz frase, número, amostra, confiança e ação', ins.insights.every((i) => i.frase && i.numero && i.amostra && i.confianca && i.acao));
    const fn = (await one.get('/api/oneup/crm/funil')).data;
    check('Funil: 3 recuperados, comissão total R$ 41,00', fn.etapas.find((e) => e.status === 'RECUPERADO').n === 3 && fn.totais.comissaoCents === 4100 && fn.totais.recuperadoCents === 25000, fn.totais);
    const lista = (await one.get('/api/oneup/crm/fichas?status=RECUPERADO')).data;
    check('Lista de fichas filtra por status', lista.length === 3 && lista.every((x) => x.status === 'RECUPERADO'));
    check('Encerrar como perdida exige motivo e funciona', (await one.post(`/api/oneup/crm/fichas/${fid(I)}/encerrar`, { motivo: 'Mudou de cidade' })).status === 200
        && (await one.get(`/api/oneup/crm/fichas/${fid(I)}`)).data.status === 'PERDIDO');
    console.log('\n[11] O Dono não ganhou nada do CRM');
    const recDono = (await dono.get('/api/accounts/receivable')).data;
    const chavesDono = Object.keys(recDono[0] ?? {}).sort().join(',');
    check('/api/accounts/receivable do Dono: mesmos campos de antes do serviço', chavesDono === chavesDono0, { antes: chavesDono0, depois: chavesDono });
    check('/api/accounts/receivable do Dono: nenhum status/valor de recuperação', !/RECUPERADO|PROMETEU|SEM_RESPOSTA|NAO_COBRAR|comiss|crm|recupera|funil|tentativa/i.test(JSON.stringify(recDono)));
    const recCaixa = (await caixa.get('/api/accounts/receivable')).data;
    check('/api/accounts/receivable do Caixa: idem', !/RECUPERADO|PROMETEU|comiss|crm|recupera/i.test(JSON.stringify(recCaixa)));
    const contaDono = (await dono.get(`/api/accounts/${fid(Dd) ? Dd : F}`)).data;
    check('Detalhe da conta (Dono) sem nada do CRM', !/crm|comiss|recupera|PROMETEU|CONTESTADO/i.test(JSON.stringify(contaDono)));
    const aud = (await dono.get('/api/audit')).data;
    const audCrm = aud.filter((l) => String(l.action).startsWith('crm.'));
    check('Auditoria visível ao Dono registra o acesso da ONE UP (privacidade)', audCrm.length > 0);
    check('…sem status da cobrança, comissão nem valor recuperado', !audCrm.some((l) => /comiss|recuperad[oa]|promet|contest|sem resposta|perdid|funil/i.test(l.message)), audCrm.slice(0, 5).map((l) => l.message));
    const st = (await dono.get('/api/settings')).data;
    check('/api/settings do Dono não traz a chave do serviço', !('servico_recuperacao' in st.config));
    await db.end();
    await parar();
    console.log(`\n${passed} ok, ${failures.length} falha(s)`);
    if (failures.length) {
        console.log(failures.map((f) => ' - ' + f).join('\n'));
        process.exit(1);
    }
}
main().catch(async (e) => { console.error(e); await parar(); process.exit(1); });
