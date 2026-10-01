import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, empresaAtual, type Executor } from '../db/index.js';
import { configHistorico, configTravas, deliverySettings, empresaConfig, restaurantSettings, users } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../lib/http.js';
import type { AuthUser } from '../auth.js';

/*
 * CATÁLOGO DE CONFIGURAÇÕES DO ONE UP COMANDA
 * -------------------------------------
 * Uma entrada por configuração. A tela de Configurações é GERADA daqui: opção nova = entrada nova.
 * Regra do produto: o que é GOSTO/JEITO do negócio, o Dono decide (quem: 'DONO'). O que é plano/módulo,
 * a ONE UP decide (quem: 'ONEUP'). O que PROTEGE O DINHEIRO (imutabilidade, fechamento às cegas,
 * auditoria, cálculo no servidor) NÃO é configuração: é regra fixa e não entra aqui.
 */

export type Tipo = 'bool' | 'texto' | 'texto_longo' | 'numero' | 'dinheiro' | 'percentual' | 'cor' | 'telefone' | 'url' | 'escolha' | 'imagem';
export type Quem = 'DONO' | 'ONEUP';
type Coluna = { tabela: 'restaurante' | 'delivery'; campo: string };
export type Def = {
  chave: string; secao: string; rotulo: string; ajuda: string; tipo: Tipo; padrao: unknown;
  quem: Quem; min?: number; max?: number; maxLen?: number; minLen?: number; opcional?: boolean;
  opcoes?: { valor: string; rotulo: string }[];
  coluna?: Coluna;      // configurações antigas que já moram numa coluna (compatibilidade)
  requer?: string;      // só pode ser ligada se esta outra (bool) estiver ligada
  publico?: boolean;    // pode aparecer para o cliente no cardápio digital (sem login)
};

export const SECOES = [
  { id: 'identidade', titulo: 'Identidade', descricao: 'Como o seu restaurante aparece para a equipe e para o cliente.' },
  { id: 'cardapio_digital', titulo: 'Cardápio digital', descricao: 'Pedido pelo link ou QR Code, confirmado pelo caixa antes de ir para a cozinha.' },
  { id: 'pedido', titulo: 'Pedido no caixa', descricao: 'O que o caixa precisa preencher para abrir uma conta.' },
  { id: 'caixa', titulo: 'Caixa e controle', descricao: 'Limites que protegem o seu dinheiro no dia a dia.' },
  { id: 'cozinha', titulo: 'Cozinha', descricao: 'Como a tela da cozinha avisa sobre pedidos atrasados.' },
  { id: 'delivery', titulo: 'Delivery', descricao: 'Entrega pronta no sistema; ligue quando quiser usar.' },
  { id: 'financeiro', titulo: 'Financeiro', descricao: 'Indicadores de acompanhamento.' },
  { id: 'plano', titulo: 'Seu plano ONE UP Comanda', descricao: 'Recursos liberados pelo seu plano. Para mudar, fale com a ONE UP.' },
];

export const CATALOGO: Def[] = [
  // Identidade
  { chave: 'nome', secao: 'identidade', rotulo: 'Nome do restaurante', ajuda: 'Aparece no login, nas telas e no cardápio digital.', tipo: 'texto', padrao: 'Meu restaurante', minLen: 2, maxLen: 60, quem: 'DONO', coluna: { tabela: 'restaurante', campo: 'name' }, publico: true },
  { chave: 'subtitulo', secao: 'identidade', rotulo: 'Subtítulo', ajuda: 'Uma linha curta abaixo do nome (ex.: "Espetinhos e porções").', tipo: 'texto', padrao: '', maxLen: 60, quem: 'DONO', coluna: { tabela: 'restaurante', campo: 'tagline' }, publico: true },
  { chave: 'logo', secao: 'identidade', rotulo: 'Logotipo', ajuda: 'Imagem quadrada ou horizontal (PNG ou JPG, até 2 MB). Sem logotipo, aparece o nome.', tipo: 'imagem', padrao: null, opcional: true, quem: 'DONO', publico: true },
  { chave: 'cor_destaque', secao: 'identidade', rotulo: 'Cor de destaque', ajuda: 'Cor dos botões principais, links e destaques.', tipo: 'cor', padrao: '#FCB132', quem: 'DONO', publico: true },
  { chave: 'tema', secao: 'identidade', rotulo: 'Tema das telas', ajuda: 'Escuro descansa a vista à noite e no salão com pouca luz; claro fica melhor de dia e em ambiente iluminado; automático segue o aparelho de cada pessoa.', tipo: 'escolha', opcoes: [{ valor: 'escuro', rotulo: 'Escuro' }, { valor: 'claro', rotulo: 'Claro' }, { valor: 'auto', rotulo: 'Automático' }], padrao: 'escuro', quem: 'DONO', publico: true },
  { chave: 'whatsapp', secao: 'identidade', rotulo: 'WhatsApp do restaurante', ajuda: 'Com DDD. Vira o botão "Falar no WhatsApp" do cardápio digital.', tipo: 'telefone', padrao: null, opcional: true, quem: 'DONO', coluna: { tabela: 'restaurante', campo: 'whatsappNumber' }, publico: true },
  { chave: 'link_site', secao: 'identidade', rotulo: 'Site', ajuda: 'Endereço do site, se tiver.', tipo: 'url', padrao: null, opcional: true, quem: 'DONO', publico: true },
  { chave: 'link_grupo', secao: 'identidade', rotulo: 'Grupo ou comunidade', ajuda: 'Link do grupo de WhatsApp ou do Instagram para o cliente acompanhar novidades.', tipo: 'url', padrao: null, opcional: true, quem: 'DONO', publico: true },

  // Cardápio digital
  { chave: 'cardapio_digital_ligado', secao: 'cardapio_digital', rotulo: 'Cardápio digital ligado', ajuda: 'Quando ligado, o cliente vê o cardápio pelo link e envia pedidos para o caixa confirmar. Segue o ABERTO/FECHADO do caixa.', tipo: 'bool', padrao: false, quem: 'DONO', coluna: { tabela: 'restaurante', campo: 'qrEnabled' }, requer: 'modulo_cardapio_digital' },
  { chave: 'boas_vindas', secao: 'cardapio_digital', rotulo: 'Mensagem de boas-vindas', ajuda: 'Aparece no topo do cardápio digital.', tipo: 'texto_longo', padrao: '', maxLen: 200, quem: 'DONO', publico: true },
  { chave: 'texto_fechado', secao: 'cardapio_digital', rotulo: 'Mensagem quando estiver fechado', ajuda: 'O que o cliente lê quando o caixa está fechado.', tipo: 'texto_longo', padrao: 'No momento não estamos recebendo pedidos. Assim que abrirmos, o cardápio aparece aqui automaticamente.', minLen: 5, maxLen: 200, quem: 'DONO', publico: true },
  { chave: 'esconder_sem_estoque', secao: 'cardapio_digital', rotulo: 'Produto sem estoque aparece como "Acabou"', ajuda: 'Ligado: o cliente não consegue pedir o que acabou. Desligado: o caixa decide na confirmação. No caixa, a falta de estoque nunca trava a venda.', tipo: 'bool', padrao: true, quem: 'DONO' },

  // Pedido no caixa
  { chave: 'rotulo_mesa', secao: 'pedido', rotulo: 'Nome do campo "Mesa"', ajuda: 'Use o termo do seu salão: Mesa, Quiosque, Comanda, Casa…', tipo: 'texto', padrao: 'Mesa', minLen: 2, maxLen: 20, quem: 'DONO' },
  { chave: 'exigir_nome', secao: 'pedido', rotulo: 'Exigir nome do cliente', ajuda: 'O caixa só abre a conta com o nome preenchido.', tipo: 'bool', padrao: false, quem: 'DONO' },
  { chave: 'exigir_telefone', secao: 'pedido', rotulo: 'Exigir telefone do cliente', ajuda: 'O caixa só abre a conta com telefone.', tipo: 'bool', padrao: false, quem: 'DONO' },
  { chave: 'exigir_mesa', secao: 'pedido', rotulo: 'Exigir mesa', ajuda: 'O caixa só abre a conta informando a mesa (ou o nome que você deu ao campo).', tipo: 'bool', padrao: false, quem: 'DONO' },

  // Caixa e controle
  { chave: 'abertura_sugerida', secao: 'caixa', rotulo: 'Troco sugerido para abrir o caixa', ajuda: 'Valor que já vem preenchido em "Abrir o dia". O caixa pode mudar.', tipo: 'dinheiro', padrao: 0, min: 0, max: 10_000_000, quem: 'DONO' },
  { chave: 'desconto_max_caixa', secao: 'caixa', rotulo: 'Desconto máximo que o caixa dá sozinho (%)', ajuda: 'Acima disso, só o Dono. Vazio = sem limite.', tipo: 'percentual', padrao: null, opcional: true, min: 0, max: 100, quem: 'DONO' },
  { chave: 'cancelar_pronto_so_dono', secao: 'caixa', rotulo: 'Cancelar item já pronto: só o Dono', ajuda: 'Comida que já saiu da cozinha é perda. Ligado, o caixa não cancela sozinho.', tipo: 'bool', padrao: false, quem: 'DONO' },

  // Cozinha
  { chave: 'cozinha_amarelo_pct', secao: 'cozinha', rotulo: 'Pedido fica AMARELO com (% do tempo-meta)', ajuda: 'Ex.: 100% = quando passa do tempo-meta do prato.', tipo: 'numero', padrao: 100, min: 50, max: 300, quem: 'DONO' },
  { chave: 'cozinha_vermelho_pct', secao: 'cozinha', rotulo: 'Pedido fica VERMELHO com (% do tempo-meta)', ajuda: 'Ex.: 150% = metade a mais do que o tempo-meta.', tipo: 'numero', padrao: 150, min: 60, max: 400, quem: 'DONO' },

  // Delivery
  { chave: 'delivery_aberto', secao: 'delivery', rotulo: 'Delivery aberto', ajuda: 'Permite pedidos para entrega no cardápio digital.', tipo: 'bool', padrao: false, quem: 'DONO', coluna: { tabela: 'delivery', campo: 'isOpen' }, requer: 'modulo_delivery' },

  // Financeiro
  { chave: 'mei_ligado', secao: 'financeiro', rotulo: 'Indicador do limite do MEI', ajuda: 'Mostra no painel quanto do limite anual já foi faturado no sistema. Confirme o limite vigente com o contador.', tipo: 'bool', padrao: false, quem: 'DONO', coluna: { tabela: 'restaurante', campo: 'meiEnabled' } },
  { chave: 'mei_limite', secao: 'financeiro', rotulo: 'Limite anual de referência do MEI', ajuda: 'Valor usado no indicador.', tipo: 'dinheiro', padrao: 8_100_000, min: 0, max: 10_000_000_000, quem: 'DONO', coluna: { tabela: 'restaurante', campo: 'meiLimitCents' } },

  // Plano (só a ONE UP muda)
  { chave: 'modulo_cardapio_digital', secao: 'plano', rotulo: 'Cardápio digital incluído no plano', ajuda: 'Liberado pela ONE UP conforme o plano contratado.', tipo: 'bool', padrao: true, quem: 'ONEUP' },
  { chave: 'modulo_delivery', secao: 'plano', rotulo: 'Delivery incluído no plano', ajuda: 'Liberado pela ONE UP conforme o plano contratado.', tipo: 'bool', padrao: true, quem: 'ONEUP' },
];

const POR_CHAVE = new Map(CATALOGO.map((d) => [d.chave, d]));
export const defDe = (chave: string) => POR_CHAVE.get(chave);

/** Validação de um valor contra a definição. Devolve o valor normalizado ou lança 400. */
export function validar(d: Def, valor: unknown): unknown {
  const bad = (m: string): never => { throw new HttpError(400, `${d.rotulo}: ${m}`); };
  if (valor === null || valor === '' || valor === undefined) {
    if (d.opcional) return null;
    if (d.tipo === 'texto' && !d.minLen) return '';
    if (d.tipo === 'texto_longo' && !d.minLen) return '';
    bad('preencha este campo.');
  }
  switch (d.tipo) {
    case 'bool': return typeof valor === 'boolean' ? valor : bad('use ligado ou desligado.');
    case 'texto': case 'texto_longo': {
      if (typeof valor !== 'string') bad('texto inválido.');
      const v = (valor as string).trim().replace(/\s+/g, d.tipo === 'texto' ? ' ' : ' ');
      if (d.minLen && v.length < d.minLen) bad(`mínimo de ${d.minLen} caracteres.`);
      if (d.maxLen && v.length > d.maxLen) bad(`máximo de ${d.maxLen} caracteres.`);
      return v;
    }
    case 'numero': case 'dinheiro': case 'percentual': {
      const n = typeof valor === 'number' ? valor : Number(valor);
      if (!Number.isFinite(n) || !Number.isInteger(n)) bad('número inválido.');
      if (d.min != null && n < d.min) bad(`mínimo ${d.min}.`);
      if (d.max != null && n > d.max) bad(`máximo ${d.max}.`);
      return n;
    }
    case 'cor': return typeof valor === 'string' && /^#[0-9a-fA-F]{6}$/.test(valor) ? valor.toUpperCase() : bad('cor inválida (use #RRGGBB).');
    case 'telefone': {
      const dig = String(valor).replace(/\D/g, '');
      return dig.length >= 10 && dig.length <= 13 ? dig : bad('informe DDD + número.');
    }
    case 'url': {
      const s = String(valor).trim();
      const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
      try { const u = new URL(withProto); if (!u.hostname.includes('.')) throw 0; return u.toString(); } catch { return bad('endereço inválido.'); }
    }
    case 'escolha': return d.opcoes?.some((o) => o.valor === valor) ? valor : bad('opção inválida.');
    case 'imagem': {
      // só imagens da pasta da PRÓPRIA empresa (ou o logotipo legado da instalação nº 1)
      const proprio = new RegExp(`^/uploads/${empresaAtual()}/[\\w-]+\\.(png|jpe?g|webp)$`, 'i');
      return typeof valor === 'string' && (proprio.test(valor) || (valor === '/logo.png' && empresaAtual() === 1)) ? valor : bad('imagem inválida.');
    }
  }
}

const colunasRestaurante = CATALOGO.filter((d) => d.coluna?.tabela === 'restaurante');
const colunasDelivery = CATALOGO.filter((d) => d.coluna?.tabela === 'delivery');

/** Valores efetivos de TODAS as configurações da empresa atual (padrão quando não alterada). */
export async function lerConfiguracoes(tx: Executor = db): Promise<Record<string, unknown>> {
  const [r] = await tx.select().from(restaurantSettings).limit(1);
  const [d] = await tx.select().from(deliverySettings).limit(1);
  const rows = await tx.select().from(empresaConfig);
  const salvo = new Map(rows.map((x) => [x.chave, x.valor]));
  const out: Record<string, unknown> = {};
  for (const def of CATALOGO) {
    if (def.coluna) {
      const src = (def.coluna.tabela === 'restaurante' ? r : d) as Record<string, unknown> | undefined;
      out[def.chave] = src ? (src[def.coluna.campo] ?? def.padrao) : def.padrao;
    } else {
      out[def.chave] = salvo.has(def.chave) ? salvo.get(def.chave) : def.padrao;
    }
  }
  return out;
}

export async function lerConfig<T = unknown>(chave: string, tx: Executor = db): Promise<T> {
  const def = defDe(chave);
  if (!def) throw new Error(`Configuração desconhecida: ${chave}`);
  if (def.coluna) return (await lerConfiguracoes(tx))[chave] as T;
  const [row] = await tx.select().from(empresaConfig).where(eq(empresaConfig.chave, chave));
  return (row ? row.valor : def.padrao) as T;
}

/** Só o que pode aparecer para o cliente (sem login). */
export async function configuracoesPublicas(tx: Executor = db) {
  const all = await lerConfiguracoes(tx);
  return Object.fromEntries(CATALOGO.filter((d) => d.publico).map((d) => [d.chave, all[d.chave]]));
}

export async function travas(tx: Executor = db) {
  const rows = await tx.select().from(configTravas);
  return new Map(rows.map((t) => [t.chave, t.motivo]));
}

/** Tela de Configurações: catálogo + valores + quem pode mudar + cadeados. */
export async function telaConfiguracoes() {
  const valores = await lerConfiguracoes();
  const locks = await travas();
  return {
    secoes: SECOES,
    itens: CATALOGO.map((d) => ({
      chave: d.chave, secao: d.secao, rotulo: d.rotulo, ajuda: d.ajuda, tipo: d.tipo, padrao: d.padrao,
      min: d.min, max: d.max, maxLen: d.maxLen, minLen: d.minLen, opcional: !!d.opcional, opcoes: d.opcoes, requer: d.requer ?? null,
      quem: d.quem, valor: valores[d.chave], ehPadrao: JSON.stringify(valores[d.chave] ?? null) === JSON.stringify(d.padrao ?? null),
      trava: locks.get(d.chave) ?? null,
      editavel: d.quem === 'DONO' && !locks.has(d.chave),
    })),
  };
}

type Origem = 'EMPRESA' | 'PADRAO' | 'ONEUP';

/**
 * Aplica mudanças (todas ou nenhuma). Confere catálogo, quem pode, cadeado e dependência.
 * origem ONEUP = ferramenta da plataforma (ignora "quem" e cadeado); EMPRESA = Dono pela tela.
 */
export async function aplicarConfiguracoes(valores: Record<string, unknown>, user: AuthUser | null, origem: Origem = 'EMPRESA') {
  const entradas = Object.entries(valores);
  if (!entradas.length) throw new HttpError(400, 'Nada para alterar.');
  return db.transaction(async (tx) => {
    const atuais = await lerConfiguracoes(tx);
    const locks = await travas(tx);
    const novos: Record<string, unknown> = {};
    for (const [chave, bruto] of entradas) {
      const def = defDe(chave);
      if (!def) throw new HttpError(400, `Configuração desconhecida: ${chave}.`);
      if (origem !== 'ONEUP') {
        if (def.quem !== 'DONO') throw new HttpError(403, `"${def.rotulo}" é definido pelo seu plano. Fale com a ONE UP.`, 'CONFIG_ONEUP');
        if (locks.has(chave)) throw new HttpError(403, `"${def.rotulo}" está travado pela ONE UP: ${locks.get(chave)}`, 'CONFIG_TRAVADA');
      }
      novos[chave] = origem === 'PADRAO' ? def.padrao : validar(def, bruto);
    }
    const efetivo = { ...atuais, ...novos };
    for (const chave of Object.keys(novos)) {
      const def = defDe(chave)!;
      if (def.requer && efetivo[chave] === true && efetivo[def.requer] !== true) {
        throw new HttpError(403, `"${def.rotulo}" não está incluído no seu plano. Fale com a ONE UP.`, 'CONFIG_PLANO');
      }
    }
    const mudou: string[] = [];
    const restSet: Record<string, unknown> = {};
    const delSet: Record<string, unknown> = {};
    for (const [chave, valor] of Object.entries(novos)) {
      if (JSON.stringify(atuais[chave] ?? null) === JSON.stringify(valor ?? null)) continue;
      const def = defDe(chave)!;
      mudou.push(chave);
      if (def.coluna?.tabela === 'restaurante') restSet[def.coluna.campo] = valor;
      else if (def.coluna?.tabela === 'delivery') delSet[def.coluna.campo] = valor;
      else if (origem === 'PADRAO') await tx.delete(empresaConfig).where(eq(empresaConfig.chave, chave));
      else {
        await tx.insert(empresaConfig).values({ chave, valor: valor as never, updatedBy: user?.id ?? null })
          .onConflictDoUpdate({ target: [empresaConfig.empresaId, empresaConfig.chave], set: { valor: valor as never, updatedAt: new Date(), updatedBy: user?.id ?? null } });
      }
      await tx.insert(configHistorico).values({ chave, antes: (atuais[chave] ?? null) as never, depois: (valor ?? null) as never, origem, userId: user?.id ?? null });
    }
    if (Object.keys(restSet).length) await tx.update(restaurantSettings).set({ ...restSet, updatedAt: new Date() }).where(eq(restaurantSettings.id, empresaAtual()));
    if (Object.keys(delSet).length) await tx.update(deliverySettings).set({ ...delSet, updatedAt: new Date() }).where(eq(deliverySettings.id, empresaAtual()));
    if (mudou.length) {
      const nomes = mudou.map((c) => defDe(c)!.rotulo).join(', ');
      const quem = origem === 'ONEUP' ? 'ONE UP' : user?.name ?? 'Sistema';
      await audit(tx, { userId: user?.id ?? null, action: origem === 'PADRAO' ? 'config.padrao' : 'config.update', entityType: 'settings', message: `${quem} ${origem === 'PADRAO' ? 'voltou ao padrão' : 'alterou'}: ${nomes}.` });
    }
    return { alteradas: mudou };
  });
}

/** Volta ao padrão (por chave ou seção). Respeita cadeado e "quem". */
export async function voltarAoPadrao(chaves: string[], user: AuthUser) {
  const valores = Object.fromEntries(chaves.map((c) => [c, null]));
  for (const c of chaves) {
    const d = defDe(c);
    if (!d) throw new HttpError(400, `Configuração desconhecida: ${c}.`);
  }
  const locks = await travas();
  for (const c of chaves) {
    if (defDe(c)!.quem !== 'DONO') throw new HttpError(403, `"${defDe(c)!.rotulo}" é definido pelo seu plano.`, 'CONFIG_ONEUP');
    if (locks.has(c)) throw new HttpError(403, `"${defDe(c)!.rotulo}" está travado pela ONE UP: ${locks.get(c)}`, 'CONFIG_TRAVADA');
  }
  return aplicarConfiguracoes(valores, user, 'PADRAO');
}

export async function historico(chave?: string) {
  const rows = await db.select({
    id: configHistorico.id, chave: configHistorico.chave, antes: configHistorico.antes, depois: configHistorico.depois,
    origem: configHistorico.origem, criadoEm: configHistorico.createdAt, usuario: users.name,
  }).from(configHistorico).leftJoin(users, eq(users.id, configHistorico.userId))
    .where(chave ? eq(configHistorico.chave, chave) : undefined).orderBy(desc(configHistorico.id)).limit(200);
  return rows.map((r) => ({ ...r, rotulo: defDe(r.chave)?.rotulo ?? r.chave }));
}

export const schemaPatch = z.object({ valores: z.record(z.string(), z.unknown()) });
export const schemaPadrao = z.object({ chaves: z.array(z.string()).min(1).max(100) });
void and; void inArray;
