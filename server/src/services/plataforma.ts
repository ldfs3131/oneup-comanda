import { randomInt } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db, ensureEmpresaBase, runAsEmpresa, runAsSystem } from '../db/index.js';
import { empresas, plataformaHistorico, restaurantSettings, roles, users } from '../db/schema.js';
import { hashPassword } from '../auth.js';
import { audit } from '../lib/audit.js';
import { limparCacheEmpresas, slugValido } from '../lib/empresa.js';
import { bad, brl, conflict, notFound } from '../lib/http.js';
import { DIAS_AVISO, LICENCA_ROTULO, diasParaVencer, hojeLicenca, statusEfetivo, type LicencaStatus } from '../lib/licenca.js';
import { seedCardapioExemplo } from '../seed/cardapio-exemplo.js';
import { seedMenu } from '../seed/menu.js';
import { notify, desconectarEquipe } from '../realtime.js';

/*
 * PLATAFORMA ONE UP — regras compartilhadas entre a linha de comando (setup.js) e a Central de comando (tela).
 * Tudo que lê ou grava `empresas` e o histórico da plataforma roda no pool de SISTEMA (runAsSystem).
 */

export type TipoCardapio = 'exemplo' | 'vazio' | 'piloto';
/** Endereços que não podem virar restaurante (confundem com páginas do sistema/servidor). */
const RESERVADOS = new Set(['www', 'api', 'app', 'admin', 'oneup', 'one-up', 'plataforma', 'painel', 'mail', 'email', 'smtp', 'ftp',
  'static', 'cdn', 'assets', 'suporte', 'ajuda', 'status', 'teste', 'test', 'demo', 'login', 'cardapio', 'comanda']);

export function validarSlugNovo(slug: string): string | null {
  if (!slugValido(slug)) return 'Use de 1 a 40 letras minúsculas, números ou hífen (sem acento, sem espaço; não comece nem termine com hífen).';
  if (RESERVADOS.has(slug)) return `"${slug}" é reservado pelo sistema. Escolha outro endereço.`;
  return null;
}

/** Empresa pelo endereço; se não existir, cria (banco novo: a empresa nº 1 ainda sem ninguém vira esta). */
export async function obterOuCriarEmpresa(slug: string, nome: string | undefined, opts: { exigirNova?: boolean } = {}) {
  return runAsSystem(async () => {
    const [found] = await db.select().from(empresas).where(eq(empresas.slug, slug));
    if (found) {
      if (opts.exigirNova) throw conflict(`O endereço "${slug}" já é de outro restaurante. Escolha outro.`);
      if (nome) await db.update(empresas).set({ nome }).where(eq(empresas.id, found.id));
      return { ...found, nome: nome || found.nome, criada: false };
    }
    const [vazia] = (await db.execute(sql`SELECT e.id FROM empresas e WHERE e.id = 1 AND e.slug = 'empresa-1'
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.empresa_id = 1)`)).rows as { id: number }[];
    if (vazia) {
      const [u] = await db.update(empresas).set({ slug, nome: nome || 'Meu restaurante' }).where(eq(empresas.id, 1)).returning();
      return { ...u, criada: true };
    }
    const [created] = await db.insert(empresas).values({ slug, nome: nome || 'Meu restaurante' }).returning();
    return { ...created, criada: true };
  });
}

/** Cadastra o cardápio inicial na empresa do contexto. Devolve quantos produtos entraram. */
export async function semearCardapioInicial(tipo: TipoCardapio) {
  if (tipo === 'exemplo') return seedCardapioExemplo();
  if (tipo === 'piloto') return seedMenu();
  return 0;
}

const ALFABETO = 'abcdefghjkmnpqrstuvwxyz23456789'; // sem letras e números que se confundem (l, 1, o, 0, i)
export const gerarSenha = (n = 10) => Array.from({ length: n }, () => ALFABETO[randomInt(ALFABETO.length)]).join('');
export const gerarPin = (n = 6) => Array.from({ length: n }, () => String(randomInt(10))).join('');

export const enderecoDe = (slug: string) => (config.baseDomain ? `https://${slug}.${config.baseDomain}` : null);

async function registrarHistorico(empresaId: number, tipo: string, mensagem: string, usuario: string | null, antes?: unknown, depois?: unknown) {
  await runAsSystem(() => db.insert(plataformaHistorico).values({ empresaId, tipo, mensagem, usuario, antes: antes ?? null, depois: depois ?? null }));
}

/** Depois de mexer na licença: o servidor esquece a empresa guardada e as telas do restaurante recarregam. */
async function aplicarMudancaLicenca(empresaId: number, suspendeu: boolean) {
  limparCacheEmpresas();
  await runAsEmpresa(empresaId, async () => { notify.settingsChanged(); });
  if (suspendeu) await desconectarEquipe(empresaId);
}

// ---------------------------------------------------------------------------------------------
// Criar restaurante pela tela
export type NovoRestaurante = {
  nome: string; slug: string; donoNome: string; donoLogin?: string; donoWhatsapp?: string | null;
  cardapio: 'exemplo' | 'vazio'; mensalidadeCents?: number; plano?: string | null; licencaVenceEm?: string | null;
};

export async function criarRestaurante(n: NovoRestaurante, oneup: { nome: string; login: string; passwordHash: string }) {
  const motivo = validarSlugNovo(n.slug);
  if (motivo) throw bad(motivo);
  const donoLogin = n.donoLogin || 'dono';
  if (!/^[a-z0-9._-]{2,30}$/.test(donoLogin)) throw bad('Login do Dono: letras minúsculas, números, ponto ou traço (2 a 30).');
  if (['caixa', 'cozinha', oneup.login].includes(donoLogin)) throw bad(`O login "${donoLogin}" já é usado por outro acesso. Escolha outro.`);
  const emp = await obterOuCriarEmpresa(n.slug, n.nome, { exigirNova: true });
  await runAsSystem(() => db.update(empresas).set({
    donoNome: n.donoNome, donoWhatsapp: n.donoWhatsapp ?? null, mensalidadeCents: n.mensalidadeCents ?? 0,
    plano: n.plano ?? null, licencaVenceEm: n.licencaVenceEm ?? null, licencaStatus: 'ATIVO',
  }).where(eq(empresas.id, emp.id)));
  const senhas = { dono: gerarSenha(10), caixa: gerarPin(6), cozinha: gerarPin(6) };
  const produtos = await runAsEmpresa(emp.id, () => db.transaction(async (tx) => {
    await ensureEmpresaBase();
    await tx.update(restaurantSettings).set({ name: n.nome }).where(eq(restaurantSettings.id, emp.id));
    const roleRows = await tx.select().from(roles);
    const roleId = (c: string) => roleRows.find((r) => r.code === c)!.id;
    const pessoas = [
      { name: n.donoNome, username: donoLogin, pass: senhas.dono, role: 'ADMIN', oneup: false },
      { name: 'Caixa', username: 'caixa', pass: senhas.caixa, role: 'CAIXA', oneup: false },
      { name: 'Cozinha', username: 'cozinha', pass: senhas.cozinha, role: 'COZINHA', oneup: false },
    ];
    for (const p of pessoas) {
      const [u] = await tx.insert(users).values({ name: p.name, username: p.username, passwordHash: await hashPassword(p.pass), roleId: roleId(p.role) }).returning();
      await audit(tx, { userId: u.id, action: 'setup.user', entityType: 'user', entityId: u.id, message: `Instalação criou o usuário ${p.name} (${p.role}).` });
    }
    // o acesso de suporte da ONE UP entra no restaurante novo com a mesma senha de quem criou (invisível ao Dono)
    await tx.insert(users).values({ name: oneup.nome, username: oneup.login, passwordHash: oneup.passwordHash, roleId: roleId('ADMIN'), oneup: true });
    return n.cardapio === 'exemplo' ? seedCardapioExemplo(tx) : 0;
  }));
  await registrarHistorico(emp.id, 'CRIACAO', `Restaurante criado pela Central de comando (cardápio ${n.cardapio === 'exemplo' ? `de exemplo, ${produtos} produtos` : 'vazio'}).`, oneup.nome,
    null, { nome: n.nome, slug: n.slug, plano: n.plano ?? null, mensalidadeCents: n.mensalidadeCents ?? 0, venceEm: n.licencaVenceEm ?? null });
  limparCacheEmpresas();
  return {
    empresa: { id: emp.id, slug: n.slug, nome: n.nome },
    endereco: enderecoDe(n.slug),
    produtos,
    // mostradas UMA vez (o sistema guarda só o hash)
    acessos: {
      dono: { login: donoLogin, senha: senhas.dono },
      caixa: { login: 'caixa', senha: senhas.caixa },
      cozinha: { login: 'cozinha', senha: senhas.cozinha },
      oneup: { login: oneup.login, senha: '(a mesma do seu acesso ONE UP)' },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Carteira e lista de restaurantes
type Linha = {
  id: number; slug: string; nome: string; status: string; created_at: string;
  licenca_status: string; licenca_vence_em: string | null; mensalidade_cents: number; plano: string | null;
  dono_nome: string | null; dono_whatsapp: string | null; cobranca_enviada_em: string | null; observacao: string | null;
  ultimo_pedido: string | null; contas_mes: number; usuarios: number; dia_aberto: boolean;
};

export async function listarRestaurantes() {
  const hoje = hojeLicenca();
  const rows = (await runAsSystem(() => db.execute(sql`
    SELECT e.id, e.slug, e.nome, e.status, e.created_at, e.licenca_status, e.licenca_vence_em::text AS licenca_vence_em,
      e.mensalidade_cents, e.plano, e.dono_nome, e.dono_whatsapp, e.cobranca_enviada_em, e.observacao,
      (SELECT max(o.created_at) FROM orders o WHERE o.empresa_id = e.id) AS ultimo_pedido,
      (SELECT count(*) FROM accounts a WHERE a.empresa_id = e.id
         AND a.opened_at >= (date_trunc('month', ${hoje}::date)::timestamp AT TIME ZONE 'America/Sao_Paulo')) AS contas_mes,
      (SELECT count(*) FROM users u WHERE u.empresa_id = e.id AND u.active AND NOT u.oneup) AS usuarios,
      EXISTS (SELECT 1 FROM cash_registers c WHERE c.empresa_id = e.id AND c.status = 'OPEN') AS dia_aberto
    FROM empresas e WHERE e.status <> 'CANCELADA' ORDER BY e.nome`))).rows as Linha[];
  return rows.map((r) => {
    const l = { licencaStatus: r.licenca_status, licencaVenceEm: r.licenca_vence_em };
    const dias = diasParaVencer(r.licenca_vence_em, hoje);
    const efetivo = statusEfetivo(l, hoje);
    return {
      id: r.id, slug: r.slug, nome: r.nome, criadaEm: r.created_at, endereco: enderecoDe(r.slug),
      licencaStatus: r.licenca_status as LicencaStatus, efetivo, venceEm: r.licenca_vence_em, diasParaVencer: dias,
      vencida: dias !== null && dias < 0, aVencer: efetivo === 'ATIVO' && dias !== null && dias >= 0 && dias <= DIAS_AVISO,
      // vencida e o dia ainda aberto: segue até encerrar; no próximo "abrir o dia" entra em só consulta
      diaAberto: !!r.dia_aberto,
      mensalidadeCents: Number(r.mensalidade_cents), plano: r.plano, donoNome: r.dono_nome, donoWhatsapp: r.dono_whatsapp,
      cobrancaEnviadaEm: r.cobranca_enviada_em, observacao: r.observacao,
      ultimaAtividade: r.ultimo_pedido, contasNoMes: Number(r.contas_mes), usuarios: Number(r.usuarios), versao: config.version,
    };
  });
}
export type Restaurante = Awaited<ReturnType<typeof listarRestaurantes>>[number];

export function carteiraDe(lista: Restaurante[]) {
  const ativos = lista.filter((r) => r.efetivo === 'ATIVO');
  return {
    restaurantes: lista.length,
    mrrCents: ativos.reduce((s, r) => s + r.mensalidadeCents, 0),
    ativos: ativos.length,
    soConsulta: lista.filter((r) => r.efetivo === 'SO_CONSULTA').length,
    suspensos: lista.filter((r) => r.efetivo === 'SUSPENSO').length,
    aVencer: lista.filter((r) => r.aVencer).length,
    // sem pagamento = vencimento já passou (e não está suspenso)
    semPagamento: lista.filter((r) => r.vencida && r.efetivo !== 'SUSPENSO').length,
    hoje: hojeLicenca(),
    diasAviso: DIAS_AVISO,
  };
}

// ---------------------------------------------------------------------------------------------
// Alterar licença / mensalidade / dados do Dono (cada mudança vai para o histórico)
export type MudancaLicenca = {
  licencaStatus?: LicencaStatus; licencaVenceEm?: string | null; mensalidadeCents?: number; plano?: string | null;
  donoNome?: string | null; donoWhatsapp?: string | null; observacao?: string | null; nome?: string;
};

const fmtData = (d: string | null | undefined) => (d ? d.split('-').reverse().join('/') : 'sem vencimento');

export async function empresaPorId(id: number) {
  const [e] = await runAsSystem(() => db.select().from(empresas).where(eq(empresas.id, id)));
  if (!e || e.status === 'CANCELADA') throw notFound('Restaurante não encontrado.');
  return e;
}

export async function alterarRestaurante(id: number, m: MudancaLicenca, usuario: string) {
  const e = await empresaPorId(id);
  const set: Partial<typeof empresas.$inferInsert> = {};
  const hist: { tipo: string; msg: string; antes: unknown; depois: unknown }[] = [];
  const muda = <K extends keyof MudancaLicenca>(k: K, atual: unknown) => m[k] !== undefined && m[k] !== atual;
  if (muda('licencaStatus', e.licencaStatus)) {
    set.licencaStatus = m.licencaStatus!;
    hist.push({ tipo: 'STATUS', msg: `Licença: ${LICENCA_ROTULO[e.licencaStatus as LicencaStatus] ?? e.licencaStatus} → ${LICENCA_ROTULO[m.licencaStatus!]}.`, antes: e.licencaStatus, depois: m.licencaStatus });
  }
  if (muda('licencaVenceEm', e.licencaVenceEm)) {
    set.licencaVenceEm = m.licencaVenceEm ?? null;
    hist.push({ tipo: 'VENCIMENTO', msg: `Vencimento: ${fmtData(e.licencaVenceEm)} → ${fmtData(m.licencaVenceEm)}.`, antes: e.licencaVenceEm, depois: m.licencaVenceEm ?? null });
  }
  if (muda('mensalidadeCents', e.mensalidadeCents)) {
    set.mensalidadeCents = m.mensalidadeCents!;
    hist.push({ tipo: 'MENSALIDADE', msg: `Mensalidade: ${brl(e.mensalidadeCents)} → ${brl(m.mensalidadeCents!)}.`, antes: e.mensalidadeCents, depois: m.mensalidadeCents });
  }
  if (muda('plano', e.plano)) { set.plano = m.plano ?? null; hist.push({ tipo: 'PLANO', msg: `Plano: ${e.plano ?? '—'} → ${m.plano ?? '—'}.`, antes: e.plano, depois: m.plano ?? null }); }
  if (muda('donoNome', e.donoNome)) { set.donoNome = m.donoNome ?? null; hist.push({ tipo: 'DONO', msg: `Nome do Dono: ${e.donoNome ?? '—'} → ${m.donoNome ?? '—'}.`, antes: e.donoNome, depois: m.donoNome ?? null }); }
  if (muda('donoWhatsapp', e.donoWhatsapp)) { set.donoWhatsapp = m.donoWhatsapp ?? null; hist.push({ tipo: 'DONO', msg: `WhatsApp do Dono: ${e.donoWhatsapp ?? '—'} → ${m.donoWhatsapp ?? '—'}.`, antes: e.donoWhatsapp, depois: m.donoWhatsapp ?? null }); }
  if (muda('observacao', e.observacao)) { set.observacao = m.observacao ?? null; hist.push({ tipo: 'OBSERVACAO', msg: 'Observação atualizada.', antes: e.observacao, depois: m.observacao ?? null }); }
  if (muda('nome', e.nome)) { set.nome = m.nome!; hist.push({ tipo: 'NOME', msg: `Nome: ${e.nome} → ${m.nome}.`, antes: e.nome, depois: m.nome }); }
  if (!hist.length) return { alteradas: 0 };
  await runAsSystem(() => db.update(empresas).set(set).where(eq(empresas.id, id)));
  for (const h of hist) await registrarHistorico(id, h.tipo, h.msg, usuario, h.antes, h.depois);
  if (set.licencaStatus) {
    // o Dono vê na Auditoria que a licença mudou (sem valores)
    await runAsEmpresa(id, () => audit(db, { action: 'licenca.status', entityType: 'settings', message: `ONE UP alterou a licença do sistema para "${LICENCA_ROTULO[set.licencaStatus as LicencaStatus]}".` }));
  }
  await aplicarMudancaLicenca(id, set.licencaStatus === 'SUSPENSO');
  return { alteradas: hist.length };
}

// ---------------------------------------------------------------------------------------------
// Cobrança pelo WhatsApp: o sistema PREPARA a mensagem e o link; uma pessoa envia (nunca sozinho)
export function waNumero(digitos: string) { return `55${digitos}`; }
export const linkWhatsapp = (digitos: string, mensagem: string) => `https://wa.me/${waNumero(digitos)}?text=${encodeURIComponent(mensagem)}`;

export function mensagemCobranca(e: typeof empresas.$inferSelect) {
  const primeiro = (e.donoNome ?? '').trim().split(/\s+/)[0];
  const dias = diasParaVencer(e.licencaVenceEm);
  const quando = !e.licencaVenceEm ? ''
    : dias! < 0 ? `venceu em ${fmtData(e.licencaVenceEm)}`
    : dias === 0 ? 'vence hoje'
    : `vence em ${fmtData(e.licencaVenceEm)}`;
  const valor = e.mensalidadeCents > 0 ? ` (${brl(e.mensalidadeCents)})` : '';
  return [
    `Olá${primeiro ? `, ${primeiro}` : ''}! Aqui é da ONE UP.`,
    `A mensalidade do sistema do ${e.nome}${e.plano ? ` — plano ${e.plano}` : ''}${valor}${quando ? ` ${quando}` : ' está em aberto'}.`,
    dias !== null && dias < 0
      ? 'Assim que o pagamento for confirmado, o sistema volta a abrir o dia normalmente.'
      : 'Para o sistema continuar abrindo o dia normalmente, é só fazer o pagamento até a data.',
    'Qualquer dúvida, é só responder esta mensagem. Obrigado!',
  ].join('\n');
}

export async function prepararCobranca(id: number) {
  const e = await empresaPorId(id);
  if (!e.donoWhatsapp) throw bad('Cadastre o WhatsApp do Dono antes de cobrar.');
  const mensagem = mensagemCobranca(e);
  return { whatsapp: e.donoWhatsapp, mensagem, link: linkWhatsapp(e.donoWhatsapp, mensagem), ultimaEnviadaEm: e.cobrancaEnviadaEm };
}

/** Registra que a cobrança foi aberta no WhatsApp (a pessoa envia com um toque) e devolve o link com o texto final. */
export async function registrarCobranca(id: number, mensagem: string, usuario: string) {
  const e = await empresaPorId(id);
  if (!e.donoWhatsapp) throw bad('Cadastre o WhatsApp do Dono antes de cobrar.');
  const agora = new Date();
  await runAsSystem(() => db.update(empresas).set({ cobrancaEnviadaEm: agora }).where(eq(empresas.id, id)));
  await registrarHistorico(id, 'COBRANCA', `Cobrança aberta no WhatsApp para ${e.donoWhatsapp}.`, usuario, null, { mensagem, mensalidadeCents: e.mensalidadeCents, venceEm: e.licencaVenceEm });
  return { link: linkWhatsapp(e.donoWhatsapp, mensagem), enviadaEm: agora.toISOString() };
}

const somaMes = (d: string) => {
  const [y, m, dd] = d.split('-').map(Number);
  const alvo = new Date(Date.UTC(y, m, 1)); // primeiro dia do mês seguinte
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(dd, ultimo));
  return alvo.toISOString().slice(0, 10);
};

/** Pagamento recebido: novo vencimento (padrão: +1 mês) e, se estava em só consulta, volta a Ativo. */
export async function registrarPagamento(id: number, novoVencimento: string | undefined, usuario: string) {
  const e = await empresaPorId(id);
  const hoje = hojeLicenca();
  const base = e.licencaVenceEm && e.licencaVenceEm >= hoje ? e.licencaVenceEm : hoje;
  const vence = novoVencimento ?? somaMes(base);
  if (vence < hoje) throw bad('O novo vencimento não pode ser no passado.');
  const status = e.licencaStatus === 'SO_CONSULTA' ? 'ATIVO' : e.licencaStatus;
  await runAsSystem(() => db.update(empresas).set({ licencaVenceEm: vence, licencaStatus: status, cobrancaEnviadaEm: null }).where(eq(empresas.id, id)));
  await registrarHistorico(id, 'PAGAMENTO', `Pagamento registrado${e.mensalidadeCents ? ` (${brl(e.mensalidadeCents)})` : ''}. Vencimento: ${fmtData(e.licencaVenceEm)} → ${fmtData(vence)}${status !== e.licencaStatus ? '; licença volta a Ativo' : ''}.`,
    usuario, { venceEm: e.licencaVenceEm, status: e.licencaStatus }, { venceEm: vence, status });
  if (status !== e.licencaStatus) {
    await runAsEmpresa(id, () => audit(db, { action: 'licenca.status', entityType: 'settings', message: 'ONE UP alterou a licença do sistema para "Ativo".' }));
  }
  await aplicarMudancaLicenca(id, false);
  return { venceEm: vence, licencaStatus: status };
}

export async function historicoDe(id: number) {
  await empresaPorId(id);
  return runAsSystem(() => db.select().from(plataformaHistorico).where(eq(plataformaHistorico.empresaId, id))
    .orderBy(sql`${plataformaHistorico.createdAt} DESC, ${plataformaHistorico.id} DESC`).limit(100));
}
