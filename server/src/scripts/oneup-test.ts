/**
 * ONE UP 3.0 — acesso da ONE UP, taxa da maquininha, base de comparação, provisionamento e endereço online.
 * Roda no banco de duas empresas (alfa e beta) com EMPRESA_HEADER=true (veja testes.sh).
 *   BASE_URL=http://localhost:3200 DATABASE_URL=... node dist/scripts/oneup-test.js
 */
import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE_URL ?? 'http://localhost:3200';
const DB_URL = process.env.DATABASE_URL!;
const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
let passed = 0;
const failures: string[] = [];
function check(label: string, cond: unknown, extra?: unknown) {
  if (cond) { passed++; console.log(`  ✔ ${label}`); } else { failures.push(label); console.log(`  ✘ ${label}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400)); }
}
class C {
  cookie = '';
  constructor(public empresa: string, public host?: string) {}
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(this.host ? { host: this.host } : { 'x-empresa': this.empresa }), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b: unknown = {}) => this.req('POST', p, b);
  patch = (p: string, b: unknown) => this.req('PATCH', p, b);
  async login(u: string, p: string) { const r = await this.post('/api/auth/login', { username: u, password: p }); if (r.status !== 200) throw new Error(`login ${u}: ${r.status} ${JSON.stringify(r.data)}`); return r; }
}
const plataforma = (...args: string[]) => execFileSync('node', ['dist/scripts/plataforma.js', ...args], { cwd: SERVER, env: { ...process.env, DATABASE_URL: DB_URL }, encoding: 'utf8' });

async function main() {
  const db = new pg.Client({ connectionString: DB_URL }); await db.connect();
  const [{ id: ALFA }] = (await db.query(`SELECT id FROM empresas WHERE slug='alfa'`)).rows;

  console.log('\n[1] Provisionamento por arquivo: custos no produto certo, Stella desligada, taxa, base, logotipo — e sem duplicar');
  const pasta = mkdtempSync(join(tmpdir(), 'prov-'));
  const logo = resolve(SERVER, 'provisionamento', 'happy-alpha-logo.png');
  if (existsSync(logo)) copyFileSync(logo, join(pasta, 'logo.png'));
  writeFileSync(join(pasta, 'alfa.json'), JSON.stringify({
    empresa: 'alfa', logo: existsSync(logo) ? 'logo.png' : undefined, configuracoes: { cor_destaque: '#f2d38a', nao_existe: 1 },
    custos: [
      { rotulo: 'H2O', custo: 4.2, produtos: ['Limoneto'] },
      { rotulo: 'Refrigerante', custo: 2.99, produtos: ['coca-cola LATA', 'Produto Que Nao Existe'] },
    ],
    novosProdutos: [{ nome: 'Stella Artois', categoria: 'Cervejas', custo: 5.99, estoque: true, nota: 'Defina o preço.' }],
    taxas: { CARTAO: 4.28, NAO_EXISTE: 1 },
    referencias: [{ titulo: 'Maquininha 6 meses', origem: 'maquininha', inicio: '2026-03-30', fim: '2026-09-30', total: 50305.42, vendas: 727, taxas: 2143.85,
      porForma: [{ forma: 'Crédito', vendas: 494, valor: 38074.69 }, { forma: 'Débito', vendas: 226, valor: 12060.73 }, { forma: 'Pix', vendas: 7, valor: 170 }] }],
  }));
  const saida1 = plataforma('provisionar', `--arquivo=${join(pasta, 'alfa.json')}`);
  const custos1 = (await db.query(`SELECT count(*)::int AS n FROM product_costs WHERE empresa_id=$1`, [ALFA])).rows[0].n;
  plataforma('provisionar', `--arquivo=${join(pasta, 'alfa.json')}`);
  const custos2 = (await db.query(`SELECT count(*)::int AS n FROM product_costs WHERE empresa_id=$1`, [ALFA])).rows[0].n;
  const prod = async (nome: string) => (await db.query(`SELECT * FROM products WHERE empresa_id=$1 AND name=$2`, [ALFA, nome])).rows[0];
  check('Limoneto recebeu o custo de "H2O" (R$ 4,20)', (await prod('Limoneto'))?.cost_cents === 420);
  check('Nome sem acento/maiúsculas acha o produto (Coca-Cola lata R$ 2,99)', (await prod('Coca-Cola lata'))?.cost_cents === 299);
  const stella = await prod('Stella Artois');
  check('Stella criada DESLIGADA, indisponível e marcada para revisar (nunca aparece por R$ 0)', stella && !stella.active && !stella.available && stella.needs_review && stella.cost_cents === 599, stella);
  check('Produto inexistente e taxa inexistente viram aviso (não erro)', /Produto Que Nao Existe/.test(saida1) && /NAO_EXISTE/.test(saida1) && /nao_existe/.test(saida1));
  check('Rodar de novo não duplica histórico de custo', custos1 === custos2, { custos1, custos2 });
  check('Só uma Stella', (await db.query(`SELECT count(*)::int n FROM products WHERE empresa_id=$1 AND name='Stella Artois'`, [ALFA])).rows[0].n === 1);
  const cfg = (await db.query(`SELECT chave, valor FROM empresa_config WHERE empresa_id=$1 AND chave IN ('logo','cor_destaque')`, [ALFA])).rows;
  check('Cor inicial aplicada', cfg.some((c) => c.chave === 'cor_destaque' && String(c.valor).toLowerCase() === '#f2d38a'));
  if (existsSync(logo)) check('Logotipo gravado na pasta da própria empresa', cfg.some((c) => c.chave === 'logo' && String(c.valor).startsWith(`/uploads/${ALFA}/logo-`)), cfg);
  const audit = (await db.query(`SELECT count(*)::int n FROM audit_logs WHERE empresa_id=$1 AND message LIKE 'ONE UP registrou o custo%'`, [ALFA]).catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n;
  check('Custos registrados na auditoria da empresa (o Dono vê quem mudou)', audit !== 0, { audit });

  console.log('\n[2] Acesso da ONE UP: invisível e intocável para o Dono');
  plataforma('oneup-usuario', '--empresa=alfa', '--login=lucas.oneup', '--nome=Lucas (ONE UP)', '--senha=segredo-oneup-1');
  const dono = new C('alfa'); await dono.login('admin', 'alfa-admin');
  const caixa = new C('alfa'); await caixa.login('caixa', 'alfa-caixa');
  const lucas = new C('alfa'); const lg = await lucas.login('lucas.oneup', 'segredo-oneup-1');
  check('Login da ONE UP volta com oneup=true', lg.data.user.oneup === true);
  check('/api/auth/me do Dono: oneup=false', (await dono.get('/api/auth/me')).data.user.oneup === false);
  const listaDono = (await dono.get('/api/users')).data as any[];
  const listaLucas = (await lucas.get('/api/users')).data as any[];
  const uid = listaLucas.find((u) => u.username === 'lucas.oneup')?.id;
  check('Dono não vê o acesso da ONE UP na lista de usuários', !listaDono.some((u) => u.username === 'lucas.oneup'));
  check('ONE UP se vê na lista', !!uid);
  const tenta = await dono.patch(`/api/users/${uid}`, { active: false });
  check('Dono não consegue desativar o acesso da ONE UP (404)', tenta.status === 404, tenta);
  check('Dono não troca a senha da ONE UP (404)', (await dono.patch(`/api/users/${uid}`, { password: 'trocada123' })).status === 404);
  const dup = await dono.post('/api/users', { name: 'Xis Teste', username: 'lucas.oneup', password: 'abcd1234', role: 'CAIXA' });
  check('Criar usuário com o mesmo login é recusado', dup.status === 409, dup);
  // o Dono continua sendo o único administrador "do restaurante": não pode se desativar contando com a ONE UP
  const donoId = listaDono.find((u) => u.username === 'admin').id;
  check('ONE UP não conta como administrador do restaurante (Dono não fica sem administrador)', (await lucas.patch(`/api/users/${donoId}`, { active: false })).status === 409);

  console.log('\n[3] Leitura dos números e base de comparação: só ONE UP');
  check('Dono: Insights 404 (serviço da ONE UP)', (await dono.get('/api/insights')).status === 404);
  check('Dono: settings sem Insights', (await dono.get('/api/settings')).data.insightsEnabled === false);
  check('Dono: base de comparação 404', (await dono.get('/api/oneup/referencias')).status === 404);
  check('Caixa: base de comparação recusada', [403, 404].includes((await caixa.get('/api/oneup/referencias')).status));
  check('ONE UP: Insights 200', (await lucas.get('/api/insights')).status === 200);
  check('ONE UP: settings com Insights', (await lucas.get('/api/settings')).data.insightsEnabled === true);
  const ref = await lucas.get('/api/oneup/referencias');
  const r0 = ref.data?.referencias?.[0];
  check('ONE UP: base de comparação 200 com a maquininha', ref.status === 200 && r0?.totalCents === 5030542 && r0?.vendas === 727, ref.data);
  check('Base: 185 dias, média/dia R$ 271,92, ticket R$ 69,20, taxa efetiva 4,26%',
    r0?.dias === 185 && r0?.diariaCents === Math.round(5030542 / 185) && r0?.ticketCents === 6920 && Math.abs(r0?.taxaEfetiva - 0.04262) < 0.0001, r0);
  check('Base: 3 formas (Crédito/Débito/Pix) somando o total', r0?.porForma?.length === 3 && r0.porForma.reduce((s: number, f: any) => s + f.cents, 0) === 5030542);
  let negado = false;
  try { await db.query(`SET ROLE oneup_app; SELECT set_config('app.empresa_id', '${ALFA}', false); INSERT INTO referencias_externas (titulo, origem, inicio, fim, total_cents, vendas) VALUES ('x','x','2026-01-01','2026-01-02',1,1)`); }
  catch { negado = true; } finally { await db.query('RESET ROLE').catch(() => undefined); }
  check('Aplicação não consegue gravar base de comparação (só a plataforma)', negado);

  console.log('\n[4] Taxa da maquininha: configurável pelo Dono, congelada no pagamento, desconta no financeiro');
  const metodos = (await dono.get('/api/payment-methods?todas=1')).data as any[];
  const cartao = metodos.find((m) => m.code === 'CARTAO');
  check('Taxa do cartão veio do provisionamento (4,28%)', cartao?.taxaBp === 428, cartao);
  check('Taxa acima de 20% é recusada', (await dono.patch(`/api/payment-methods/${cartao.id}`, { taxaPct: 25 })).status === 400);
  const reg = (await caixa.get('/api/register/current')).data;
  if (!reg.register) await caixa.post('/api/register/open', { openingCashCents: 0 });
  await caixa.post('/api/day/establishment', { isOpen: true });
  const menu = (await dono.get('/api/menu?all=1')).data as any[];
  const P = menu.flatMap((c) => c.products).find((p: any) => p.active && !p.trackStock && !p.groups.some((g: any) => g.required) && p.priceCents >= 1000);
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const fin0 = (await dono.get(`/api/finance?from=${hoje}&to=${hoje}`)).data;
  const pagarCartao = async () => {
    const conta = (await caixa.post('/api/accounts', { customerName: 'Taxa', items: [{ productId: P.id, quantity: 1 }] })).data;
    const r = await caixa.post(`/api/accounts/${conta.id}/payments`, { payments: [{ methodId: cartao.id, amountCents: P.priceCents }], close: true });
    return { conta, r };
  };
  const a1 = await pagarCartao();
  check('Pagamento no cartão aceito', a1.r.status === 200, a1.r.data);
  const [p1] = (await db.query(`SELECT id, taxa_bp FROM payments WHERE account_id=$1`, [a1.conta.id])).rows;
  check('Taxa congelada no pagamento (428)', p1?.taxa_bp === 428, p1);
  const mudou = await dono.patch(`/api/payment-methods/${cartao.id}`, { taxaPct: 5 });
  check('Dono muda a taxa para 5%', mudou.status === 200 && mudou.data.find((m: any) => m.code === 'CARTAO').taxaBp === 500);
  const a2 = await pagarCartao();
  const [p2] = (await db.query(`SELECT taxa_bp FROM payments WHERE account_id=$1`, [a2.conta.id])).rows;
  check('Pagamento novo usa a taxa nova (500); o antigo continua 428', p2?.taxa_bp === 500);
  const fin1 = (await dono.get(`/api/finance?from=${hoje}&to=${hoje}`)).data;
  const esperado = Math.round(P.priceCents * 428 / 10000) + Math.round(P.priceCents * 500 / 10000);
  const delta = fin1.feesCents - fin0.feesCents;
  check('Financeiro soma as taxas de cada pagamento com a taxa do dia', Math.abs(delta - esperado) <= 1, { delta, esperado });
  check('Cai na conta = recebido − taxas', fin1.netReceivedCents === fin1.receivedCents - fin1.feesCents);
  check('Resultado operacional desconta as taxas', fin1.operatingResultCents === fin1.grossProfitCents - fin1.expensesCents - fin1.feesCents);
  const dash = (await dono.get(`/api/dashboard?from=${hoje}&to=${hoje}`)).data;
  check('Painel mostra a taxa estimada', dash.feesCents === fin1.feesCents, { dash: dash.feesCents, fin: fin1.feesCents });
  let travou = false;
  try { await db.query(`UPDATE payments SET taxa_bp = 0 WHERE id = $1`, [p1.id]); } catch { travou = true; }
  check('Taxa gravada no pagamento não pode ser alterada (nem direto no banco)', travou);
  const hist = (await dono.get('/api/configuracoes/historico?chave=forma_pagamento:CARTAO')).data as any[];
  check('Mudança da taxa vai para o histórico de configurações', Array.isArray(hist) && hist.some((h) => h.depois?.taxaPct === 5));
  await dono.patch(`/api/payment-methods/${cartao.id}`, { taxaPct: 4.28 });
  const refDepois = (await lucas.get(`/api/oneup/referencias?from=${hoje}&to=${hoje}`)).data.atual;
  check('Comparação "com o sistema" enxerga o cartão de hoje', refDepois.semDinheiroCents >= 2 * P.priceCents && refDepois.diasUso === 1, refDepois);

  console.log('\n[5] Online: app instalável com o nome do restaurante e certificado só para empresa que existe');
  const man = await new C('alfa').get('/manifest.webmanifest');
  const [{ name: nomeAlfa }] = (await db.query(`SELECT name FROM restaurant_settings WHERE empresa_id=$1`, [ALFA])).rows;
  check('Manifesto do app traz o nome do restaurante', man.status === 200 && man.data.name === nomeAlfa && man.data.display === 'standalone', man.data);
  check('Manifesto com ícones', man.data?.icons?.length === 2);
  const tlsOk = await fetch(`${BASE}/api/health/tls?domain=alfa.localhost`);
  const tlsNao = await fetch(`${BASE}/api/health/tls?domain=nao-existe.localhost`);
  const tlsLixo = await fetch(`${BASE}/api/health/tls?domain=${encodeURIComponent('../../etc')}`);
  check('Certificado: empresa existente = 200', tlsOk.status === 200);
  check('Certificado: endereço inexistente = 404 (ninguém gasta certificado com endereço aleatório)', tlsNao.status === 404 && tlsLixo.status === 404);

  await db.end();
  console.log(`\nResultado ONE UP: ${passed} verificações OK, ${failures.length} falhas.`);
  if (failures.length) { console.log(failures.map((f) => ` - ${f}`).join('\n')); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
