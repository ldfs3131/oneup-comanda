import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { db, empresaAtual, type Executor } from '../db/index.js';
import { categories, productCosts, products, stockMovements } from '../db/schema.js';
import { me, requireRole } from '../auth.js';
import { bad, brl, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { notify } from '../realtime.js';

/*
 * IMPORTAÇÃO DE PRODUTOS POR PLANILHA (CSV) — como o Rafael manda preços e custos.
 * Baixar modelo → colar/enviar → pré-visualização com erro por linha → confirmar.
 * Regras: atualiza o que já existe PELO NOME (sem diferenciar maiúsculas/acentos); cria o que não existe; NUNCA apaga.
 * Estoque inicial só vale para produto novo (ou que ainda não controlava estoque): o estoque atual nunca é sobrescrito.
 */
export const COLUNAS = ['categoria', 'produto', 'preco', 'custo', 'estoque_inicial', 'estoque_minimo', 'ativo', 'envia_cozinha'] as const;
export const MODELO_CSV = [
  COLUNAS.join(';'),
  'Bebidas;Refrigerante lata;6,00;2,80;48;12;sim;não',
  'Porções;Batata frita;32,00;9,50;;;sim;sim',
  'Lanches;X-Salada;28,00;;;;sim;sim',
].join('\r\n') + '\r\n';

const semAcento = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Divide uma linha CSV respeitando aspas. */
function dividir(linha: string, sep: string): string[] {
  const out: string[] = []; let atual = ''; let aspas = false;
  for (let i = 0; i < linha.length; i++) {
    const ch = linha[i];
    if (aspas) {
      if (ch === '"' && linha[i + 1] === '"') { atual += '"'; i++; }
      else if (ch === '"') aspas = false;
      else atual += ch;
    } else if (ch === '"') aspas = true;
    else if (ch === sep) { out.push(atual); atual = ''; }
    else atual += ch;
  }
  out.push(atual);
  return out.map((c) => c.trim());
}

/** "12,50" | "12.50" | "R$ 1.234,56" → centavos. Vazio → null. Inválido → NaN. */
function dinheiro(v: string): number | null {
  const t = v.replace(/R\$\s*/i, '').replace(/\s/g, '');
  if (!t) return null;
  let n: string;
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) n = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d+(,\d{1,2})?$/.test(t)) n = t.replace(',', '.');
  else if (/^\d+(\.\d{1,2})?$/.test(t)) n = t;
  else return NaN;
  return Math.round(Number(n) * 100);
}
function inteiro(v: string): number | null {
  if (!v.trim()) return null;
  return /^\d{1,6}$/.test(v.trim()) ? Number(v.trim()) : NaN;
}
function simNao(v: string): boolean | null {
  const t = semAcento(v);
  if (!t) return null;
  if (['sim', 's', 'x', '1', 'true', 'yes', 'ativo'].includes(t)) return true;
  if (['nao', 'n', '0', 'false', 'no', 'inativo'].includes(t)) return false;
  return undefined as unknown as null; // inválido
}

type Linha = {
  linha: number; categoria: string; produto: string; preco: number | null; custo: number | null;
  estoqueInicial: number | null; estoqueMinimo: number | null; ativo: boolean | null; enviaCozinha: boolean | null;
  erros: string[]; acao: 'criar' | 'atualizar' | 'erro'; mudancas: string[]; avisos: string[]; produtoId: number | null;
};

async function analisar(tx: Executor, csv: string) {
  const texto = csv.replace(/^﻿/, '');
  const linhas = texto.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!linhas.length) throw bad('A planilha está vazia.');
  if (linhas.length > 1001) throw bad('Máximo de 1.000 produtos por importação.');
  const sep = (linhas[0].match(/;/g)?.length ?? 0) >= (linhas[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const cab = dividir(linhas[0], sep).map((c) => semAcento(c).replace(/[ -]/g, '_'));
  const idx = Object.fromEntries(COLUNAS.map((c) => [c, cab.indexOf(c)])) as Record<(typeof COLUNAS)[number], number>;
  const faltam = (['categoria', 'produto', 'preco'] as const).filter((c) => idx[c] < 0);
  if (faltam.length) throw bad(`Cabeçalho sem a(s) coluna(s): ${faltam.join(', ')}. Baixe o modelo e use a primeira linha dele.`);

  const existentes = await tx.select({ id: products.id, name: products.name, priceCents: products.priceCents, costCents: products.costCents,
    lowStockAt: products.lowStockAt, active: products.active, sendsToKitchen: products.sendsToKitchen, trackStock: products.trackStock,
    categoryId: products.categoryId }).from(products);
  const cats = await tx.select({ id: categories.id, name: categories.name }).from(categories);
  const catPorNome = new Map(cats.map((c) => [semAcento(c.name), c]));
  const porNome = new Map(existentes.map((p) => [semAcento(p.name), p]));
  const vistos = new Map<string, number>();
  const out: Linha[] = [];

  for (let i = 1; i < linhas.length; i++) {
    const cel = dividir(linhas[i], sep);
    const get = (c: (typeof COLUNAS)[number]) => (idx[c] >= 0 ? cel[idx[c]] ?? '' : '');
    const l: Linha = {
      linha: i + 1, categoria: get('categoria').replace(/\s+/g, ' '), produto: get('produto').replace(/\s+/g, ' '),
      preco: dinheiro(get('preco')), custo: dinheiro(get('custo')), estoqueInicial: inteiro(get('estoque_inicial')),
      estoqueMinimo: inteiro(get('estoque_minimo')), ativo: simNao(get('ativo')), enviaCozinha: simNao(get('envia_cozinha')),
      erros: [], acao: 'criar', mudancas: [], avisos: [], produtoId: null,
    };
    if (l.produto.length < 2) l.erros.push('produto sem nome');
    if (l.produto.length > 80) l.erros.push('nome do produto com mais de 80 letras');
    if (l.categoria.length < 2) l.erros.push('categoria vazia');
    if (l.preco === null) l.erros.push('preço vazio');
    else if (Number.isNaN(l.preco)) l.erros.push(`preço inválido ("${get('preco')}") — use 12,50`);
    else if (l.preco > 100_000_00) l.erros.push('preço acima de R$ 100.000');
    else if (l.preco === 0) l.erros.push('preço zero — produto sem preço trava no caixa; deixe a linha de fora ou informe o preço');
    if (/^\s*(R\$\s*)?\d{1,3}(\.\d{3})+\s*$/.test(get('preco'))) l.avisos.push(`confira o preço: "${get('preco')}" foi lido como ${l.preco != null && !Number.isNaN(l.preco) ? brl(l.preco) : '?'}`);
    if (l.custo !== null && Number.isNaN(l.custo)) l.erros.push(`custo inválido ("${get('custo')}") — use 4,30 ou deixe vazio`);
    if (l.preco != null && l.custo != null && !Number.isNaN(l.preco) && !Number.isNaN(l.custo) && l.custo > l.preco) l.avisos.push('custo maior que o preço');
    if (Number.isNaN(l.estoqueInicial as number)) l.erros.push('estoque inicial deve ser número inteiro');
    if (Number.isNaN(l.estoqueMinimo as number)) l.erros.push('estoque mínimo deve ser número inteiro');
    if (l.ativo === undefined as unknown) l.erros.push('ativo: use sim ou não');
    if (l.enviaCozinha === undefined as unknown) l.erros.push('envia_cozinha: use sim ou não');
    const chave = semAcento(l.produto);
    if (vistos.has(chave)) l.erros.push(`produto repetido (já está na linha ${vistos.get(chave)})`);
    else vistos.set(chave, l.linha);

    const atual = porNome.get(chave);
    if (atual) {
      l.produtoId = atual.id; l.acao = 'atualizar';
      if (l.preco != null && !Number.isNaN(l.preco) && l.preco !== atual.priceCents) l.mudancas.push(`preço ${brl(atual.priceCents)} → ${brl(l.preco)}`);
      if (l.preco != null && !Number.isNaN(l.preco) && atual.priceCents > 0 && (l.preco > atual.priceCents * 5 || l.preco * 5 < atual.priceCents)) l.avisos.push('preço mudou mais de 5 vezes — confira se não falta ou sobra um zero');
      if (l.custo != null && !Number.isNaN(l.custo) && l.custo !== atual.costCents) l.mudancas.push(`custo ${atual.costCents == null ? 'sem custo' : brl(atual.costCents)} → ${brl(l.custo)}`);
      if (l.estoqueMinimo != null && !Number.isNaN(l.estoqueMinimo) && l.estoqueMinimo !== atual.lowStockAt) l.mudancas.push(`mínimo ${atual.lowStockAt} → ${l.estoqueMinimo}`);
      if (l.ativo != null && l.ativo !== atual.active) l.mudancas.push(l.ativo ? 'reativado' : 'desativado');
      if (l.enviaCozinha != null && l.enviaCozinha !== atual.sendsToKitchen) l.mudancas.push(l.enviaCozinha ? 'passa a ir para a cozinha' : 'deixa de ir para a cozinha');
      const cat = catPorNome.get(semAcento(l.categoria));
      if (l.categoria && (!cat || cat.id !== atual.categoryId)) l.mudancas.push(`categoria → ${l.categoria}${cat ? '' : ' (nova)'}`);
      if (l.estoqueInicial != null && !Number.isNaN(l.estoqueInicial)) {
        if (atual.trackStock) l.avisos.push('estoque atual mantido (para corrigir, use Estoque → Ajustar)');
        else l.mudancas.push(`passa a controlar estoque: ${l.estoqueInicial}`);
      }
      if (!l.mudancas.length && !l.erros.length) l.avisos.push('nada muda');
    } else if (!catPorNome.get(semAcento(l.categoria)) && l.categoria.length >= 2) {
      l.avisos.push(`categoria "${l.categoria}" será criada`);
    }
    if (l.erros.length) l.acao = 'erro';
    out.push(l);
  }
  const resumo = {
    criar: out.filter((l) => l.acao === 'criar').length,
    atualizar: out.filter((l) => l.acao === 'atualizar' && l.mudancas.length).length,
    semMudanca: out.filter((l) => l.acao === 'atualizar' && !l.mudancas.length).length,
    erros: out.filter((l) => l.acao === 'erro').length,
  };
  return { linhas: out, resumo };
}

export async function importacaoRoutes(app: FastifyInstance) {
  const dono = { preHandler: requireRole('ADMIN') };
  const corpo = z.object({ csv: z.string().min(1, 'cole ou envie a planilha').max(500_000, 'planilha grande demais (máx. 500 KB)') });

  app.get('/api/importacao/produtos/modelo', dono, async (_req, reply) => {
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="modelo-produtos.csv"');
    return '﻿' + MODELO_CSV;
  });

  app.post('/api/importacao/produtos/previa', dono, async (req) => {
    const { csv } = parse(corpo, req.body);
    return analisar(db, csv);
  });

  app.post('/api/importacao/produtos/confirmar', dono, async (req) => {
    const { csv } = parse(corpo, req.body);
    const user = me(req);
    const r = await db.transaction(async (tx) => {
      // uma importação por vez POR RESTAURANTE (a trava antiga era global: um restaurante esperava o outro)
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${empresaAtual()}::int, hashtext('importacao-produtos'))`);
      const { linhas, resumo } = await analisar(tx, csv);
      // trava de uma vez, em ordem de id, todos os produtos que vão mudar (ordem fixa = sem impasse com vendas/ajustes)
      const idsAtualizar = linhas.filter((l) => l.acao === 'atualizar' && l.mudancas.length).map((l) => l.produtoId!);
      const travados = new Map((idsAtualizar.length
        ? await tx.select().from(products).where(inArray(products.id, idsAtualizar)).orderBy(asc(products.id)).for('update')
        : []).map((p) => [p.id, p]));
      const catPorNome = new Map((await tx.select({ id: categories.id, name: categories.name }).from(categories)).map((c) => [semAcento(c.name), c.id]));
      const [{ maxCat }] = (await tx.execute(sql`SELECT COALESCE(MAX(sort_order), 0)::int AS "maxCat" FROM categories`)).rows as { maxCat: number }[];
      let ordemCat = maxCat;
      const categoria = async (nome: string, cozinha: boolean) => {
        const k = semAcento(nome);
        if (catPorNome.has(k)) return catPorNome.get(k)!;
        const [c] = await tx.insert(categories).values({ name: nome, sortOrder: ++ordemCat, sendsToKitchen: cozinha }).returning({ id: categories.id });
        catPorNome.set(k, c.id);
        return c.id;
      };
      let criados = 0, atualizados = 0;
      for (const l of linhas) {
        if (l.acao === 'erro' || (l.acao === 'atualizar' && !l.mudancas.length)) continue;
        const catId = await categoria(l.categoria, l.enviaCozinha ?? true);
        if (l.acao === 'criar') {
          const [{ m }] = (await tx.execute(sql`SELECT COALESCE(MAX(sort_order), 0)::int AS m FROM products WHERE category_id = ${catId}`)).rows as { m: number }[];
          const controla = l.estoqueInicial != null;
          const [p] = await tx.insert(products).values({
            categoryId: catId, name: l.produto, priceCents: l.preco!, costCents: l.custo, sortOrder: m + 1,
            active: l.ativo ?? true, sendsToKitchen: l.enviaCozinha ?? true, trackStock: controla, stockQty: l.estoqueInicial ?? 0,
            lowStockAt: l.estoqueMinimo ?? 3,
          }).returning({ id: products.id });
          if (l.custo != null) await tx.insert(productCosts).values({ productId: p.id, costCents: l.custo, userId: user.id });
          if (controla && l.estoqueInicial) await tx.insert(stockMovements).values({ productId: p.id, type: 'AJUSTE', quantity: l.estoqueInicial, before: 0, after: l.estoqueInicial, reason: 'Importação por planilha: estoque inicial', userId: user.id });
          criados++;
        } else {
          const p = travados.get(l.produtoId!)!;
          const set: Partial<typeof products.$inferInsert> = { categoryId: catId, updatedAt: new Date() };
          if (l.preco != null) set.priceCents = l.preco;
          if (l.custo != null && l.custo !== p.costCents) { set.costCents = l.custo; await tx.insert(productCosts).values({ productId: p.id, costCents: l.custo, userId: user.id }); }
          if (l.estoqueMinimo != null) set.lowStockAt = l.estoqueMinimo;
          if (l.ativo != null) set.active = l.ativo;
          if (l.enviaCozinha != null) set.sendsToKitchen = l.enviaCozinha;
          if (l.estoqueInicial != null && !p.trackStock) {
            set.trackStock = true; set.stockQty = l.estoqueInicial;
            await tx.insert(stockMovements).values({ productId: p.id, type: 'AJUSTE', quantity: l.estoqueInicial - p.stockQty, before: p.stockQty, after: l.estoqueInicial, reason: 'Importação por planilha: estoque inicial', userId: user.id });
          }
          await tx.update(products).set(set).where(eq(products.id, p.id));
          await audit(tx, { userId: user.id, action: 'product.import', entityType: 'product', entityId: p.id, message: `${user.name} atualizou "${p.name}" pela planilha: ${l.mudancas.join('; ')}.` });
          atualizados++;
        }
      }
      await audit(tx, { userId: user.id, action: 'import.products', message: `${user.name} importou a planilha de produtos: ${criados} criado(s), ${atualizados} atualizado(s)${resumo.erros ? `, ${resumo.erros} linha(s) com erro ignorada(s)` : ''}. Nada foi apagado.` });
      return { criados, atualizados, ignoradas: resumo.erros };
    });
    notify.menuChanged();
    return r;
  });
}
