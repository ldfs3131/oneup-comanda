/**
 * PORTÃO DA FASE 2 — personalização pelo Dono.
 * Usa o mesmo banco do teste de isolamento (empresas alfa e beta) e o servidor com EMPRESA_HEADER=true.
 *   BASE_URL=http://localhost:3200 DATABASE_URL=... node dist/scripts/personalizacao-test.js
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const BASE = process.env.BASE_URL ?? 'http://localhost:3200';
const DB_URL = process.env.DATABASE_URL!;
const here = dirname(fileURLToPath(import.meta.url));
let passed = 0; const failures: string[] = [];
function check(label: string, cond: unknown, extra?: unknown) {
  if (cond) { passed++; console.log(`  ✔ ${label}`); } else { failures.push(label); console.log(`  ✘ ${label}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300)); }
}
class C {
  cookie = '';
  constructor(public empresa: string) {}
  async req(method: string, path: string, body?: unknown, raw?: { body: BodyInit; type?: string }) {
    const headers: Record<string, string> = { 'x-empresa': this.empresa, ...(this.cookie ? { cookie: this.cookie } : {}) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(BASE + path, { method, headers, body: raw ? raw.body : body !== undefined ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie'); if (set) this.cookie = set.split(';')[0];
    const text = await res.text(); let data: any = null; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b: unknown = {}) => this.req('POST', p, b);
  patch = (p: string, b: unknown) => this.req('PATCH', p, b);
}
const plataforma = (...args: string[]) => execFileSync('node', [join(here, 'plataforma.js'), ...args], { env: process.env, encoding: 'utf8' });
const cfg = async (c: C) => Object.fromEntries(((await c.get('/api/configuracoes')).data.itens as any[]).map((i) => [i.chave, i]));

async function main() {
  const sys = new pg.Client({ connectionString: DB_URL }); await sys.connect();
  const dono = new C('alfa'), caixa = new C('alfa'), coz = new C('alfa'), donoB = new C('beta');
  await dono.post('/api/auth/login', { username: 'admin', password: 'alfa-admin' });
  await caixa.post('/api/auth/login', { username: 'caixa', password: 'alfa-caixa' });
  await coz.post('/api/auth/login', { username: 'cozinha', password: 'alfa-coz' });
  await donoB.post('/api/auth/login', { username: 'admin', password: 'beta-admin' });

  console.log('\n[1] Quem acessa Configurações');
  const tela = await dono.get('/api/configuracoes');
  check('Dono abre a tela gerada pelo catálogo (seções + itens)', tela.status === 200 && tela.data.secoes.length >= 6 && tela.data.itens.length >= 20, tela.data?.itens?.length);
  check('Caixa não acessa Configurações', (await caixa.get('/api/configuracoes')).status === 403);
  check('Cozinha não acessa Configurações', (await coz.get('/api/configuracoes')).status === 403);
  check('Caixa não altera Configurações', (await caixa.patch('/api/configuracoes', { valores: { nome: 'x' } })).status === 403);
  check('Nada que protege o dinheiro é configurável (sem às cegas, auditoria, imutabilidade no catálogo)',
    !(tela.data.itens as any[]).some((i) => /cega|auditoria|apagar|imut|estorno|esperado/i.test(`${i.chave} ${i.rotulo}`)));

  console.log('\n[2] Mudar, validar, histórico e voltar ao padrão');
  let r = await dono.patch('/api/configuracoes', { valores: { nome: 'Restaurante do Teste', cor_destaque: '#4fd1c5', rotulo_mesa: 'Quiosque', link_site: 'meusite.com.br' } });
  check('Dono muda nome, cor, rótulo da mesa e site de uma vez', r.status === 200 && r.data.alteradas.length === 4, r.data);
  const meta = (await new C('alfa').get('/api/meta')).data;
  check('Login (sem senha) já mostra o novo nome e a nova cor', meta.restaurantName === 'Restaurante do Teste' && meta.accent === '#4FD1C5', meta);
  const set = (await caixa.get('/api/settings')).data;
  check('Telas da equipe recebem o rótulo "Quiosque"', set.config.rotulo_mesa === 'Quiosque');
  check('Site normalizado com https://', (await cfg(dono)).link_site.valor === 'https://meusite.com.br/');
  for (const [k, v, label] of [['cor_destaque', 'vermelho', 'cor inválida'], ['desconto_max_caixa', 150, 'percentual acima de 100'], ['link_site', 'abc', 'site inválido'], ['nome', 'A', 'nome curto demais'], ['whatsapp', '123', 'telefone curto'], ['inexistente', 1, 'configuração que não existe']] as const) {
    check(`Recusa ${label}`, (await dono.patch('/api/configuracoes', { valores: { [k]: v } })).status === 400);
  }
  check('Mudança inválida em lote não grava nenhuma (tudo ou nada)', (await dono.patch('/api/configuracoes', { valores: { subtitulo: 'Válido', cor_destaque: 'x' } })).status === 400 && (await cfg(dono)).subtitulo.valor !== 'Válido');
  const hist = (await dono.get('/api/configuracoes/historico?chave=rotulo_mesa')).data;
  check('Histórico guarda antes, depois e quem mudou', hist[0]?.antes === 'Mesa' && hist[0]?.depois === 'Quiosque' && hist[0]?.usuario === 'Administrador', hist[0]);
  r = await dono.post('/api/configuracoes/padrao', { chaves: ['rotulo_mesa', 'cor_destaque'] });
  const c1 = await cfg(dono);
  check('Voltar ao padrão (por item e seção)', r.status === 200 && c1.rotulo_mesa.valor === 'Mesa' && c1.cor_destaque.ehPadrao, { mesa: c1.rotulo_mesa.valor, cor: c1.cor_destaque.valor });
  const h2 = (await dono.get('/api/configuracoes/historico?chave=rotulo_mesa')).data;
  check('Volta ao padrão também fica no histórico', h2[0]?.origem === 'PADRAO');
  const aud = (await dono.get('/api/audit')).data as any[];
  check('Auditoria registra a mudança de configuração', aud.some((a) => /alterou: Nome do restaurante/.test(a.message)));

  console.log('\n[3] Plano (ONE UP) e cadeado');
  check('Dono não muda item do plano', (await dono.patch('/api/configuracoes', { valores: { modulo_delivery: false } })).status === 403);
  plataforma('definir', '--empresa=alfa', '--chave=modulo_delivery', '--valor=false');
  r = await dono.patch('/api/configuracoes', { valores: { delivery_aberto: true } });
  check('Sem o módulo no plano, Dono não liga o delivery', r.status === 403 && /plano/.test(r.data.error), r.data);
  plataforma('definir', '--empresa=alfa', '--chave=modulo_delivery', '--valor=true');
  check('Com o módulo liberado pela ONE UP, Dono liga o delivery', (await dono.patch('/api/configuracoes', { valores: { delivery_aberto: true } })).status === 200);
  plataforma('travar', '--empresa=alfa', '--chave=desconto_max_caixa', '--motivo=Combinado com o sócio na reunião de outubro');
  const c2 = await cfg(dono);
  check('Tela mostra o cadeado com o motivo e não deixa editar', c2.desconto_max_caixa.trava?.includes('sócio') && c2.desconto_max_caixa.editavel === false);
  r = await dono.patch('/api/configuracoes', { valores: { desconto_max_caixa: 50 } });
  check('Dono não muda configuração travada', r.status === 403 && r.data.code === 'CONFIG_TRAVADA', r.data);
  check('Dono não "volta ao padrão" configuração travada', (await dono.post('/api/configuracoes/padrao', { chaves: ['desconto_max_caixa'] })).status === 403);
  plataforma('destravar', '--empresa=alfa', '--chave=desconto_max_caixa');
  check('Destravada, volta a ser do Dono', (await cfg(dono)).desconto_max_caixa.editavel === true);
  check('Travas e liberações da ONE UP aparecem no histórico do Dono', ((await dono.get('/api/configuracoes/historico?chave=desconto_max_caixa')).data as any[]).filter((h) => h.origem === 'ONEUP').length === 2);

  console.log('\n[4] As configurações mudam o comportamento de verdade');
  const menu = (await dono.get('/api/menu?all=1')).data as any[];
  const prods = menu.flatMap((m) => m.products);
  const food = prods.find((p) => p.sendsToKitchen && !p.groups?.length && !p.trackStock);
  const drink = prods.find((p) => !p.sendsToKitchen && !p.groups?.length && !p.trackStock);
  const reg = await caixa.get('/api/register/current');
  if (!reg.data.register) await caixa.post('/api/register/open', { openingCashCents: 0 });
  await dono.patch('/api/configuracoes', { valores: { exigir_nome: true, exigir_mesa: true, rotulo_mesa: 'Quiosque' } });
  r = await caixa.post('/api/accounts', { items: [{ productId: drink.id, quantity: 1 }] });
  check('Exigir nome e mesa: caixa não abre conta sem eles (mensagem usa "quiosque")', r.status === 400 && /nome do cliente/.test(r.data.error) && /quiosque/.test(r.data.error), r.data);
  r = await caixa.post('/api/accounts', { customerName: 'Fulano', tableLabel: '3', items: [{ productId: food.id, quantity: 2 }, { productId: drink.id, quantity: 1 }] });
  check('Com nome e quiosque, abre normalmente', r.status === 200, r.data);
  const accId = r.data.id;
  await dono.patch('/api/configuracoes', { valores: { exigir_nome: false, exigir_mesa: false, desconto_max_caixa: 10, cancelar_pronto_so_dono: true } });
  const sub = (await caixa.get(`/api/accounts/${accId}`)).data.totals.subtotal;
  r = await caixa.post(`/api/accounts/${accId}/discounts`, { amountCents: Math.round(sub * 0.15), reason: 'teste limite' });
  check('Desconto acima do limite (15% > 10%): caixa é barrado', r.status === 403 && r.data.code === 'DESCONTO_ACIMA_LIMITE', r.data);
  check('Dentro do limite (5%): caixa concede', (await caixa.post(`/api/accounts/${accId}/discounts`, { amountCents: Math.round(sub * 0.05), reason: 'teste limite' })).status === 200);
  check('Acumulado passaria de 10% (5% + 6%): barrado', (await caixa.post(`/api/accounts/${accId}/discounts`, { amountCents: Math.round(sub * 0.06), reason: 'teste limite' })).status === 403);
  check('Dono concede acima do limite', (await dono.post(`/api/accounts/${accId}/discounts`, { amountCents: Math.round(sub * 0.06), reason: 'cortesia do dono' })).status === 200);
  const kOrder = ((await coz.get('/api/kitchen/orders')).data as any[]).find((o) => o.account.id === accId);
  await coz.post(`/api/kitchen/orders/${kOrder.id}/start`); await coz.post(`/api/kitchen/orders/${kOrder.id}/ready`);
  const det = (await caixa.get(`/api/accounts/${accId}`)).data;
  const kitchenItem = det.orders[0].items.find((i: any) => i.goesToKitchen);
  r = await caixa.post(`/api/order-items/${kitchenItem.id}/cancel`, { reason: 'cliente desistiu', quantity: 1 });
  check('Comida já pronta: caixa não cancela (só o Dono)', r.status === 403 && r.data.code === 'CANCELAR_SO_DONO', r.data);
  check('Dono cancela comida pronta', (await dono.post(`/api/order-items/${kitchenItem.id}/cancel`, { reason: 'cliente desistiu', quantity: 1 })).status === 200);
  await dono.patch('/api/configuracoes', { valores: { desconto_max_caixa: null, cancelar_pronto_so_dono: false } });
  check('Limite vazio = sem limite (volta ao comportamento da R2)', (await cfg(dono)).desconto_max_caixa.valor === null);

  // cardápio digital
  const tracked = prods.find((p) => p.trackStock && !p.groups?.length);
  await dono.post('/api/stock/count', { items: [{ productId: tracked.id, qty: 0 }], reason: 'teste acabou' });
  await dono.patch('/api/configuracoes', { valores: { cardapio_digital_ligado: true, boas_vindas: 'Bem-vindo ao quiosque!', esconder_sem_estoque: true } });
  let pub = (await new C('alfa').get('/api/public/menu')).data;
  const soldOut = () => pub.categories.flatMap((c: any) => c.products).find((p: any) => p.id === tracked.id)?.soldOut;
  check('Cardápio digital mostra a mensagem de boas-vindas do Dono', pub.config?.boas_vindas === 'Bem-vindo ao quiosque!');
  check('Sem estoque aparece como "Acabou" (padrão)', soldOut() === true);
  await dono.patch('/api/configuracoes', { valores: { esconder_sem_estoque: false } });
  pub = (await new C('alfa').get('/api/public/menu')).data;
  check('Desligado, o produto sem estoque continua pedível (caixa decide)', soldOut() === false);
  check('Cardápio público não expõe configurações internas (limite de desconto etc.)', !('desconto_max_caixa' in (pub.config ?? {})) && !('exigir_nome' in (pub.config ?? {})));

  // formas de pagamento
  const all = (await dono.get('/api/payment-methods?todas=1')).data as any[];
  const cartao = all.find((m) => m.code === 'CARTAO'), pix = all.find((m) => m.code === 'PIX'), din = all.find((m) => m.code === 'DINHEIRO');
  await dono.patch(`/api/payment-methods/${pix.id}`, { name: 'Pix QR' });
  await dono.patch(`/api/payment-methods/${cartao.id}`, { active: false });
  const lista = (await caixa.get('/api/payment-methods')).data as any[];
  check('Caixa vê "Pix QR" e não vê o cartão desligado', lista.some((m) => m.name === 'Pix QR') && !lista.some((m) => m.code === 'CARTAO'), lista.map((m) => m.name));
  await dono.patch(`/api/payment-methods/${pix.id}`, { active: false });
  check('Não deixa desligar a última forma de pagamento', (await dono.patch(`/api/payment-methods/${din.id}`, { active: false })).status === 400);
  await dono.patch(`/api/payment-methods/${pix.id}`, { active: true });
  await dono.patch(`/api/payment-methods/${cartao.id}`, { active: true });
  check('Caixa não mexe em formas de pagamento', (await caixa.patch(`/api/payment-methods/${pix.id}`, { name: 'x' })).status === 403);

  console.log('\n[5] Logotipo');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData(); fd.append('file', new Blob([png], { type: 'image/png' }), 'logo.png');
  r = await dono.req('POST', '/api/configuracoes/logo', undefined, { body: fd });
  const empA = (await sys.query("SELECT id FROM empresas WHERE slug='alfa'")).rows[0].id;
  check('Dono envia logotipo; fica na pasta da própria empresa', r.status === 200 && r.data.logo?.startsWith(`/uploads/${empA}/`), r.data);
  check('Logotipo aparece no login', (await new C('alfa').get('/api/meta')).data.logo === r.data.logo);
  check('Arquivo do logotipo é servido no endereço da própria empresa', (await fetch(BASE + r.data.logo, { headers: { 'x-empresa': 'alfa' } })).status === 200);
  check('Logotipo da Alfa NÃO é servido no endereço da Beta', (await fetch(BASE + r.data.logo, { headers: { 'x-empresa': 'beta' } })).status === 404);
  {
    const falso = new FormData(); falso.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], { type: 'image/png' }), 'logo.png');
    const rf = await dono.req('POST', '/api/configuracoes/logo', undefined, { body: falso });
    check('Arquivo que não é imagem de verdade (SVG com script renomeado .png) é recusado', rf.status === 400, rf);
  }
  const empB = (await sys.query("SELECT id FROM empresas WHERE slug='beta'")).rows[0].id;
  check('Beta não consegue usar o logotipo da pasta da Alfa', (await donoB.patch('/api/configuracoes', { valores: { logo: r.data.logo } })).status === 400 && empB !== empA);

  console.log('\n[6] Isolamento e imutabilidade da personalização');
  const tb = await cfg(donoB);
  check('Beta não vê nome, cadeados nem valores da Alfa', tb.nome.valor !== 'Restaurante do Teste' && tb.rotulo_mesa.valor === 'Mesa' && !tb.desconto_max_caixa.trava);
  check('Beta não vê o histórico da Alfa', ((await donoB.get('/api/configuracoes/historico')).data as any[]).every((h) => h.depois !== 'Quiosque'));
  const app = new pg.Client({ connectionString: DB_URL, options: '-c role=oneup_app' }); await app.connect();
  await app.query("SELECT set_config('app.empresa_id', $1, false)", [String(empA)]);
  const tenta = async (q: string) => { try { await app.query(q); return 'aceitou'; } catch { return 'recusou'; } };
  check('Banco recusa editar o histórico de configurações', (await tenta("UPDATE config_historico SET depois = '\"x\"'")) === 'recusou');
  check('Banco recusa apagar o histórico de configurações', (await tenta('DELETE FROM config_historico')) === 'recusou');
  check('Aplicação não consegue pôr cadeado (só a ONE UP)', (await tenta("INSERT INTO config_travas (chave, motivo) VALUES ('nome', 'hack')")) === 'recusou');
  check('Aplicação não consegue tirar cadeado', (await tenta('DELETE FROM config_travas')) === 'recusou' || (await app.query('SELECT count(*)::int n FROM config_travas')).rows[0].n === 0);
  await app.end(); await sys.end();

  console.log(`\nResultado personalização: ${passed} verificações OK, ${failures.length} falhas.`);
  if (failures.length) { console.log('Falhas:\n - ' + failures.join('\n - ')); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
