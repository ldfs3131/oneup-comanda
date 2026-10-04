/*
 * RECUPERAÇÃO DE VENDAS (CRM de cobrança do fiado) — serviço 100% da ONE UP.
 * ---------------------------------------------------------------------------
 * O Dono vê só a lista comum de "A receber" (Leva 1). Nada daqui sai para Dono, Caixa ou Cozinha.
 *
 * Regras fixas (não são configuração):
 *  - O sistema NUNCA envia mensagem sozinho: prepara o texto e abre o WhatsApp; uma pessoa envia.
 *  - O pagamento cai SEMPRE direto no restaurante.
 *  - Comissão só nasce quando o Caixa/Dono dá a BAIXA na conta a receber (conta paga/encerrada pelo fluxo
 *    normal). Valor recuperado = o que foi pago na conta DEPOIS da entrada na recuperação. Percentual = faixa
 *    de dias de atraso NA ENTRADA (gravado na ficha nesse momento).
 *  - "Não cobrar" é definitivo.
 *  - Guarda-corpos no servidor: horário/dias permitidos e limite de contatos por dia por conta.
 *
 * Datas: "hoje" e a hora usadas pela régua e pelos guarda-corpos vêm de agoraCrm() (fuso America/Sao_Paulo).
 * Fora de produção, CRM_AGORA (data/hora ISO) fixa esse "agora" — só para testes e demonstração.
 * Os carimbos de quando as coisas aconteceram (entrada, baixa) são sempre a hora real do banco.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { mkdirSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { db, empresaAtual, runAsEmpresa, runAsSystem, type Executor } from '../db/index.js';
import { crmConfig, crmEventos, empresas } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { HttpError, bad, brl, conflict, notFound } from '../lib/http.js';
import { tipoReal } from '../lib/imagem.js';
import { config } from '../config.js';
import { lerConfig } from './configuracoes.js';
import { listAccountsWithTotals } from './accounts.js';
import type { AuthUser } from '../auth.js';

const TZ = 'America/Sao_Paulo';

// ---------------------------------------------------------------------------------------------
// Relógio
export function agoraCrm(): Date {
  const v = process.env.CRM_AGORA;
  if (v && process.env.NODE_ENV !== 'production') { const d = new Date(v); if (!Number.isNaN(+d)) return d; }
  return new Date();
}
const SEMANA = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const NOME_DIA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
export function relogio(d = agoraCrm()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { dia: `${g('year')}-${g('month')}-${g('day')}`, hora: Number(g('hour')) % 24, minuto: Number(g('minute')), semana: SEMANA.indexOf(g('weekday')) };
}
export const addDias = (iso: string, n: number) => { const x = new Date(iso + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
/** a − b em dias. */
export const diffDias = (a: string, b: string) => Math.round((Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 86_400_000);
const diaSP = (d: Date | string) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(d));
const fmtDia = (iso: string | null | undefined) => (iso ? iso.split('-').reverse().join('/') : '');
const pctBp = (bp: number) => `${(bp / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;

// ---------------------------------------------------------------------------------------------
// Configuração (contrato) — régua, percentuais e limites. Valores PROVISÓRIOS do Módulo H.
const canalSchema = z.enum(['WHATSAPP', 'LIGACAO']);
const passoSchema = z.object({
  dia: z.number().int().min(0).max(365),
  nome: z.string().trim().min(2).max(60),
  canais: z.array(canalSchema).min(1).max(2),
  texto: z.string().trim().min(10).max(600),
  encerrar: z.boolean().default(false),
});
export const configSchema = z.object({
  entrada_dias: z.number().int().min(0).max(365),
  faixas: z.array(z.object({ dias: z.number().int().min(0).max(3650), bp: z.number().int().min(0).max(5000) })).min(1).max(8),
  horario: z.object({ inicio: z.number().int().min(0).max(23), fim: z.number().int().min(1).max(24), dias: z.array(z.number().int().min(0).max(6)).min(1).max(7) })
    .refine((h) => h.inicio < h.fim, { message: 'o início do horário tem de ser antes do fim' }),
  max_contatos_dia: z.number().int().min(1).max(3),
  sem_resposta: z.object({ intervalo_dias: z.number().int().min(1).max(30), max_tentativas: z.number().int().min(1).max(20) }),
  promessa: z.object({ quebradas_para_ligacao: z.number().int().min(1).max(10) }),
  dias_alerta_baixa: z.number().int().min(1).max(60),
  comissao_sem_contato: z.boolean(),
  chave_pix: z.string().trim().max(120),
  regua: z.array(passoSchema).min(1).max(12)
    .refine((r) => r.every((p, i) => i === 0 || p.dia > r[i - 1].dia), { message: 'os passos da régua precisam estar em ordem de dias, sem repetir' }),
});
export type CrmConfig = z.infer<typeof configSchema>;

export const CONFIG_PADRAO: CrmConfig = {
  entrada_dias: 15,
  faixas: [{ dias: 15, bp: 1000 }, { dias: 30, bp: 1500 }, { dias: 60, bp: 2000 }],
  horario: { inicio: 8, fim: 20, dias: [1, 2, 3, 4, 5, 6] },
  max_contatos_dia: 1,
  sem_resposta: { intervalo_dias: 3, max_tentativas: 4 },
  promessa: { quebradas_para_ligacao: 2 },
  dias_alerta_baixa: 5,
  comissao_sem_contato: false,
  chave_pix: '',
  regua: [
    { dia: 1, nome: 'Lembrete gentil', canais: ['WHATSAPP'], encerrar: false,
      texto: 'Oi, {nome}! Tudo bem? Aqui é do {restaurante}. Passando para lembrar do valor de {valor} que ficou em aberto desde {data}. Se já pagou ou tiver alguma dúvida sobre o valor, é só responder aqui. Obrigado!' },
    { dia: 3, nome: 'Reforço com chave Pix', canais: ['WHATSAPP'], encerrar: false,
      texto: 'Oi, {nome}! Aqui é do {restaurante}. Para facilitar, segue a chave Pix para o valor de {valor} (em aberto desde {data}): {pix}. O pagamento vai direto para a conta do restaurante. Se não reconhecer o valor, responda aqui que a gente confere.' },
    { dia: 7, nome: 'Ligação + WhatsApp', canais: ['LIGACAO', 'WHATSAPP'], encerrar: false,
      texto: 'Oi, {nome}, aqui é do {restaurante}. Tentamos falar com você sobre o valor de {valor}. Podemos combinar uma data que fique boa para você? Chave Pix: {pix}. Se discordar do valor, é só nos avisar por aqui.' },
    { dia: 15, nome: 'Proposta de acordo', canais: ['WHATSAPP'], encerrar: false,
      texto: 'Oi, {nome}! Aqui é do {restaurante}. Queremos resolver o valor de {valor} de um jeito bom para você: dá para combinar uma data ou dividir em partes. O que fica melhor? Chave Pix: {pix}.' },
    { dia: 30, nome: 'Último lembrete (encerrar com relatório)', canais: ['WHATSAPP'], encerrar: true,
      texto: 'Oi, {nome}. Aqui é do {restaurante}. Este é o nosso último lembrete sobre o valor de {valor} em aberto desde {data}. Se quiser resolver, a chave Pix é {pix}. Qualquer dúvida, é só responder.' },
  ],
};

export async function lerCrmConfig(tx: Executor = db): Promise<CrmConfig> {
  const [row] = await tx.select().from(crmConfig).limit(1);
  const r = configSchema.safeParse({ ...CONFIG_PADRAO, ...((row?.config as object) ?? {}) });
  return r.success ? r.data : CONFIG_PADRAO;
}

export async function salvarCrmConfig(valores: unknown, user: AuthUser) {
  const r = configSchema.safeParse(valores);
  if (!r.success) {
    const i = r.error.issues[0];
    throw bad(`Confira ${i?.path.length ? `"${i.path.join(' › ')}"` : 'os campos'}: ${i?.message ?? 'valor inválido'}`);
  }
  const cfg = r.data;
  cfg.faixas = [...cfg.faixas].sort((a, b) => a.dias - b.dias);
  cfg.horario.dias = [...new Set(cfg.horario.dias)].sort();
  await db.transaction(async (tx) => {
    await tx.insert(crmConfig).values({ config: cfg as never }).onConflictDoUpdate({ target: crmConfig.empresaId, set: { config: cfg as never, updatedAt: new Date() } });
    await audit(tx, { userId: user.id, action: 'crm.config', entityType: 'crm', message: `ONE UP (${user.name}) alterou a configuração do serviço de recuperação de vendas (contrato).` });
  });
  return cfg;
}

export const servicoLigado = async (tx: Executor = db) => (await lerConfig<boolean>('servico_recuperacao', tx)) === true;

/** Percentual (pontos-base) pela faixa de dias de atraso na entrada. Abaixo da menor faixa: 0. */
export function percentualDaFaixa(cfg: CrmConfig, diasAtraso: number) {
  let bp = 0;
  for (const f of [...cfg.faixas].sort((a, b) => a.dias - b.dias)) if (diasAtraso >= f.dias) bp = f.bp;
  return bp;
}

// ---------------------------------------------------------------------------------------------
// Status
export const STATUS = ['NOVO', 'CONTATADO', 'SEM_RESPOSTA', 'PROMETEU', 'PAGO_AGUARDANDO_BAIXA', 'RECUPERADO', 'PAGO_SEM_CONTATO', 'CONTESTADO', 'NUMERO_ERRADO', 'PAUSADO', 'PERDIDO', 'NAO_COBRAR'] as const;
export type Status = typeof STATUS[number];
export const STATUS_PT: Record<Status, string> = {
  NOVO: 'Novo', CONTATADO: 'Contatado', SEM_RESPOSTA: 'Sem resposta', PROMETEU: 'Prometeu pagar', PAGO_AGUARDANDO_BAIXA: 'Pago — aguardando baixa',
  RECUPERADO: 'Recuperado', PAGO_SEM_CONTATO: 'Pago sem contato', CONTESTADO: 'Contestado', NUMERO_ERRADO: 'Número errado', PAUSADO: 'Pausado',
  PERDIDO: 'Perdido', NAO_COBRAR: 'Não cobrar',
};
/** Em que se pode registrar contato e resultado. */
const ATIVOS: Status[] = ['NOVO', 'CONTATADO', 'SEM_RESPOSTA', 'PROMETEU'];
const RETOMAVEIS: Status[] = ['PAUSADO', 'CONTESTADO', 'NUMERO_ERRADO', 'PERDIDO', 'PAGO_AGUARDANDO_BAIXA'];
const PAUSA_PT: Record<string, string> = { SEM_RESPOSTA: 'sem resposta no limite de tentativas', CONTA_REABERTA: 'conta reaberta pelo restaurante' };
export const RESULTADOS = ['SEM_RESPOSTA', 'VAI_PAGAR', 'PAGOU', 'PARCELAR', 'CONTESTOU', 'NUMERO_ERRADO', 'NAO_VAI_PAGAR'] as const;
export type Resultado = typeof RESULTADOS[number];
export const RESULTADO_PT: Record<Resultado, string> = {
  SEM_RESPOSTA: 'Sem resposta', VAI_PAGAR: 'Vai pagar', PAGOU: 'Pagou', PARCELAR: 'Pediu parcelar', CONTESTOU: 'Contestou',
  NUMERO_ERRADO: 'Número errado', NAO_VAI_PAGAR: 'Não vai pagar',
};
const CANAL_PT: Record<string, string> = { WHATSAPP: 'WhatsApp', LIGACAO: 'Ligação', PESSOAL: 'Pessoalmente' };

// ---------------------------------------------------------------------------------------------
// Leitura das fichas (com o MÍNIMO do devedor: nome, contato, valor, vencimento, origem)
type Linha = {
  id: number; accountId: number; status: Status; entradaEm: string; entradaDia: string; venc: string;
  valorEntradaCents: number; diasAtrasoEntrada: number; percentualBp: number; proximoContato: string | null;
  prometidoPara: string | null; tentativas: number; promessasQuebradas: number; recuperadoCents: number; comissaoCents: number;
  recuperadoEm: string | null; encerradoEm: string | null; naoCobrarMotivo: string | null; ultimoContatoEm: string | null;
  ultimoContatoDia: string | null; contatosNoDia: number; semRespostaSeguidas: number; pagoInformadoDia: string | null;
  pausadoMotivo: string | null; contatoErrado: string | null;
  numero: number; nome: string; contato: string | null; telefone: string | null; origem: string; contaStatus: string; saldoCents: number;
};

async function carregar(tx: Executor, where = sql`TRUE`): Promise<Linha[]> {
  const r = await tx.execute(sql`
    SELECT c.id, c.account_id, c.status, c.entrada_em, c.valor_entrada_cents, c.dias_atraso_entrada, c.percentual_bp,
           to_char(COALESCE(c.entrada_dia, (c.entrada_em AT TIME ZONE ${TZ})::date), 'YYYY-MM-DD') AS entrada_dia,
           to_char(c.proximo_contato, 'YYYY-MM-DD') AS proximo, to_char(c.prometido_para, 'YYYY-MM-DD') AS prometido,
           to_char(c.ultimo_contato_dia, 'YYYY-MM-DD') AS ultimo_dia, to_char(c.pago_informado_dia, 'YYYY-MM-DD') AS pago_dia,
           c.tentativas, c.promessas_quebradas, c.recuperado_cents, c.comissao_cents, c.recuperado_em, c.encerrado_em,
           c.nao_cobrar_motivo, c.ultimo_contato_em, c.contatos_no_dia, c.sem_resposta_seguidas, c.pausado_motivo, c.contato_errado,
           a.number, a.customer_name, a.contact, a.phone, a.origin, a.status AS conta_status,
           to_char(COALESCE(a.promised_date, (COALESCE(a.pending_at, c.pendente_desde) AT TIME ZONE ${TZ})::date), 'YYYY-MM-DD') AS venc,
           (t.subtotal - t.discounts - t.paid) AS saldo
    FROM crm_cobrancas c
    JOIN accounts a ON a.id = c.account_id
    CROSS JOIN LATERAL (
      SELECT
        COALESCE((SELECT SUM(oi.unit_price_cents * oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                  WHERE o.account_id = a.id AND oi.status = 'ACTIVE' AND o.status <> 'AWAITING_CONFIRMATION'), 0) AS subtotal,
        COALESCE((SELECT SUM(amount_cents) FROM discounts d WHERE d.account_id = a.id), 0) AS discounts,
        COALESCE((SELECT SUM(amount_cents) FROM payments p WHERE p.account_id = a.id AND p.reversed_at IS NULL), 0) AS paid
    ) t
    WHERE ${where}
    ORDER BY c.id`);
  return (r.rows as any[]).map((x) => ({
    id: x.id, accountId: x.account_id, status: x.status, entradaEm: x.entrada_em, entradaDia: x.entrada_dia, venc: x.venc,
    valorEntradaCents: Number(x.valor_entrada_cents), diasAtrasoEntrada: Number(x.dias_atraso_entrada), percentualBp: Number(x.percentual_bp),
    proximoContato: x.proximo, prometidoPara: x.prometido, tentativas: Number(x.tentativas), promessasQuebradas: Number(x.promessas_quebradas),
    recuperadoCents: Number(x.recuperado_cents), comissaoCents: Number(x.comissao_cents), recuperadoEm: x.recuperado_em, encerradoEm: x.encerrado_em,
    naoCobrarMotivo: x.nao_cobrar_motivo, ultimoContatoEm: x.ultimo_contato_em, ultimoContatoDia: x.ultimo_dia, contatosNoDia: Number(x.contatos_no_dia),
    semRespostaSeguidas: Number(x.sem_resposta_seguidas), pagoInformadoDia: x.pago_dia, pausadoMotivo: x.pausado_motivo, contatoErrado: x.contato_errado,
    numero: x.number, nome: x.customer_name ?? 'Sem nome', contato: x.contact, telefone: x.phone, origem: x.origin, contaStatus: x.conta_status,
    saldoCents: Math.max(0, Number(x.saldo)),
  }));
}

/** WhatsApp do devedor: telefone da conta ou número escrito no contato (mesma regra do botão Cobrar). */
export function whatsappDe(telefone: string | null, contato: string | null) {
  let d = (telefone || contato || '').replace(/\D/g, '');
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  return d.length === 10 || d.length === 11 ? '55' + d : null;
}
const contatoAtual = (l: { telefone: string | null; contato: string | null }) => [l.telefone, l.contato].filter(Boolean).join(' · ');

// ---------------------------------------------------------------------------------------------
// Régua
function passoAtual(cfg: CrmConfig, l: Pick<Linha, 'entradaDia'>, hoje: string) {
  const d = diffDias(hoje, l.entradaDia);
  let i = 0;
  cfg.regua.forEach((p, k) => { if (p.dia <= d) i = k; });
  return { indice: i, passo: cfg.regua[i], diasDesdeEntrada: d };
}
/** Data do PRÓXIMO passo da régua (depois do passo usado hoje e depois de hoje) ou null se a régua acabou. */
function proximoPelaRegua(cfg: CrmConfig, l: Pick<Linha, 'entradaDia'>, hoje: string) {
  const { indice } = passoAtual(cfg, l, hoje);
  for (let k = indice + 1; k < cfg.regua.length; k++) {
    const d = addDias(l.entradaDia, cfg.regua[k].dia);
    if (d > hoje) return d;
  }
  return null;
}
const reguaAcabou = (cfg: CrmConfig, l: Pick<Linha, 'entradaDia'>, hoje: string) =>
  diffDias(hoje, l.entradaDia) > cfg.regua[cfg.regua.length - 1].dia;
function canalSugerido(cfg: CrmConfig, l: Pick<Linha, 'promessasQuebradas' | 'entradaDia'>, hoje: string): { canais: ('WHATSAPP' | 'LIGACAO')[]; porque: string } {
  if (l.promessasQuebradas >= cfg.promessa.quebradas_para_ligacao) return { canais: ['LIGACAO'], porque: `promessa quebrada ${l.promessasQuebradas}× — ligar` };
  const { passo } = passoAtual(cfg, l, hoje);
  return { canais: passo.canais, porque: `régua: ${passo.nome}` };
}

export function preencher(texto: string, v: { nome: string; valor: number; restaurante: string; venc: string; pix: string }) {
  return texto
    .replace(/\{nome\}/g, (v.nome || '').trim().split(/\s+/)[0] || '')
    .replace(/\{valor\}/g, brl(v.valor).replace(' ', ' '))
    .replace(/\{restaurante\}/g, v.restaurante)
    .replace(/\{data\}/g, fmtDia(v.venc))
    .replace(/\{pix\}/g, v.pix || '[chave Pix do restaurante]');
}

// ---------------------------------------------------------------------------------------------
// Eventos (linha do tempo imutável) e auditoria (neutra: registra o ACESSO da ONE UP, sem status de cobrança)
type Ev = { tipo: 'CONTATO' | 'RESULTADO' | 'NOTA' | 'SISTEMA'; canal?: string | null; resultado?: Resultado | null; dataPrometida?: string | null; nota?: string | null; userId?: number | null };
async function evento(tx: Executor, cobrancaId: number, e: Ev) {
  await tx.insert(crmEventos).values({
    cobrancaId, tipo: e.tipo, canal: e.canal ?? null, resultado: e.resultado ?? null, dataPrometida: e.dataPrometida ?? null,
    nota: e.nota ?? null, userId: e.userId ?? null,
  });
}
async function auditar(tx: Executor, user: AuthUser | null, l: Pick<Linha, 'accountId' | 'numero' | 'nome'>, acao: string, oQue: string) {
  await audit(tx, {
    userId: user?.id ?? null, action: `crm.${acao}`, entityType: 'account', entityId: l.accountId,
    message: `${user ? `ONE UP (${user.name})` : 'Serviço de recuperação'} ${oQue} — conta a receber #${l.numero} (${l.nome}); acesso delegado pelo contrato.`,
  });
}

async function atualizar(tx: Executor, id: number, set: Record<string, unknown>) {
  const cols = Object.entries(set).map(([k, v]) => sql`${sql.identifier(k)} = ${v}`);
  await tx.execute(sql`UPDATE crm_cobrancas SET ${sql.join(cols, sql`, `)}, updated_at = now() WHERE id = ${id}`);
}

async function pagoDepoisDaEntrada(tx: Executor, accountId: number, entradaEm: string) {
  const r = await tx.execute(sql`SELECT COALESCE(SUM(amount_cents), 0) AS v FROM payments
    WHERE account_id = ${accountId} AND reversed_at IS NULL AND created_at >= ${entradaEm}`);
  return Number((r.rows[0] as { v: number }).v);
}

// ---------------------------------------------------------------------------------------------
// SINCRONIZAÇÃO: cria fichas para as contas elegíveis, fecha as já pagas e aplica os lembretes do dia
const ultimaSync = new Map<number, number>();
export type ResumoSync = { entraram: number; recuperadas: number; encerradas: number; quebradas: number; retomadas: number; pausadas: number };

export async function sincronizar(opts: { forcar?: boolean } = {}): Promise<ResumoSync | null> {
  const emp = empresaAtual();
  if (!opts.forcar && Date.now() - (ultimaSync.get(emp) ?? 0) < 15_000) return null;
  ultimaSync.set(emp, Date.now());
  if (!(await servicoLigado())) return null;
  const cfg = await lerCrmConfig();
  const { dia: hoje } = relogio();
  return db.transaction(async (tx) => {
    // uma sincronização por empresa por vez (tela aberta + intervalo do servidor)
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('crm-sync'), ${emp})`);
    const out: ResumoSync = { entraram: 0, recuperadas: 0, encerradas: 0, quebradas: 0, retomadas: 0, pausadas: 0 };

    // 1) Entrada: PENDENTE vencida há N dias pela data combinada ou, sem data, pelo dia em que ficou pendente
    const candidatas = await listAccountsWithTotals(tx, sql`a.status = 'PENDING'
      AND NOT EXISTS (SELECT 1 FROM crm_cobrancas c WHERE c.account_id = a.id)
      AND COALESCE(a.promised_date, (COALESCE(a.pending_at, a.opened_at) AT TIME ZONE ${TZ})::date) <= (${hoje}::date - ${cfg.entrada_dias}::int)`, 5000);
    for (const a of candidatas) {
      if (a.balance <= 0) continue;
      const desde = a.pendingAt ?? a.openedAt;
      const venc = a.promisedDate ?? diaSP(desde);
      const dias = Math.max(0, diffDias(hoje, venc));
      const bp = percentualDaFaixa(cfg, dias);
      const [nova] = (await tx.execute(sql`INSERT INTO crm_cobrancas
        (account_id, status, pendente_desde, valor_entrada_cents, dias_atraso_entrada, percentual_bp, proximo_contato, entrada_dia)
        VALUES (${a.id}, 'NOVO', ${desde}, ${a.balance}, ${dias}, ${bp}, ${hoje}::date, ${hoje}::date)
        ON CONFLICT (empresa_id, account_id) DO NOTHING RETURNING id`)).rows as { id: number }[];
      if (!nova) continue;
      out.entraram++;
      await evento(tx, nova.id, { tipo: 'SISTEMA', nota: `Entrou na recuperação com ${dias} dia(s) de atraso (vencimento ${fmtDia(venc)}) e saldo de ${brl(a.balance)}. Comissão pela faixa: ${pctBp(bp)}.` });
      await auditar(tx, null, { accountId: a.id, numero: a.number, nome: a.customerName ?? 'Sem nome' }, 'entrada', 'passou a acompanhar a cobrança');
    }

    // 2) Fichas em andamento (e perdidas que ainda podem ser pagas): baixa, cancelamento, reabertura, lembretes
    const fichas = await carregar(tx, sql`(c.encerrado_em IS NULL OR (c.status = 'PERDIDO' AND c.recuperado_em IS NULL))`);
    for (const f of fichas) {
      const pagaOuEncerrada = f.contaStatus === 'PAID' || f.contaStatus === 'CLOSED';
      if (pagaOuEncerrada) {
        const pago = await pagoDepoisDaEntrada(tx, f.accountId, f.entradaEm);
        if (f.status === 'PERDIDO' && pago <= 0) continue; // perdida e quitada sem pagamento: nada muda
        if (f.status === 'NAO_COBRAR') {
          await atualizar(tx, f.id, { encerrado_em: new Date(), proximo_contato: null, recuperado_cents: pago });
          await evento(tx, f.id, { tipo: 'SISTEMA', nota: `Conta quitada pelo restaurante (${brl(pago)} recebidos). Ficha "não cobrar": sem comissão.` });
          out.encerradas++;
          continue;
        }
        if (pago <= 0) {
          await atualizar(tx, f.id, { status: 'PERDIDO', encerrado_em: new Date(), proximo_contato: null });
          await evento(tx, f.id, { tipo: 'SISTEMA', nota: 'Conta quitada pelo restaurante sem pagamento depois da entrada (desconto/perdão). Encerrada sem comissão.' });
          await auditar(tx, null, f, 'saida', 'deixou de acompanhar a cobrança (conta quitada pelo restaurante)');
          out.encerradas++;
          continue;
        }
        const semContato = f.tentativas === 0 && f.status === 'NOVO';
        const comComissao = !semContato || cfg.comissao_sem_contato;
        const comissao = comComissao ? Math.round((pago * f.percentualBp) / 10_000) : 0;
        await atualizar(tx, f.id, {
          status: semContato ? 'PAGO_SEM_CONTATO' : 'RECUPERADO', recuperado_cents: pago, comissao_cents: comissao,
          recuperado_em: new Date(), encerrado_em: new Date(), proximo_contato: null,
        });
        await evento(tx, f.id, {
          tipo: 'SISTEMA',
          nota: semContato
            ? `Baixa feita pelo restaurante (${brl(pago)}) antes de qualquer contato: pago sem contato${comissao ? `, comissão ${pctBp(f.percentualBp)} = ${brl(comissao)} (contrato)` : ', sem comissão'}.`
            : `Baixa feita pelo restaurante: ${brl(pago)} recebidos depois da entrada. Comissão ${pctBp(f.percentualBp)} (faixa de ${f.diasAtrasoEntrada} dias de atraso na entrada) = ${brl(comissao)}.`,
        });
        await auditar(tx, null, f, 'saida', 'deixou de acompanhar a cobrança (baixa feita pelo restaurante)');
        out.recuperadas++;
        continue;
      }
      if (f.status === 'PERDIDO' || f.status === 'NAO_COBRAR') continue;
      if (f.contaStatus === 'CANCELLED' || f.contaStatus === 'MERGED') {
        await atualizar(tx, f.id, { status: 'PERDIDO', encerrado_em: new Date(), proximo_contato: null });
        await evento(tx, f.id, { tipo: 'SISTEMA', nota: `A conta foi ${f.contaStatus === 'CANCELLED' ? 'cancelada' : 'juntada a outra'} pelo restaurante. Saiu da recuperação.` });
        await auditar(tx, null, f, 'saida', 'deixou de acompanhar a cobrança (conta cancelada/juntada)');
        out.encerradas++;
        continue;
      }
      if (f.contaStatus !== 'PENDING') {
        // reaberta (voltou a ser conta viva): pausa até voltar a ser "a receber"
        if (f.status !== 'PAUSADO' || f.pausadoMotivo !== 'CONTA_REABERTA') {
          await atualizar(tx, f.id, { status: 'PAUSADO', pausado_motivo: 'CONTA_REABERTA', proximo_contato: null });
          await evento(tx, f.id, { tipo: 'SISTEMA', nota: 'A conta foi reaberta pelo restaurante. Ficha pausada até voltar para "A receber".' });
          out.pausadas++;
        }
        continue;
      }
      // conta continua a receber
      if (f.status === 'PAUSADO' && f.pausadoMotivo === 'CONTA_REABERTA') {
        await atualizar(tx, f.id, { status: f.tentativas ? 'CONTATADO' : 'NOVO', pausado_motivo: null, proximo_contato: hoje });
        await evento(tx, f.id, { tipo: 'SISTEMA', nota: 'A conta voltou para "A receber". Ficha retomada.' });
        out.retomadas++;
        continue;
      }
      if (f.status === 'NUMERO_ERRADO' && f.contatoErrado != null && contatoAtual(f) !== f.contatoErrado) {
        await atualizar(tx, f.id, { status: f.tentativas ? 'CONTATADO' : 'NOVO', contato_errado: null, proximo_contato: hoje });
        await evento(tx, f.id, { tipo: 'SISTEMA', nota: `O restaurante corrigiu o contato (${contatoAtual(f) || 'vazio'}). Ficha retomada.` });
        out.retomadas++;
        continue;
      }
      // prometeu: lembra no dia e no seguinte; depois disso, promessa quebrada
      if (f.status === 'PROMETEU' && f.prometidoPara && diffDias(hoje, f.prometidoPara) > 1) {
        const n = f.promessasQuebradas + 1;
        await atualizar(tx, f.id, { status: 'CONTATADO', promessas_quebradas: n, prometido_para: null, proximo_contato: hoje });
        await evento(tx, f.id, {
          tipo: 'SISTEMA',
          nota: `Promessa de pagar em ${fmtDia(f.prometidoPara)} não cumprida (${n}ª vez).${n >= cfg.promessa.quebradas_para_ligacao ? ' Próximo contato: ligação.' : ''}`,
        });
        out.quebradas++;
      }
    }
    return out;
  });
}

/** Intervalo leve no servidor: sincroniza cada empresa com o serviço ligado (a cada 15 min). */
export function iniciarSincronizacaoCrm(intervaloMs = 15 * 60_000) {
  const rodar = async () => {
    try {
      const lista = await runAsSystem(() => db.select({ id: empresas.id, status: empresas.status }).from(empresas));
      for (const e of lista.filter((x) => x.status !== 'CANCELADA')) {
        await runAsEmpresa(e.id, () => sincronizar({ forcar: true })).catch((err) => console.warn(`  Recuperação de vendas (empresa ${e.id}): ${(err as Error).message}`));
      }
    } catch (err) { console.warn('  Recuperação de vendas: ' + (err as Error).message); }
  };
  setTimeout(rodar, 20_000).unref();
  setInterval(rodar, intervaloMs).unref();
}

// ---------------------------------------------------------------------------------------------
// Guarda-corpos
export function guardaContato(cfg: CrmConfig, f: Pick<Linha, 'ultimoContatoDia' | 'contatosNoDia'>, rel = relogio()): string | null {
  const dias = cfg.horario.dias.map((d) => NOME_DIA[d]).join(', ');
  if (!cfg.horario.dias.includes(rel.semana)) return `Hoje é ${NOME_DIA[rel.semana]}: não é dia de contato. Contatos só em ${dias}, das ${cfg.horario.inicio}h às ${cfg.horario.fim}h.`;
  const min = rel.hora * 60 + rel.minuto;
  if (min < cfg.horario.inicio * 60 || min >= cfg.horario.fim * 60) {
    return `Fora do horário permitido: contatos só das ${cfg.horario.inicio}h às ${cfg.horario.fim}h (agora são ${String(rel.hora).padStart(2, '0')}:${String(rel.minuto).padStart(2, '0')}).`;
  }
  if (f.ultimoContatoDia === rel.dia && f.contatosNoDia >= cfg.max_contatos_dia) {
    return `Esta conta já foi contatada hoje. O limite é ${cfg.max_contatos_dia} contato por dia por conta — tente amanhã.`;
  }
  return null;
}
const motivoBloqueio = (s: Status): string => ({
  NAO_COBRAR: 'Esta conta foi marcada "Não cobrar": bloqueada para sempre.',
  RECUPERADO: 'Esta ficha já foi recuperada e encerrada.',
  PAGO_SEM_CONTATO: 'Esta conta já foi paga e encerrada.',
  PAGO_AGUARDANDO_BAIXA: 'O cliente informou que pagou: aguardando a baixa do restaurante. Se não pagou, use "Retomar".',
  CONTESTADO: 'O cliente contestou: ficha pausada. Combine com o restaurante e use "Retomar" se for o caso.',
  NUMERO_ERRADO: 'Número errado: peça ao restaurante para corrigir o contato da conta (a ficha volta sozinha) ou use "Retomar".',
  PAUSADO: 'Ficha pausada. Use "Retomar" para voltar a cobrar.',
  PERDIDO: 'Ficha encerrada como perdida. Use "Retomar" se o cliente voltar a negociar.',
} as Record<string, string>)[s] ?? 'Ação não permitida nesta ficha.';

async function fichaParaAcao(tx: Executor, id: number) {
  await tx.execute(sql`SELECT id FROM crm_cobrancas WHERE id = ${id} FOR UPDATE`);
  const [f] = await carregar(tx, sql`c.id = ${id}`);
  if (!f) throw notFound('Ficha não encontrada.');
  return f;
}

// ---------------------------------------------------------------------------------------------
// AÇÕES
export async function registrarContato(id: number, b: { canal: 'WHATSAPP' | 'LIGACAO' | 'PESSOAL'; nota?: string | null }, user: AuthUser) {
  const cfg = await lerCrmConfig();
  const rel = relogio();
  const hoje = rel.dia;
  return db.transaction(async (tx) => {
    const f = await fichaParaAcao(tx, id);
    if (!ATIVOS.includes(f.status)) throw new HttpError(409, motivoBloqueio(f.status), 'CRM_BLOQUEADA');
    if (f.contaStatus !== 'PENDING') throw new HttpError(409, 'A conta não está mais "a receber". Atualize a tela.', 'CRM_CONTA');
    const guarda = guardaContato(cfg, f, rel);
    if (guarda) throw new HttpError(409, guarda, 'CRM_GUARDA');
    if (b.canal === 'WHATSAPP' && !whatsappDe(f.telefone, f.contato)) throw bad('Esta conta não tem WhatsApp válido. Registre uma ligação ou marque "Número errado".');
    const set: Record<string, unknown> = {
      tentativas: f.tentativas + 1, ultimo_contato_em: new Date(), ultimo_contato_dia: hoje,
      contatos_no_dia: f.ultimoContatoDia === hoje ? f.contatosNoDia + 1 : 1,
    };
    if (f.status === 'PROMETEU' && f.prometidoPara) {
      // lembrete da promessa: no dia → lembra de novo amanhã; no dia seguinte → a sincronização decide (quebrada ou paga)
      set.proximo_contato = hoje >= f.prometidoPara ? (diffDias(hoje, f.prometidoPara) === 0 ? addDias(f.prometidoPara, 1) : null) : f.prometidoPara;
    } else {
      // sem resposta: nova tentativa a cada N dias; senão, o próximo passo da régua
      set.status = f.status === 'SEM_RESPOSTA' ? 'SEM_RESPOSTA' : 'CONTATADO';
      set.proximo_contato = f.status === 'SEM_RESPOSTA' ? addDias(hoje, cfg.sem_resposta.intervalo_dias) : proximoPelaRegua(cfg, f, hoje);
    }
    await atualizar(tx, f.id, set);
    const { passo } = passoAtual(cfg, f, hoje);
    await evento(tx, f.id, { tipo: 'CONTATO', canal: b.canal, nota: b.nota?.trim() || `Passo da régua: ${passo.nome}`, userId: user.id });
    await auditar(tx, user, f, 'contato', `registrou contato (${CANAL_PT[b.canal]}) com o cliente`);
    return { ok: true, whatsapp: whatsappDe(f.telefone, f.contato) };
  });
}

export async function registrarResultado(id: number, b: { resultado: Resultado; data?: string | null; nota?: string | null }, user: AuthUser) {
  const cfg = await lerCrmConfig();
  const hoje = relogio().dia;
  const nota = b.nota?.trim() || null;
  return db.transaction(async (tx) => {
    const f = await fichaParaAcao(tx, id);
    if (!ATIVOS.includes(f.status)) throw new HttpError(409, motivoBloqueio(f.status), 'CRM_BLOQUEADA');
    const set: Record<string, unknown> = {};
    if (b.resultado !== 'SEM_RESPOSTA') set.sem_resposta_seguidas = 0;
    let texto = '';
    switch (b.resultado) {
      case 'SEM_RESPOSTA': {
        if (f.ultimoContatoDia !== hoje) throw new HttpError(409, 'Registre o contato de hoje antes (Abrir no WhatsApp ou Registrar ligação).', 'CRM_SEM_CONTATO');
        const ja = await tx.execute(sql`SELECT 1 FROM crm_eventos WHERE cobranca_id = ${f.id} AND tipo = 'RESULTADO' AND resultado = 'SEM_RESPOSTA' AND created_at >= ${f.ultimoContatoEm}`);
        if (ja.rows.length) throw new HttpError(409, 'O "Sem resposta" deste contato já foi registrado.', 'CRM_REPETIDO');
        const n = f.semRespostaSeguidas + 1;
        set.sem_resposta_seguidas = n;
        if (n >= cfg.sem_resposta.max_tentativas) {
          Object.assign(set, { status: 'PAUSADO', pausado_motivo: 'SEM_RESPOSTA', proximo_contato: null });
          texto = `Sem resposta (${n}/${cfg.sem_resposta.max_tentativas}): limite atingido, ficha pausada.`;
        } else {
          Object.assign(set, { status: 'SEM_RESPOSTA', proximo_contato: addDias(hoje, cfg.sem_resposta.intervalo_dias) });
          texto = `Sem resposta (${n}/${cfg.sem_resposta.max_tentativas}). Nova tentativa em ${fmtDia(addDias(hoje, cfg.sem_resposta.intervalo_dias))}.`;
        }
        break;
      }
      case 'VAI_PAGAR': {
        if (!b.data) throw bad('Informe a data em que o cliente vai pagar.');
        if (b.data < hoje) throw bad('A data prometida não pode ser no passado.');
        if (diffDias(b.data, hoje) > 90) throw bad('Data muito distante (máximo 90 dias).');
        Object.assign(set, { status: 'PROMETEU', prometido_para: b.data, proximo_contato: b.data });
        texto = `Prometeu pagar em ${fmtDia(b.data)}. Lembrete no dia e no dia seguinte.`;
        break;
      }
      case 'PAGOU':
        Object.assign(set, { status: 'PAGO_AGUARDANDO_BAIXA', pago_informado_dia: hoje, proximo_contato: null });
        texto = `Cliente informou que pagou (direto ao restaurante). Aguardando a baixa no "A receber"; sem baixa em ${cfg.dias_alerta_baixa} dias, combinar com o Dono.`;
        break;
      case 'PARCELAR':
        if (!nota || nota.length < 3) throw bad('Descreva a proposta de parcelamento (ex.: 2× de R$ 50, dias 10 e 25). Combine com o Dono.');
        if (b.data && b.data < hoje) throw bad('A data da primeira parcela não pode ser no passado.');
        if (b.data) Object.assign(set, { status: 'PROMETEU', prometido_para: b.data, proximo_contato: b.data });
        else Object.assign(set, { status: 'CONTATADO', proximo_contato: addDias(hoje, 2) });
        texto = `Pediu parcelar${b.data ? ` (1ª parcela em ${fmtDia(b.data)})` : ''}. Confirmar com o Dono antes de aceitar.`;
        break;
      case 'CONTESTOU':
        if (!nota || nota.length < 3) throw bad('Anote o que o cliente contestou.');
        Object.assign(set, { status: 'CONTESTADO', proximo_contato: null });
        texto = 'Cliente contestou o valor: ficha pausada. Conferir com o restaurante.';
        break;
      case 'NUMERO_ERRADO':
        Object.assign(set, { status: 'NUMERO_ERRADO', contato_errado: contatoAtual(f), proximo_contato: null });
        texto = 'Número errado: pedir ao restaurante a correção do contato. Quando corrigirem, a ficha volta sozinha.';
        break;
      case 'NAO_VAI_PAGAR':
        Object.assign(set, { status: 'PERDIDO', encerrado_em: new Date(), proximo_contato: null });
        texto = 'Cliente disse que não vai pagar. Ficha encerrada como perdida (se a baixa acontecer depois, conta como recuperada).';
        break;
    }
    await atualizar(tx, f.id, set);
    await evento(tx, f.id, { tipo: 'RESULTADO', resultado: b.resultado, dataPrometida: b.data ?? null, nota: nota ? `${texto} Nota: ${nota}` : texto, userId: user.id });
    await auditar(tx, user, f, 'resultado', 'registrou o retorno do cliente');
    return { ok: true, status: (set.status as Status | undefined) ?? f.status };
  });
}

export async function naoCobrar(id: number, motivo: string, user: AuthUser) {
  return db.transaction(async (tx) => {
    const f = await fichaParaAcao(tx, id);
    if (f.status === 'NAO_COBRAR') throw conflict('Esta conta já está marcada "Não cobrar".');
    if (f.status === 'RECUPERADO' || f.status === 'PAGO_SEM_CONTATO') throw conflict('Ficha já encerrada com pagamento.');
    await atualizar(tx, f.id, { status: 'NAO_COBRAR', nao_cobrar_motivo: motivo, proximo_contato: null, encerrado_em: new Date() });
    await evento(tx, f.id, { tipo: 'SISTEMA', nota: `Marcada "Não cobrar" (definitivo). Motivo: ${motivo}`, userId: user.id });
    await auditar(tx, user, f, 'nao_cobrar', 'marcou para não ser contatada pelo serviço');
    return { ok: true };
  });
}

export async function retomar(id: number, nota: string | null, user: AuthUser) {
  const hoje = relogio().dia;
  return db.transaction(async (tx) => {
    const f = await fichaParaAcao(tx, id);
    if (!RETOMAVEIS.includes(f.status)) throw new HttpError(409, f.status === 'NAO_COBRAR' ? motivoBloqueio('NAO_COBRAR') : 'Esta ficha não está pausada nem encerrada.', 'CRM_BLOQUEADA');
    if (f.contaStatus !== 'PENDING') throw conflict('A conta não está "a receber" no restaurante: não dá para retomar.');
    await atualizar(tx, f.id, {
      status: f.tentativas ? 'CONTATADO' : 'NOVO', proximo_contato: hoje, sem_resposta_seguidas: 0, pausado_motivo: null,
      encerrado_em: null, contato_errado: null, prometido_para: null, pago_informado_dia: null,
    });
    await evento(tx, f.id, { tipo: 'SISTEMA', nota: `Ficha retomada (estava ${STATUS_PT[f.status]}).${nota ? ` Nota: ${nota}` : ''}`, userId: user.id });
    await auditar(tx, user, f, 'retomar', 'retomou o acompanhamento');
    return { ok: true };
  });
}

export async function encerrarPerdido(id: number, motivo: string, user: AuthUser) {
  return db.transaction(async (tx) => {
    const f = await fichaParaAcao(tx, id);
    if (![...ATIVOS, 'PAUSADO', 'CONTESTADO', 'NUMERO_ERRADO', 'PAGO_AGUARDANDO_BAIXA'].includes(f.status)) throw new HttpError(409, motivoBloqueio(f.status), 'CRM_BLOQUEADA');
    await atualizar(tx, f.id, { status: 'PERDIDO', encerrado_em: new Date(), proximo_contato: null });
    await evento(tx, f.id, { tipo: 'SISTEMA', nota: `Encerrada como perdida. Motivo: ${motivo}`, userId: user.id });
    await auditar(tx, user, f, 'encerrar', 'encerrou o acompanhamento');
    return { ok: true };
  });
}

export async function anotar(id: number, nota: string, user: AuthUser) {
  return db.transaction(async (tx) => {
    const f = await fichaParaAcao(tx, id);
    await evento(tx, f.id, { tipo: 'NOTA', nota, userId: user.id });
    await auditar(tx, user, f, 'nota', 'anotou na ficha');
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------------------------
// Comprovante (foto/PDF). Fora da pasta pública /uploads: só a ONE UP baixa, pela rota protegida.
export const pastaPrivada = () => process.env.CRM_PRIVADO_DIR ?? join(dirname(config.uploadsDir), 'privado-crm');
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf' };
export const mimeComprovante = (t: string) => MIME[t] ?? 'application/octet-stream';

export async function anexarComprovante(id: number, buf: Buffer, user: AuthUser) {
  const tipo = tipoReal(buf) ?? (buf.length > 5 && buf.toString('ascii', 0, 5) === '%PDF-' ? 'pdf' : null);
  if (!tipo) throw bad('Envie uma foto (PNG, JPG, WEBP) ou um PDF.');
  const emp = empresaAtual();
  const pasta = join(pastaPrivada(), String(emp));
  mkdirSync(pasta, { recursive: true });
  const nome = `comprovante-${id}-${randomBytes(8).toString('hex')}.${tipo}`;
  return db.transaction(async (tx) => {
    const f = await fichaParaAcao(tx, id);
    if (f.status === 'NAO_COBRAR') throw new HttpError(409, motivoBloqueio('NAO_COBRAR'), 'CRM_BLOQUEADA');
    await writeFile(join(pasta, nome), buf);
    const [c] = (await tx.execute(sql`INSERT INTO crm_comprovantes (cobranca_id, arquivo, tipo, tamanho, user_id)
      VALUES (${f.id}, ${nome}, ${tipo}, ${buf.length}, ${user.id}) RETURNING id`)).rows as { id: number }[];
    await evento(tx, f.id, { tipo: 'NOTA', nota: `Comprovante anexado (${tipo.toUpperCase()}, ${Math.max(1, Math.round(buf.length / 1024))} KB).`, userId: user.id });
    await auditar(tx, user, f, 'comprovante', 'anexou um comprovante de pagamento');
    return { id: c.id };
  });
}

export async function comprovante(id: number) {
  const r = await db.execute(sql`SELECT id, cobranca_id, arquivo, tipo, apagado_em FROM crm_comprovantes WHERE id = ${id}`);
  const c = r.rows[0] as { id: number; cobranca_id: number; arquivo: string; tipo: string; apagado_em: string | null } | undefined;
  if (!c || c.apagado_em) throw notFound('Comprovante não encontrado (ou já apagado).');
  return { caminho: join(pastaPrivada(), String(empresaAtual()), c.arquivo), tipo: c.tipo, cobrancaId: c.cobranca_id };
}

export async function apagarComprovante(id: number, user: AuthUser) {
  const c = await comprovante(id);
  await db.transaction(async (tx) => {
    await tx.execute(sql`UPDATE crm_comprovantes SET apagado_em = now(), apagado_por = ${user.id} WHERE id = ${id}`);
    const [f] = await carregar(tx, sql`c.id = ${c.cobrancaId}`);
    await evento(tx, c.cobrancaId, { tipo: 'NOTA', nota: 'Comprovante apagado (dado bancário removido do sistema).', userId: user.id });
    if (f) await auditar(tx, user, f, 'comprovante_apagado', 'apagou um comprovante de pagamento');
  });
  await unlink(c.caminho).catch(() => undefined);
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// TELAS: fila Hoje, funil, lista de fichas, ficha
const restauranteNome = async () => String((await lerConfig<string>('nome')) ?? '');

export async function filaHoje() {
  const cfg = await lerCrmConfig();
  const rel = relogio();
  const hoje = rel.dia;
  const fichas = await carregar(db, sql`c.encerrado_em IS NULL`);
  const contatar: any[] = [];
  const aguardandoBaixa: any[] = [];
  const corrigirContato: any[] = [];
  const encerrar: any[] = [];
  const contestadas: any[] = [];
  const pausadas: any[] = [];
  for (const f of fichas) {
    const base = {
      id: f.id, nome: f.nome, numero: f.numero, contato: contatoAtual(f), whatsapp: whatsappDe(f.telefone, f.contato),
      saldoCents: f.saldoCents, status: f.status, statusPt: STATUS_PT[f.status], venc: f.venc, diasAtraso: Math.max(0, diffDias(hoje, f.venc)),
    };
    if (f.status === 'PAGO_AGUARDANDO_BAIXA') {
      const dias = f.pagoInformadoDia ? diffDias(hoje, f.pagoInformadoDia) : 0;
      aguardandoBaixa.push({ ...base, diasSemBaixa: dias, alerta: dias >= cfg.dias_alerta_baixa });
      continue;
    }
    if (f.status === 'NUMERO_ERRADO') { corrigirContato.push(base); continue; }
    if (f.status === 'CONTESTADO') { contestadas.push(base); continue; }
    if (f.status === 'PAUSADO') { pausadas.push({ ...base, motivo: PAUSA_PT[f.pausadoMotivo ?? ''] ?? 'pausada' }); continue; }
    if (!ATIVOS.includes(f.status)) continue;
    if (!f.proximoContato && reguaAcabou(cfg, f, hoje)) { encerrar.push({ ...base, diasNaRegua: diffDias(hoje, f.entradaDia) }); continue; }
    if (!f.proximoContato || f.proximoContato > hoje) continue;
    const contatadoHoje = f.ultimoContatoDia === hoje && f.contatosNoDia >= cfg.max_contatos_dia;
    const { passo } = passoAtual(cfg, f, hoje);
    const canal = canalSugerido(cfg, f, hoje);
    let motivo = `Régua: ${passo.nome}`;
    if (f.status === 'NOVO') motivo = `Primeiro contato (${passo.nome})`;
    else if (f.status === 'PROMETEU' && f.prometidoPara) motivo = f.prometidoPara === hoje ? 'Prometeu pagar hoje — lembrar' : diffDias(hoje, f.prometidoPara) === 1 ? 'Prometeu para ontem — lembrar de novo' : `Prometeu para ${fmtDia(f.prometidoPara)}`;
    else if (f.status === 'SEM_RESPOSTA') motivo = `Sem resposta — nova tentativa (${f.semRespostaSeguidas + 1}/${cfg.sem_resposta.max_tentativas})`;
    if (f.promessasQuebradas >= cfg.promessa.quebradas_para_ligacao) motivo += ` · promessa quebrada ${f.promessasQuebradas}×`;
    contatar.push({ ...base, motivo, passo: passo.nome, canais: canal.canais, canalPorque: canal.porque, proximoContato: f.proximoContato, atrasadaDias: diffDias(hoje, f.proximoContato), contatadoHoje, tentativas: f.tentativas });
  }
  contatar.sort((a, b) => Number(a.contatadoHoje) - Number(b.contatadoHoje) || b.atrasadaDias - a.atrasadaDias || b.saldoCents - a.saldoCents);
  return {
    hoje, hora: `${String(rel.hora).padStart(2, '0')}:${String(rel.minuto).padStart(2, '0')}`,
    podeContatar: guardaContato(cfg, { ultimoContatoDia: null, contatosNoDia: 0 }, rel),
    contatar, aguardandoBaixa, corrigirContato, encerrar, contestadas, pausadas,
    resumo: { aContatar: contatar.filter((c) => !c.contatadoHoje).length, atrasadas: contatar.filter((c) => c.atrasadaDias > 0 && !c.contatadoHoje).length, alertasBaixa: aguardandoBaixa.filter((a) => a.alerta).length },
  };
}

const ORDEM_FUNIL: Status[] = ['NOVO', 'CONTATADO', 'SEM_RESPOSTA', 'PROMETEU', 'PAGO_AGUARDANDO_BAIXA', 'RECUPERADO', 'PAGO_SEM_CONTATO', 'CONTESTADO', 'NUMERO_ERRADO', 'PAUSADO', 'PERDIDO', 'NAO_COBRAR'];
export async function funil() {
  const r = await db.execute(sql`SELECT status, COUNT(*)::int AS n, COALESCE(SUM(valor_entrada_cents), 0) AS entrada,
      COALESCE(SUM(recuperado_cents), 0) AS recuperado, COALESCE(SUM(comissao_cents), 0) AS comissao
    FROM crm_cobrancas GROUP BY status`);
  const por = new Map((r.rows as any[]).map((x) => [x.status, x]));
  const etapas = ORDEM_FUNIL.map((s) => {
    const x = por.get(s);
    return { status: s, label: STATUS_PT[s], n: Number(x?.n ?? 0), valorEntradaCents: Number(x?.entrada ?? 0), recuperadoCents: Number(x?.recuperado ?? 0), comissaoCents: Number(x?.comissao ?? 0) };
  });
  const emAberto = etapas.filter((e) => ['NOVO', 'CONTATADO', 'SEM_RESPOSTA', 'PROMETEU', 'PAGO_AGUARDANDO_BAIXA', 'CONTESTADO', 'NUMERO_ERRADO', 'PAUSADO'].includes(e.status));
  return {
    etapas,
    totais: {
      fichas: etapas.reduce((s, e) => s + e.n, 0),
      emAbertoN: emAberto.reduce((s, e) => s + e.n, 0), emAbertoCents: emAberto.reduce((s, e) => s + e.valorEntradaCents, 0),
      recuperadoCents: etapas.find((e) => e.status === 'RECUPERADO')!.recuperadoCents,
      comissaoCents: etapas.reduce((s, e) => s + e.comissaoCents, 0),
    },
  };
}

export async function listarFichas(f: { status?: string; busca?: string }) {
  const hoje = relogio().dia;
  const conds = [sql`TRUE`];
  const lista = (f.status ?? '').split(',').filter((s) => (STATUS as readonly string[]).includes(s));
  if (lista.length) conds.push(sql`c.status IN (${sql.join(lista.map((s) => sql`${s}`), sql`, `)})`);
  if (f.busca) conds.push(sql`(unaccent_lower(coalesce(a.customer_name,'')) LIKE unaccent_lower(${'%' + f.busca + '%'}) OR a.number::text = ${f.busca})`);
  const rows = await carregar(db, sql.join(conds, sql` AND `));
  return rows.reverse().slice(0, 500).map((x) => ({
    id: x.id, nome: x.nome, numero: x.numero, status: x.status, statusPt: STATUS_PT[x.status], saldoCents: x.saldoCents,
    valorEntradaCents: x.valorEntradaCents, diasAtraso: Math.max(0, diffDias(hoje, x.venc)), venc: x.venc, percentualBp: x.percentualBp,
    proximoContato: x.proximoContato, tentativas: x.tentativas, recuperadoCents: x.recuperadoCents, comissaoCents: x.comissaoCents,
  }));
}

export async function ficha(id: number) {
  const cfg = await lerCrmConfig();
  const rel = relogio();
  const hoje = rel.dia;
  const [f] = await carregar(db, sql`c.id = ${id}`);
  if (!f) throw notFound('Ficha não encontrada.');
  const ev = await db.execute(sql`SELECT e.id, e.tipo, e.canal, e.resultado, to_char(e.data_prometida, 'YYYY-MM-DD') AS "dataPrometida", e.nota,
      e.created_at AS "criadoEm", u.name AS quem
    FROM crm_eventos e LEFT JOIN users u ON u.id = e.user_id WHERE e.cobranca_id = ${id} ORDER BY e.id DESC`);
  const comp = await db.execute(sql`SELECT c.id, c.tipo, c.tamanho, c.created_at AS "criadoEm", c.apagado_em AS "apagadoEm", u.name AS quem
    FROM crm_comprovantes c LEFT JOIN users u ON u.id = c.user_id WHERE c.cobranca_id = ${id} ORDER BY c.id DESC`);
  const { passo, diasDesdeEntrada } = passoAtual(cfg, f, hoje);
  const canal = canalSugerido(cfg, f, hoje);
  const ativo = ATIVOS.includes(f.status);
  const restaurante = await restauranteNome();
  return {
    id: f.id, status: f.status, statusPt: STATUS_PT[f.status],
    devedor: { nome: f.nome, contato: contatoAtual(f), whatsapp: whatsappDe(f.telefone, f.contato), conta: f.numero, origem: f.origem, vencimento: f.venc },
    saldoCents: f.saldoCents, valorEntradaCents: f.valorEntradaCents, diasAtraso: Math.max(0, diffDias(hoje, f.venc)),
    diasAtrasoEntrada: f.diasAtrasoEntrada, percentualBp: f.percentualBp, entradaEm: f.entradaEm, diasNaRecuperacao: diasDesdeEntrada,
    proximoContato: f.proximoContato, prometidoPara: f.prometidoPara, tentativas: f.tentativas, semRespostaSeguidas: f.semRespostaSeguidas,
    promessasQuebradas: f.promessasQuebradas, recuperadoCents: f.recuperadoCents, comissaoCents: f.comissaoCents, recuperadoEm: f.recuperadoEm,
    encerradoEm: f.encerradoEm, naoCobrarMotivo: f.naoCobrarMotivo, pausadoMotivo: f.pausadoMotivo ? PAUSA_PT[f.pausadoMotivo] ?? f.pausadoMotivo : null,
    passo: { nome: passo.nome, canais: canal.canais, porque: canal.porque },
    mensagem: preencher(passo.texto, { nome: f.nome, valor: f.saldoCents, restaurante, venc: f.venc, pix: cfg.chave_pix }),
    contatadoHoje: f.ultimoContatoDia === hoje && f.contatosNoDia >= cfg.max_contatos_dia,
    bloqueioContato: !ativo ? motivoBloqueio(f.status) : f.contaStatus !== 'PENDING' ? 'A conta não está mais "a receber".' : guardaContato(cfg, f, rel),
    acoes: {
      contato: ativo && f.contaStatus === 'PENDING', resultado: ativo, retomar: RETOMAVEIS.includes(f.status) && f.contaStatus === 'PENDING',
      naoCobrar: !['NAO_COBRAR', 'RECUPERADO', 'PAGO_SEM_CONTATO'].includes(f.status),
      encerrar: [...ATIVOS, 'PAUSADO', 'CONTESTADO', 'NUMERO_ERRADO', 'PAGO_AGUARDANDO_BAIXA'].includes(f.status),
    },
    linhaDoTempo: (ev.rows as any[]).map((e) => ({ ...e, canalPt: e.canal ? CANAL_PT[e.canal] : null, resultadoPt: e.resultado ? RESULTADO_PT[e.resultado as Resultado] : null })),
    comprovantes: comp.rows,
  };
}

// ---------------------------------------------------------------------------------------------
// RELATÓRIO MENSAL por restaurante
export async function relatorio(mes: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) throw bad('Mês inválido (use AAAA-MM).');
  const ini = sql`(${mes + '-01'}::date::timestamp AT TIME ZONE ${TZ})`;
  const fim = sql`((${mes + '-01'}::date + interval '1 month')::timestamp AT TIME ZONE ${TZ})`;
  const noMes = (col: string) => sql`${sql.raw(col)} >= ${ini} AND ${sql.raw(col)} < ${fim}`;
  const [t] = (await db.execute(sql`SELECT
      COUNT(*) FILTER (WHERE ${noMes('entrada_em')})::int AS entraram_n,
      COALESCE(SUM(valor_entrada_cents) FILTER (WHERE ${noMes('entrada_em')}), 0) AS entraram_cents,
      COUNT(*) FILTER (WHERE status = 'RECUPERADO' AND ${noMes('recuperado_em')})::int AS recup_n,
      COALESCE(SUM(recuperado_cents) FILTER (WHERE status = 'RECUPERADO' AND ${noMes('recuperado_em')}), 0) AS recup_cents,
      COALESCE(SUM(valor_entrada_cents) FILTER (WHERE status = 'RECUPERADO' AND ${noMes('recuperado_em')}), 0) AS recup_entrada_cents,
      COALESCE(SUM(comissao_cents) FILTER (WHERE ${noMes('recuperado_em')}), 0) AS comissao_cents,
      AVG(EXTRACT(EPOCH FROM (recuperado_em - entrada_em)) / 86400) FILTER (WHERE status = 'RECUPERADO' AND ${noMes('recuperado_em')}) AS tempo_medio,
      COUNT(*) FILTER (WHERE status = 'PERDIDO' AND ${noMes('encerrado_em')})::int AS perd_n,
      COALESCE(SUM(valor_entrada_cents) FILTER (WHERE status = 'PERDIDO' AND ${noMes('encerrado_em')}), 0) AS perd_cents,
      COUNT(*) FILTER (WHERE status = 'PAGO_SEM_CONTATO' AND ${noMes('encerrado_em')})::int AS psc_n,
      COALESCE(SUM(recuperado_cents) FILTER (WHERE status = 'PAGO_SEM_CONTATO' AND ${noMes('encerrado_em')}), 0) AS psc_cents,
      COUNT(*) FILTER (WHERE entrada_em < ${fim} AND (encerrado_em IS NULL OR encerrado_em >= ${fim}) AND status <> 'NAO_COBRAR')::int AS neg_n,
      COALESCE(SUM(valor_entrada_cents) FILTER (WHERE entrada_em < ${fim} AND (encerrado_em IS NULL OR encerrado_em >= ${fim}) AND status <> 'NAO_COBRAR'), 0) AS neg_cents,
      COUNT(*) FILTER (WHERE status = 'PAGO_AGUARDANDO_BAIXA')::int AS aguard_n
    FROM crm_cobrancas`)).rows as any[];
  const n = (k: string) => Number(t[k] ?? 0);
  const recuperado = n('recup_cents'), comissao = n('comissao_cents');
  const baseTaxa = n('recup_entrada_cents') + n('perd_cents');
  const lista = await db.execute(sql`SELECT c.id, a.number, a.customer_name AS nome, c.status, c.dias_atraso_entrada AS dias, c.percentual_bp AS bp,
      c.valor_entrada_cents AS entrada, c.recuperado_cents AS recuperado, c.comissao_cents AS comissao,
      ROUND(EXTRACT(EPOCH FROM (COALESCE(c.recuperado_em, c.encerrado_em) - c.entrada_em)) / 86400)::int AS dias_ate
    FROM crm_cobrancas c JOIN accounts a ON a.id = c.account_id
    WHERE (c.status = 'RECUPERADO' AND ${noMes('c.recuperado_em')}) OR (c.status = 'PERDIDO' AND ${noMes('c.encerrado_em')})
    ORDER BY c.status, c.recuperado_cents DESC, c.id`);
  const faixas = await db.execute(sql`SELECT percentual_bp AS bp, COUNT(*)::int AS n, COALESCE(SUM(recuperado_cents), 0) AS recuperado, COALESCE(SUM(comissao_cents), 0) AS comissao
    FROM crm_cobrancas WHERE status = 'RECUPERADO' AND ${noMes('recuperado_em')} GROUP BY percentual_bp ORDER BY percentual_bp`);
  const meses = await db.execute(sql`SELECT DISTINCT to_char(entrada_em AT TIME ZONE ${TZ}, 'YYYY-MM') AS m FROM crm_cobrancas ORDER BY 1 DESC`);
  return {
    mes, restaurante: await restauranteNome(), geradoEm: new Date().toISOString(),
    entraram: { n: n('entraram_n'), cents: n('entraram_cents') },
    recuperado: { n: n('recup_n'), cents: recuperado },
    emNegociacao: { n: n('neg_n'), cents: n('neg_cents'), aguardandoBaixa: n('aguard_n') },
    perdido: { n: n('perd_n'), cents: n('perd_cents') },
    pagoSemContato: { n: n('psc_n'), cents: n('psc_cents') },
    taxaRecuperacao: baseTaxa > 0 ? recuperado / baseTaxa : null,
    taxaPremissa: 'Valor recuperado no mês ÷ valor de entrada das fichas encerradas no mês (recuperadas + perdidas). Pagas sem contato e "não cobrar" ficam fora.',
    tempoMedioDias: t.tempo_medio == null ? null : Math.round(Number(t.tempo_medio) * 10) / 10,
    comissaoCents: comissao, liquidoRestauranteCents: recuperado - comissao,
    porFaixa: (faixas.rows as any[]).map((x) => ({ bp: Number(x.bp), n: Number(x.n), recuperadoCents: Number(x.recuperado), comissaoCents: Number(x.comissao) })),
    fichas: (lista.rows as any[]).map((x) => ({
      id: x.id, conta: x.number, nome: String(x.nome ?? '').trim().split(/\s+/)[0] || 'Cliente', status: x.status, statusPt: STATUS_PT[x.status as Status],
      diasAtrasoEntrada: Number(x.dias), percentualBp: Number(x.bp), entradaCents: Number(x.entrada), recuperadoCents: Number(x.recuperado),
      comissaoCents: Number(x.comissao), diasAteEncerrar: x.dias_ate == null ? null : Number(x.dias_ate),
    })),
    mesesDisponiveis: [...new Set([relogio().dia.slice(0, 7), ...(meses.rows as any[]).map((x) => x.m as string)])].sort().reverse(),
  };
}

// ---------------------------------------------------------------------------------------------
// INSIGHTS de recuperação (por regra; amostra mínima; frase + número + amostra + confiança + ação)
type Insight = { id: string; frase: string; numero: string; amostra: string; confianca: 'baixa' | 'média' | 'alta'; acao: string; impacto?: string | null };
const confianca = (n: number): Insight['confianca'] => (n >= 30 ? 'alta' : n >= 10 ? 'média' : 'baixa');
const pct = (x: number) => `${Math.round(x * 100)}%`;

export async function insights() {
  const cfg = await lerCrmConfig();
  const hoje = relogio().dia;
  const out: Insight[] = [];
  const semAmostra: string[] = [];
  const todas = await carregar(db);

  // 1) Taxa de recuperação por faixa de atraso na entrada (fichas encerradas: recuperadas × perdidas)
  const bordas = [...cfg.faixas].sort((a, b) => a.dias - b.dias).map((f) => f.dias);
  const faixaDe = (d: number) => { let k = -1; bordas.forEach((b, i) => { if (d >= b) k = i; }); return k; };
  const rotuloFaixa = (k: number) => (k < 0 ? `menos de ${bordas[0]} dias` : k === bordas.length - 1 ? `${bordas[k]}+ dias` : `${bordas[k]}–${bordas[k + 1] - 1} dias`);
  const enc = todas.filter((f) => f.status === 'RECUPERADO' || f.status === 'PERDIDO');
  const grupos = new Map<number, { n: number; rec: number }>();
  for (const f of enc) { const k = faixaDe(f.diasAtrasoEntrada); const g = grupos.get(k) ?? { n: 0, rec: 0 }; g.n++; if (f.status === 'RECUPERADO') g.rec++; grupos.set(k, g); }
  const validos = [...grupos.entries()].filter(([, g]) => g.n >= 5).sort((a, b) => a[0] - b[0]);
  if (validos.length >= 2) {
    const [kMelhor, gM] = validos.reduce((a, b) => (b[1].rec / b[1].n > a[1].rec / a[1].n ? b : a));
    const [kPior, gP] = validos.reduce((a, b) => (b[1].rec / b[1].n < a[1].rec / a[1].n ? b : a));
    if (kMelhor !== kPior) {
      out.push({
        id: 'taxa_faixa', frase: `Quem entra com ${rotuloFaixa(kMelhor)} de atraso é recuperado bem mais do que quem entra com ${rotuloFaixa(kPior)}.`,
        numero: validos.map(([k, g]) => `${rotuloFaixa(k)}: ${pct(g.rec / g.n)} (${g.rec}/${g.n})`).join(' · '),
        amostra: `${validos.reduce((s, [, g]) => s + g.n, 0)} fichas encerradas`, confianca: confianca(Math.min(gM.n, gP.n)),
        acao: kMelhor < kPior ? `Antecipar a entrada na recuperação (hoje: ${cfg.entrada_dias} dias) — combinar com o Dono.` : 'Manter a régua; o atraso maior não está atrapalhando.',
      });
    }
  } else semAmostra.push('Taxa por faixa de atraso: precisa de pelo menos 5 fichas encerradas em 2 faixas.');

  // 2) Promessas quebradas
  const promessas = await db.execute(sql`SELECT COUNT(*) FILTER (WHERE resultado = 'VAI_PAGAR' OR (resultado = 'PARCELAR' AND data_prometida IS NOT NULL))::int AS feitas FROM crm_eventos WHERE tipo = 'RESULTADO'`);
  const feitas = Number((promessas.rows[0] as any).feitas);
  const quebradas = todas.reduce((s, f) => s + f.promessasQuebradas, 0);
  if (feitas >= 5) {
    out.push({
      id: 'promessas', frase: quebradas / feitas >= 0.4 ? 'Muitas promessas de pagamento não são cumpridas.' : 'A maioria das promessas de pagamento é cumprida.',
      numero: `${quebradas} de ${feitas} promessas quebradas (${pct(quebradas / feitas)})`, amostra: `${feitas} promessas`, confianca: confianca(feitas),
      acao: quebradas / feitas >= 0.4 ? 'Pedir data mais curta (até 3 dias) e confirmar por ligação na véspera.' : 'Manter o lembrete no dia e no dia seguinte.',
    });
  } else semAmostra.push(`Promessas quebradas: ${feitas} promessa(s) registradas (mínimo 5).`);

  // 3) Melhor canal: contato seguido de "vai pagar"/"pagou" (último contato antes do resultado, mesma ficha)
  const canais = await db.execute(sql`
    SELECT ct.canal, COUNT(*)::int AS contatos,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM crm_eventos r WHERE r.cobranca_id = ct.cobranca_id AND r.tipo = 'RESULTADO' AND r.resultado IN ('VAI_PAGAR','PAGOU','PARCELAR')
          AND r.id > ct.id AND NOT EXISTS (SELECT 1 FROM crm_eventos c2 WHERE c2.cobranca_id = ct.cobranca_id AND c2.tipo = 'CONTATO' AND c2.id > ct.id AND c2.id < r.id)
      ))::int AS positivos
    FROM crm_eventos ct WHERE ct.tipo = 'CONTATO' GROUP BY ct.canal`);
  const cs = (canais.rows as any[]).filter((c) => Number(c.contatos) >= 10);
  if (cs.length >= 2) {
    const melhor = cs.reduce((a, b) => (b.positivos / b.contatos > a.positivos / a.contatos ? b : a));
    out.push({
      id: 'canal', frase: `${CANAL_PT[melhor.canal]} é o canal que mais vira promessa ou pagamento.`,
      numero: cs.map((c) => `${CANAL_PT[c.canal]}: ${pct(c.positivos / c.contatos)} (${c.positivos}/${c.contatos})`).join(' · '),
      amostra: `${cs.reduce((s, c) => s + Number(c.contatos), 0)} contatos`, confianca: confianca(Math.min(...cs.map((c) => Number(c.contatos)))),
      acao: `Ajustar a régua para usar mais ${CANAL_PT[melhor.canal]} nos passos que hoje usam o outro canal.`,
    });
  } else semAmostra.push('Melhor canal: precisa de pelo menos 10 contatos em cada um de 2 canais.');

  // 4) Valor parado há mais de 60 dias (todas as contas a receber, dentro ou fora da recuperação)
  const parado = await listAccountsWithTotals(db, sql`a.status = 'PENDING' AND COALESCE(a.promised_date, (COALESCE(a.pending_at, a.opened_at) AT TIME ZONE ${TZ})::date) <= (${hoje}::date - 60)`, 5000);
  const paradoCents = parado.reduce((s, a) => s + Math.max(0, a.balance), 0);
  if (parado.length) {
    const naRecuperacao = new Set(todas.filter((f) => f.encerradoEm == null).map((f) => f.accountId));
    const fora = parado.filter((a) => !naRecuperacao.has(a.id));
    out.push({
      id: 'parado_60', frase: 'Há dinheiro do fiado parado há mais de 60 dias.', numero: `${brl(paradoCents)} em ${parado.length} conta(s)${fora.length ? ` · ${fora.length} fora da recuperação` : ''}`,
      amostra: `${parado.length} conta(s) a receber`, confianca: 'alta',
      acao: fora.length ? 'Conferir com o Dono as contas fora da recuperação (não cobrar? contato errado?).' : 'Priorizar estas fichas na fila e propor acordo.',
      impacto: `Estimativa: se a taxa atual de recuperação valer para elas, ${brl(Math.round(paradoCents * (enc.length ? enc.filter((f) => f.status === 'RECUPERADO').length / enc.length : 0)))} voltariam ao caixa (premissa: taxa por número de fichas encerradas; ${enc.length} encerradas até agora).`,
    });
  }

  // 5) Concentração: quantos devedores fazem 80% do valor em aberto na recuperação
  const abertas = todas.filter((f) => f.encerradoEm == null && f.status !== 'NAO_COBRAR');
  const porDevedor = new Map<string, number>();
  for (const f of abertas) { const k = f.nome.trim().toLowerCase(); porDevedor.set(k, (porDevedor.get(k) ?? 0) + f.saldoCents); }
  const valores = [...porDevedor.values()].sort((a, b) => b - a);
  const total = valores.reduce((s, v) => s + v, 0);
  if (valores.length >= 5 && total > 0) {
    let acc = 0, k = 0;
    while (acc < total * 0.8 && k < valores.length) acc += valores[k++];
    out.push({
      id: 'concentracao', frase: k / valores.length <= 0.3 ? 'Poucos devedores concentram a maior parte do valor.' : 'O valor em aberto está espalhado entre muitos devedores.',
      numero: `${k} de ${valores.length} devedores somam 80% de ${brl(total)}`, amostra: `${valores.length} devedores`, confianca: confianca(valores.length),
      acao: k / valores.length <= 0.3 ? `Atender primeiro os ${k} maiores, de preferência por ligação.` : 'Seguir a fila pela régua; não há um devedor que pese sozinho.',
    });
  } else semAmostra.push('Concentração: precisa de pelo menos 5 devedores com fichas abertas.');

  return { insights: out, semAmostra };
}
