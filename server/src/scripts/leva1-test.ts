/**
 * Leva 1 (3.2) — PIN por pessoa, fiado com data combinada e cobrança, fechamento às cegas, estoque do Dono,
 * pendências, importação por planilha, financeiro do Dono e lembrete de backup da ONE UP.
 * Roda na empresa "beta" do banco de duas empresas (EMPRESA_HEADER=true; veja testes.sh).
 */
import pg from 'pg';

const BASE = process.env.BASE_URL ?? 'http://localhost:3200';
const DB_URL = process.env.DATABASE_URL!;
let passed = 0;
const failures: string[] = [];
function check(label: string, cond: unknown, extra?: unknown) {
  if (cond) { passed++; console.log(`  ✔ ${label}`); } else { failures.push(label); console.log(`  ✘ ${label}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 500)); }
}
/** Cliente HTTP com "pote" de cookies (sessão + aparelho da equipe). */
class C {
  jar = new Map<string, string>();
  constructor(public empresa = 'beta', public ua = 'Mozilla/5.0 (Linux; Android 14) Teste') {}
  async req(method: string, path: string, body?: unknown) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        'x-empresa': this.empresa, 'user-agent': this.ua,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.jar.size ? { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (!v || /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)) this.jar.delete(k); else this.jar.set(k, v);
    }
    const text = await res.text();
    let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, text };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b: unknown = {}) => this.req('POST', p, b);
  patch = (p: string, b: unknown) => this.req('PATCH', p, b);
  put = (p: string, b: unknown) => this.req('PUT', p, b);
  async login(u: string, p: string) { const r = await this.post('/api/auth/login', { username: u, password: p }); if (r.status !== 200) throw new Error(`login ${u}: ${r.status} ${JSON.stringify(r.data)}`); return r; }
}
const hoje = (d = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() + d * 86400_000));

async function main() {
  const db = new pg.Client({ connectionString: DB_URL }); await db.connect();
  const [{ id: BETA }] = (await db.query(`SELECT id FROM empresas WHERE slug='beta'`)).rows;
  const dono = new C(); await dono.login('admin', 'beta-admin');
  const caixa = new C(); await caixa.login('caixa', 'beta-caixa');
  const users = (await dono.get('/api/users')).data as any[];
  const uCaixa = users.find((u) => u.role === 'CAIXA');
  const uCoz = users.find((u) => u.role === 'COZINHA');
  const menu = (await dono.get('/api/menu?all=1')).data as any[];
  const prods = menu.flatMap((c: any) => c.products);
  if ((await caixa.get('/api/register/current')).data?.register == null) await caixa.post('/api/register/open', { openingCashCents: 10000 });

  console.log('\n[M0] PIN de 4 números por pessoa, só em aparelho da equipe');
  check('Dono define PIN do Caixa', (await dono.patch(`/api/users/${uCaixa.id}`, { pin: '4821' })).status === 200);
  check('Definir o primeiro PIN não derruba o caixa no meio do serviço', (await caixa.get('/api/auth/me')).status === 200);
  check('PIN tem que ter 4 números', (await dono.patch(`/api/users/${uCoz.id}`, { pin: '12' })).status === 400);
  await dono.patch(`/api/users/${uCoz.id}`, { pin: '7310' });
  const donoId = users.find((u) => u.role === 'ADMIN' && !u.oneup).id;
  check('Dono não tem PIN (entra com usuário e senha)', (await dono.patch(`/api/users/${donoId}`, { pin: '1111' })).status === 400);
  const lista = (await dono.get('/api/users')).data as any[];
  check('Lista de usuários mostra quem tem PIN (sem mostrar o PIN)', lista.find((u) => u.id === uCaixa.id).temPin === true && !JSON.stringify(lista).includes('4821'));
  const estranho = new C('beta', 'Mozilla/5.0 (iPhone) Estranho');
  check('Aparelho desconhecido não lista ninguém', (await estranho.get('/api/auth/pin/pessoas')).data.aparelho === false);
  check('Aparelho desconhecido não entra com PIN (403)', (await estranho.post('/api/auth/pin', { userId: uCaixa.id, pin: '4821' })).status === 403);
  // tablet do restaurante: o Dono entra uma vez com senha → vira aparelho da equipe
  const tablet = new C('beta', 'Mozilla/5.0 (Linux; Android 13; Tab) Tablet do balcão');
  await tablet.login('admin', 'beta-admin');
  await tablet.post('/api/auth/logout');
  const pessoas = (await tablet.get('/api/auth/pin/pessoas')).data;
  check('Tablet da equipe lista Caixa e Cozinha (nunca Dono nem ONE UP)', pessoas.aparelho === true && pessoas.pessoas.length === 2 && pessoas.pessoas.every((p: any) => ['CAIXA', 'COZINHA'].includes(p.role)), pessoas);
  check('PIN errado é recusado', (await tablet.post('/api/auth/pin', { userId: uCaixa.id, pin: '0000' })).status === 400);
  const ok = await tablet.post('/api/auth/pin', { userId: uCaixa.id, pin: '4821' });
  check('PIN certo entra como Caixa', ok.status === 200 && (await tablet.get('/api/auth/me')).data?.user?.role === 'CAIXA', ok.data);
  const quem = (await db.query(`SELECT message FROM audit_logs WHERE empresa_id=$1 AND action='auth.login' ORDER BY id DESC LIMIT 1`, [BETA])).rows[0];
  check('Auditoria registra "entrou com PIN" e o aparelho', /entrou com PIN/.test(quem.message) && /Tablet|Android/.test(quem.message), quem);
  for (let i = 0; i < 5; i++) await tablet.post('/api/auth/pin', { userId: uCoz.id, pin: '9999' });
  const bloq = await tablet.post('/api/auth/pin', { userId: uCoz.id, pin: '7310' });
  check('5 erros bloqueiam o PIN por alguns minutos (até o certo)', bloq.status === 429 || bloq.status === 423 || bloq.status === 403, bloq);
  await db.query(`UPDATE users SET pin_bloqueado_ate = NULL, pin_falhas = 0 WHERE id=$1`, [uCoz.id]);
  const aps = (await dono.get('/api/aparelhos')).data as any[];
  check('Dono vê os aparelhos da equipe', aps.length >= 1 && aps.some((a) => /Android/.test(a.nome ?? '')), aps);
  const apTablet = aps.find((a) => /Tab|Android 13/.test(a.nome ?? '')) ?? aps[0];
  await dono.post(`/api/aparelhos/${apTablet.id}/revogar`);
  const tablet2 = new C('beta', tablet.ua); tablet2.jar = new Map([...tablet.jar].filter(([k]) => k === 'oneup_aparelho'));
  check('Aparelho revogado não entra mais com PIN', (await tablet2.post('/api/auth/pin', { userId: uCaixa.id, pin: '4821' })).status === 403);

  console.log('\n[M2] Identificação mínima do pedido');
  const p1 = prods.find((p: any) => p.active && p.priceCents > 0);
  check('Sem nome, telefone, mesa nem obs → recusado', (await caixa.post('/api/accounts', { items: [{ productId: p1.id, quantity: 1 }] })).status === 400);
  check('Obs de 1 letra não vale', (await caixa.post('/api/accounts', { note: 'a', items: [{ productId: p1.id, quantity: 1 }] })).status === 400);
  const soMesa = await caixa.post('/api/accounts', { tableLabel: '12', items: [{ productId: p1.id, quantity: 1 }] });
  check('Só a mesa basta', soMesa.status === 200, soMesa.data);

  console.log('\n[M4] A receber: data combinada, etiquetas por urgência e cobrança desligada por padrão');
  const mk = async (nome: string, data: string | null) => {
    const a = await caixa.post('/api/accounts', { customerName: nome, items: [{ productId: p1.id, quantity: 1 }] });
    const r = await caixa.post(`/api/accounts/${a.data.id}/pending`, { customerName: nome, contact: 'casa 3', ...(data ? { promisedDate: data } : {}) });
    return { id: a.data.id, r };
  };
  check('Data combinada no passado é recusada', (await mk('Passado', hoje(-1))).r.status === 400);
  const emDia = await mk('Em Dia', hoje(5));
  const deHoje = await mk('De Hoje', hoje(0));
  const semData = await mk('Sem Data', null);
  await db.query(`UPDATE accounts SET promised_date = $1 WHERE id = (SELECT id FROM accounts WHERE empresa_id=$2 AND customer_name='Passado' ORDER BY id DESC LIMIT 1)`, [hoje(-3), BETA]);
  await db.query(`UPDATE accounts SET status='PENDING', pending_at=now(), contact='casa 3' WHERE empresa_id=$1 AND customer_name='Passado'`, [BETA]);
  const rec = (await caixa.get('/api/accounts/receivable')).data as any[];
  const ordem = rec.map((a) => a.situacao);
  check('Etiquetas: venceu / hoje / sem data / em dia', rec.find((a) => a.id === emDia.id)?.situacao === 'em_dia' && rec.find((a) => a.id === deHoje.id)?.situacao === 'hoje' && rec.find((a) => a.id === semData.id)?.situacao === 'sem_data' && ordem.includes('venceu'), rec.map((a) => [a.customerName, a.situacao]));
  check('Ordenado por urgência (vencidos primeiro, em dia por último)', ordem.indexOf('venceu') < ordem.indexOf('hoje') && ordem.lastIndexOf('em_dia') === ordem.length - 1, ordem);
  check('Data combinada vem na lista', rec.find((a) => a.id === emDia.id)?.promisedDate === hoje(5));
  const cob0 = (await caixa.get('/api/accounts/receivable/cobranca')).data;
  check('Cobrança pelo WhatsApp DESLIGADA por padrão', cob0.ligada === false && cob0.mensagem === null, cob0);
  check('Botão cobrar recusado com a cobrança desligada', (await caixa.post(`/api/accounts/${emDia.id}/cobranca`)).status === 403);
  const tela = (await dono.get('/api/configuracoes')).data;
  check('Dono não vê a chave de cobrança nas Configurações', !tela.itens.some((i: any) => i.chave === 'cobranca_whatsapp') && !tela.secoes.some((s: any) => s.id === 'oneup'));
  check('Dono não consegue ligar a cobrança', (await dono.patch('/api/configuracoes', { valores: { cobranca_whatsapp: true } })).status === 403);
  await db.query(`UPDATE users SET oneup = true WHERE empresa_id=$1 AND id=$2`, [BETA, donoId]);
  await dono.login('admin', 'beta-admin'); // sessão nova (a anterior fica em cache por 10 s)
  const telaOne = (await dono.get('/api/configuracoes')).data;
  check('ONE UP vê a seção "ONE UP (só você vê)"', telaOne.secoes.some((s: any) => s.id === 'oneup') && telaOne.itens.find((i: any) => i.chave === 'cobranca_whatsapp')?.editavel === true);
  check('ONE UP liga a cobrança do restaurante', (await dono.patch('/api/configuracoes', { valores: { cobranca_whatsapp: true } })).status === 200);
  console.log('\n[M1] Lembrete de backup externo (só ONE UP)');
  const l1 = (await dono.get('/api/oneup/lembretes')).data;
  check('Nunca confirmado → lembrete aparece', l1.backupExterno.mostrar === true, l1);
  await dono.post('/api/oneup/lembretes/backup', { acao: 'amanha' });
  check('"Lembrar amanhã" esconde o lembrete', (await dono.get('/api/oneup/lembretes')).data.backupExterno.mostrar === false);
  await dono.post('/api/oneup/lembretes/backup', { acao: 'feito' });
  const l3 = (await dono.get('/api/oneup/lembretes')).data;
  check('"Já fiz" grava a data', l3.backupExterno.mostrar === false && !!l3.backupExterno.ultimoEm);
  await db.query(`UPDATE users SET oneup = false WHERE empresa_id=$1 AND id=$2`, [BETA, donoId]);
  await dono.login('admin', 'beta-admin');
  check('Dono não vê o lembrete (404)', (await dono.get('/api/oneup/lembretes')).status === 404);
  const cob1 = (await caixa.get('/api/accounts/receivable/cobranca')).data;
  check('Com a cobrança ligada, a mensagem editável vem pronta', cob1.ligada === true && /\{nome\}/.test(cob1.mensagem), cob1);
  check('Cobrar registra a última cobrança (quem e quando)', (await caixa.post(`/api/accounts/${emDia.id}/cobranca`)).status === 200
    && (await caixa.get('/api/accounts/receivable')).data.find((a: any) => a.id === emDia.id)?.ultimaCobrancaPor === 'Caixa');

  console.log('\n[M5] Fechamento às cegas');
  const cur = (await caixa.get('/api/register/current')).data;
  const txt = JSON.stringify(cur.summary);
  check('Caixa: nada de esperado, PIX, cartão ou total', cur.summary.expectedCashCents === null && cur.summary.salesCents === null && cur.summary.byMethod.length === 0 && cur.summary.receivedCents === null, txt.slice(0, 200));

  console.log('\n[M7] Estoque do Dono');
  const pe = prods.find((p: any) => p.trackStock) ?? prods.find((p: any) => p.active);
  if (!pe.trackStock) await dono.put(`/api/products/${pe.id}`, { ...pe, trackStock: true, groups: [] });
  await db.query(`UPDATE products SET stock_qty = 2, low_stock_at = 3, cost_cents = 500 WHERE id=$1`, [pe.id]);
  const stCx = (await caixa.get('/api/stock')).data as any[];
  check('Caixa vê só o aviso "acabando", sem quantidade nem valor', stCx.some((s) => s.id === pe.id && s.situacao === 'acabando') && stCx.every((s) => s.stockQty === undefined && s.costCents === undefined), stCx);
  check('Caixa não lança entrada nem ajuste', (await caixa.post(`/api/stock/${pe.id}`, { type: 'ENTRADA', quantity: 5 })).status === 403);
  const stDono = (await dono.get('/api/stock')).data as any[];
  check('Dono vê quantidade, mínimo e situação', stDono.find((s) => s.id === pe.id)?.stockQty === 2 && stDono.find((s) => s.id === pe.id)?.situacao === 'acabando');
  const ent = await dono.post(`/api/stock/${pe.id}`, { type: 'ENTRADA', quantity: 10, unitCostCents: 620, fornecedor: 'Distribuidora Teste' });
  check('Entrada com custo diferente PERGUNTA se atualiza o custo (não muda sozinho)', ent.status === 200 && ent.data.after === 12 && ent.data.custoDiferente?.atual === 500 && ent.data.custoDiferente?.novo === 620, ent.data);
  check('Custo do produto continua o mesmo até o Dono confirmar', (await db.query(`SELECT cost_cents FROM products WHERE id=$1`, [pe.id])).rows[0].cost_cents === 500);
  const mov = (await db.query(`SELECT unit_cost_cents, fornecedor, reason FROM stock_movements WHERE product_id=$1 ORDER BY id DESC LIMIT 1`, [pe.id])).rows[0];
  check('Movimento guarda custo unitário e fornecedor', mov.unit_cost_cents === 620 && mov.fornecedor === 'Distribuidora Teste', mov);
  check('Ajuste sem motivo é recusado', (await dono.post(`/api/stock/${pe.id}`, { type: 'AJUSTE', newQty: 11 })).status === 400);
  check('"Outro" exige explicação', (await dono.post(`/api/stock/${pe.id}`, { type: 'AJUSTE', newQty: 11, motivo: 'outro' })).status === 400);
  const aj = await dono.post(`/api/stock/${pe.id}`, { type: 'AJUSTE', newQty: 11, motivo: 'quebra' });
  check('Ajuste por quebra registrado', aj.status === 200 && (await db.query(`SELECT reason FROM stock_movements WHERE product_id=$1 ORDER BY id DESC LIMIT 1`, [pe.id])).rows[0].reason === 'Quebra');
  check('Mínimo por produto', (await dono.post(`/api/stock/${pe.id}/minimo`, { lowStockAt: 15 })).status === 200 && (await dono.get('/api/stock')).data.find((s: any) => s.id === pe.id).situacao === 'acabando');
  check('Histórico de movimentações (Dono)', ((await dono.get('/api/stock/historico')).data as any[]).length >= 2);
  const sug0 = (await dono.get('/api/stock/sugestao')).data;
  check('Menos de 14 dias de dados → "ainda sem dados suficientes"', sug0.suficiente === false && sug0.diasMinimos === 14, sug0);
  // simula 20 dias de uso: o primeiro pedido foi há 20 dias, e 18 unidades vendidas na janela
  await db.query(`UPDATE orders SET created_at = now() - interval '20 days' WHERE id = (SELECT MIN(id) FROM orders WHERE empresa_id=$1)`, [BETA]);
  const sug1 = (await dono.get('/api/stock/sugestao')).data;
  const it = sug1.itens.find((i: any) => i.id === pe.id);
  check('Sugestão mostra a conta ("vende X/dia × 7 dias = N; tem M")', sug1.suficiente === true && sug1.diasCobertura === 7 && /× 7 dias|não vendeu/.test(it?.conta ?? ''), it ?? sug1);
  check('Caixa não vê a sugestão de compra', (await caixa.get('/api/stock/sugestao')).status === 403);

  console.log('\n[M3] Pendências');
  const custom = { custom: { description: 'Gelo extra', priceCents: 300, goesToKitchen: false }, quantity: 1 };
  for (let i = 0; i < 2; i++) await caixa.post('/api/accounts', { tableLabel: `G${i}`, items: [custom] });
  const pend = (await dono.get('/api/pendencias')).data;
  check('Avulso repetido aparece com preço sugerido', pend.avulsos.some((a: any) => a.nome === 'Gelo extra' && a.vezes >= 2 && a.precoSugeridoCents === 300), pend.avulsos);
  check('Produtos sem custo aparecem', Array.isArray(pend.semCusto) && pend.total >= pend.avulsos.length);
  check('Caixa não vê pendências', (await caixa.get('/api/pendencias')).status === 403);
  await dono.post('/api/pendencias/resolver', { tipo: 'avulso', chave: 'Gelo Extra', acao: 'ignorado' });
  check('Resolvido some da lista (sem diferenciar maiúsculas)', !(await dono.get('/api/pendencias')).data.avulsos.some((a: any) => a.nome === 'Gelo extra'));

  console.log('\n[M8] Importação por planilha (CSV)');
  const modelo = await dono.get('/api/importacao/produtos/modelo');
  check('Modelo para baixar com as colunas certas', modelo.status === 200 && /categoria;produto;preco;custo;estoque_inicial;estoque_minimo;ativo;envia_cozinha/.test(modelo.text));
  const existente = prods.find((p: any) => p.active && p.id !== pe.id);
  const csv = [
    'categoria;produto;preco;custo;estoque_inicial;estoque_minimo;ativo;envia_cozinha',
    `${'Bebidas'};Suco Novo Teste;9,50;3,20;24;6;sim;não`,
    `Qualquer;${existente.name.toUpperCase()};"1.234,56";;;;sim;sim`,
    'Bebidas;Sem Preço;;;;;sim;não',
    'Bebidas;Preço Ruim;doze;;;;sim;não',
    'Bebidas;Suco Novo Teste;9,50;;;;sim;não',
  ].join('\n');
  const prev = (await dono.post('/api/importacao/produtos/previa', { csv })).data;
  check('Prévia: 1 novo, 1 atualização pelo nome (maiúsculas não importam), 3 erros por linha', prev.resumo?.criar === 1 && prev.resumo.atualizar === 1 && prev.resumo.erros === 3, prev.resumo ?? prev);
  check('Erro explica a linha (preço inválido, repetido)', prev.linhas.some((l: any) => l.linha === 5 && /preço inválido/.test(l.erros.join())) && prev.linhas.some((l: any) => /repetido/.test(l.erros.join())));
  check('Prévia não grava nada', (await db.query(`SELECT 1 FROM products WHERE empresa_id=$1 AND name='Suco Novo Teste'`, [BETA])).rowCount === 0);
  const conf = (await dono.post('/api/importacao/produtos/confirmar', { csv })).data;
  check('Confirmar cria e atualiza; linhas com erro ficam de fora', conf.criados === 1 && conf.atualizados === 1 && conf.ignoradas === 3, conf);
  const novo = (await db.query(`SELECT * FROM products WHERE empresa_id=$1 AND name='Suco Novo Teste'`, [BETA])).rows[0];
  check('Produto novo com preço, custo, estoque inicial e mínimo', novo?.price_cents === 950 && novo.cost_cents === 320 && novo.track_stock && novo.stock_qty === 24 && novo.low_stock_at === 6 && novo.sends_to_kitchen === false, novo);
  check('Preço "1.234,56" lido certo', (await db.query(`SELECT price_cents FROM products WHERE id=$1`, [existente.id])).rows[0].price_cents === 123456);
  check('Nada foi apagado', (await db.query(`SELECT count(*)::int n FROM products WHERE empresa_id=$1`, [BETA])).rows[0].n >= prods.length + 1);
  check('Caixa não importa', (await caixa.post('/api/importacao/produtos/previa', { csv })).status === 403);

  console.log('\n[M6] Financeiro do Dono');
  const fin = (await dono.get(`/api/finance?from=${hoje(-29)}&to=${hoje()}`)).data;
  check('Lucro, margem e comparação com o período anterior', typeof fin.lucroCents === 'number' && 'margemLucro' in fin && fin.anterior?.to === hoje(-30), fin.anterior);
  check('Cascata bate exato: Vendido − Descontos − Custo − Despesas − Taxas = Lucro',
    fin.grossSalesCents - fin.discountsCents - fin.costCents - fin.expensesCents - fin.feesCents === fin.lucroCents);
  check('Tabela de produtos em ordem alfabética', fin.tabela.map((t: any) => t.name).join('|') === [...fin.tabela].map((t: any) => t.name).sort((a: string, b: string) => a.localeCompare(b, 'pt-BR')).join('|'));
  check('Produto sem custo mostra "sem custo" (margem nula, nunca 100%)', fin.tabela.filter((t: any) => t.costCents == null).every((t: any) => t.margemPct === null));
  check('Alerta de vendas sem custo vem da API', Array.isArray(fin.semCusto));
  const ano = (await dono.get(`/api/finance?from=${hoje(-364)}&to=${hoje()}&ano=1`)).data;
  check('Ano: 12 meses, mês sem dados = "sem dados" (null, nunca zero)', ano.meses?.length === 12 && ano.meses.some((m: any) => m.vendidoCents === null) && ano.meses[11].vendidoCents !== null, ano.meses);

  await db.end();
  console.log(`\nResultado Leva 1: ${passed} verificações OK, ${failures.length} falhas.`);
  if (failures.length) { console.log(' - ' + failures.join('\n - ')); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
