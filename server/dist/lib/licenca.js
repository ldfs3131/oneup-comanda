import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { currentContext, db } from '../db/index.js';
import { empresas } from '../db/schema.js';
import { HttpError } from './http.js';
export const LICENCA_STATUS = ['ATIVO', 'SO_CONSULTA', 'SUSPENSO'];
export const LICENCA_ROTULO = { ATIVO: 'Ativo', SO_CONSULTA: 'Só consulta', SUSPENSO: 'Suspenso' };
/** Aviso ao Dono a partir de quantos dias antes do vencimento */
export const DIAS_AVISO = 5;
export const MSG_SUSPENSO = 'Acesso suspenso — fale com a ONE UP.';
export const MSG_SO_CONSULTA = 'Sistema em "só consulta": a licença deste restaurante não está ativa. Dá para ver o histórico, receber contas abertas e exportar, mas não dá para abrir o dia nem lançar pedidos novos. Fale com a ONE UP.';
export const MSG_SO_RECEBER = 'Este caixa foi aberto só para receber contas (sistema em "só consulta"). Pedidos novos estão bloqueados — fale com a ONE UP.';
/** "Hoje" da licença no fuso do restaurante. ONEUP_HOJE (AAAA-MM-DD) adianta o relógio só fora de produção (testes). */
export function hojeLicenca() {
    const f = process.env.ONEUP_HOJE;
    if (f && process.env.NODE_ENV !== 'production' && /^\d{4}-\d{2}-\d{2}$/.test(f))
        return f;
    return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
}
const diaUTC = (d) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
/** Dias de hoje até o vencimento (0 = vence hoje; negativo = vencida). Nulo = sem vencimento. */
export function diasParaVencer(venceEm, hoje = hojeLicenca()) {
    if (!venceEm)
        return null;
    return Math.round((diaUTC(venceEm) - diaUTC(hoje)) / 86400_000);
}
/** Status que vale ao abrir o dia: SUSPENSO > SO_CONSULTA (definido ou vencida) > ATIVO. */
export function statusEfetivo(l, hoje = hojeLicenca()) {
    if (l.licencaStatus === 'SUSPENSO')
        return 'SUSPENSO';
    if (l.licencaStatus === 'SO_CONSULTA')
        return 'SO_CONSULTA';
    const d = diasParaVencer(l.licencaVenceEm, hoje);
    return d !== null && d < 0 ? 'SO_CONSULTA' : 'ATIVO';
}
/** Lê a licença da empresa do contexto atual (o restaurante enxerga só a própria linha em `empresas`). */
export async function licencaAtual() {
    const id = currentContext()?.empresaId;
    if (!id)
        return { licencaStatus: 'ATIVO', licencaVenceEm: null, efetivo: 'ATIVO' };
    const [e] = await db.select({ licencaStatus: empresas.licencaStatus, licencaVenceEm: empresas.licencaVenceEm }).from(empresas).where(eq(empresas.id, id));
    const l = e ?? { licencaStatus: 'ATIVO', licencaVenceEm: null };
    return { ...l, efetivo: statusEfetivo(l) };
}
export const erroSuspenso = () => new HttpError(403, MSG_SUSPENSO, 'LICENCA_SUSPENSA');
export const erroSoConsulta = () => new HttpError(409, MSG_SO_CONSULTA, 'LICENCA_SO_CONSULTA');
/** Resumo para as telas. Valores (mensalidade, plano) ficam fora: só a Central da ONE UP mostra. */
export function resumoLicenca(l, completo, diaAberto = false) {
    const efetivo = statusEfetivo(l);
    if (!completo)
        return { status: efetivo };
    const dias = diasParaVencer(l.licencaVenceEm);
    return {
        status: efetivo,
        definido: l.licencaStatus,
        venceEm: l.licencaVenceEm,
        diasParaVencer: dias,
        vencida: dias !== null && dias < 0,
        // dia aberto com a licença já fora: o serviço segue até encerrar (o painel explica isso)
        diaAberto: efetivo !== 'ATIVO' && diaAberto,
        // aviso no topo do painel do Dono: a partir de 5 dias antes (e enquanto estiver vencida)
        avisar: efetivo !== 'ATIVO' || (dias !== null && dias <= DIAS_AVISO),
    };
}
