/**
 * CENTRAL DE ANÁLISE ONE UP — Relatório Mensal (Módulo I), 100% por regra em código (sem IA).
 *
 * 1) PACOTE DE FATOS: números do mês calculados por SQL a partir dos dados reais (vendas com custo congelado,
 *    pagamentos, descontos, cancelamentos, despesas, estoque, custos, fiado, clientes e horários dos pedidos).
 * 2) BIBLIOTECA DE DETECTORES: cada detector olha um aspecto, tem limiar e amostra mínima escritos, confiança
 *    (regras do Módulo F), ação, e impacto em R$/mês SEMPRE marcado como estimativa e com a premissa escrita.
 * 3) RELATÓRIO (I.2): seções montadas a partir dos achados com as regras de honestidade do I.3:
 *    um fato aparece em UMA seção só (deduplicação pelo código do fato), "5" é máximo (nunca completar a lista),
 *    mês sem dados = "sem dados" (nunca zero) e confiança baixa declarada nos primeiros meses.
 *
 * SÓ A ONE UP vê isto (rotas com guarda ONE UP; o Dono, o Caixa e a Cozinha recebem 404).
 */
import { sql } from 'drizzle-orm';
import { lerConfig } from './configuracoes.js';
import { diasNoMes, somarMeses } from './ritmo.js';
const TZ = 'America/Sao_Paulo';
export const LIMIARES = {
    metaMargem: 0.6, // margem bruta por produto considerada saudável (Módulo A)
    atencaoMargem: 0.45, // abaixo disso = margem baixa
    descontoLimite: 0.03, // descontos acima de 3% das vendas brutas
    despesaLimite: 0.4, // despesas acima de 40% da receita
    diaFraco: 0.6, // dia da semana com menos de 60% da média dos outros
    fiadoDiasSemData: 7, // conta pendente sem data combinada vira "vencida" depois de 7 dias
    minPedidosMes: 30, // comparações de mês só com 30+ pedidos no mês
    minItensProduto: 10, // leitura por produto com 10+ unidades
    capitalParadoX: 3, // cobertura acima de 3× a meta = capital parado
};
// ======================================================================================
// Utilidades
// ======================================================================================
const n = (v) => Number(v ?? 0);
const nn = (v) => (v == null ? null : Number(v));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const brl = (c) => {
    const neg = c < 0;
    const [i, d] = (Math.abs(Math.round(c)) / 100).toFixed(2).split('.');
    return `${neg ? '−' : ''}R$ ${i.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${d}`;
};
const brl0 = (c) => { const neg = c < 0; const r = Math.round(Math.abs(c) / 100); return `${neg ? '−' : ''}R$ ${String(r).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`; };
const pct = (x, d = 0) => `${(x * 100).toFixed(d).replace('.', ',')}%`;
const sPct = (x, d = 0) => `${x >= 0 ? '+' : '−'}${pct(Math.abs(x), d)}`;
const pp = (x) => `${x >= 0 ? '+' : '−'}${(Math.abs(x) * 100).toFixed(1).replace('.', ',')} p.p.`;
const num1 = (x) => x.toFixed(1).replace('.', ',');
const median = (a) => { if (!a.length)
    return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantil = (a, q) => { if (!a.length)
    return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]; };
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const nomeMes = (k) => `${MESES[Number(k.slice(5, 7)) - 1]} de ${k.slice(0, 4)}`;
const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const DIAS_PL = ['domingos', 'segundas', 'terças', 'quartas', 'quintas', 'sextas', 'sábados'];
const ORDEM_CONF = { BAIXA: 0, MEDIA: 1, ALTA: 2 };
const menorConf = (...c) => c.reduce((a, b) => (ORDEM_CONF[b] < ORDEM_CONF[a] ? b : a), 'ALTA');
const NIVEL = { BAIXA: 'baixa', MEDIA: 'média', ALTA: 'alta' };
const PESO_CONF = { ALTA: 1, MEDIA: 0.7, BAIXA: 0.4 };
const addDias = (d, k) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const diasEntre = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400_000);
const normNome = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
/** preço sugerido: sobe até 10% e arredonda para cima em R$ 0,50 */
const precoSugerido = (preco, custo, meta) => {
    const alvo = Math.ceil(custo / (1 - meta));
    const teto = Math.round(preco * 1.1);
    return Math.ceil(Math.min(Math.max(alvo, preco + 50), Math.max(teto, preco + 50)) / 50) * 50;
};
const R = (col, from, to) => sql `${sql.raw(col)} >= (${from}::date::timestamp AT TIME ZONE ${TZ}) AND ${sql.raw(col)} < ((${to}::date + 1)::timestamp AT TIME ZONE ${TZ})`;
const FIM = (to) => sql `((${to}::date + 1)::timestamp AT TIME ZONE ${TZ})`;
const LIVE = sql `o.status NOT IN ('AWAITING_CONFIRMATION','CANCELLED') AND oi.status = 'ACTIVE'`;
async function carregarJanela(tx, from, to, tolCaixa) {
    const q = async (s) => (await tx.execute(s)).rows;
    const [v] = await q(sql `
    SELECT COALESCE(SUM(oi.unit_price_cents*oi.quantity),0) AS bruto,
           COALESCE(SUM(oi.unit_cost_cents*oi.quantity) FILTER (WHERE oi.unit_cost_cents IS NOT NULL),0) AS custo,
           COALESCE(SUM(oi.unit_price_cents*oi.quantity) FILTER (WHERE oi.unit_cost_cents IS NOT NULL),0) AS bruto_com_custo,
           COALESCE(SUM(oi.quantity),0) AS itens,
           COUNT(DISTINCT o.id) AS pedidos, COUNT(DISTINCT o.account_id) AS contas,
           COUNT(DISTINCT (o.created_at AT TIME ZONE ${TZ})::date) AS dias_venda
    FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE ${R('o.created_at', from, to)} AND ${LIVE}`);
    const [d] = await q(sql `
    SELECT COALESCE(SUM(d.amount_cents),0) AS total, COUNT(*) AS n,
           COALESCE(SUM(d.amount_cents) FILTER (WHERE EXTRACT(HOUR FROM d.created_at AT TIME ZONE ${TZ}) < 17),0) AS dia,
           COALESCE(SUM(d.amount_cents) FILTER (WHERE EXTRACT(HOUR FROM d.created_at AT TIME ZONE ${TZ}) >= 17),0) AS noite,
           COALESCE(SUM(d.amount_cents) FILTER (WHERE d.kind = 'ADJUSTMENT'),0) AS ajustes
    FROM discounts d JOIN accounts a ON a.id = d.account_id
    WHERE ${R('d.created_at', from, to)} AND a.status <> 'CANCELLED'`);
    const motivosDesc = await q(sql `
    SELECT lower(trim(d.reason)) AS motivo, SUM(d.amount_cents) AS cents, COUNT(*) AS n
    FROM discounts d JOIN accounts a ON a.id = d.account_id
    WHERE ${R('d.created_at', from, to)} AND a.status <> 'CANCELLED' GROUP BY 1 ORDER BY cents DESC LIMIT 3`);
    const [c] = await q(sql `
    SELECT COALESCE(SUM(amount_cents) FILTER (WHERE target <> 'ACCOUNT' AND status_before IS DISTINCT FROM 'Aguardando confirmação'),0) AS cancelado,
           COUNT(*) FILTER (WHERE target <> 'ACCOUNT' AND status_before IS DISTINCT FROM 'Aguardando confirmação') AS n,
           COALESCE(SUM(amount_cents) FILTER (WHERE was_in_preparation),0) AS perda,
           COUNT(*) FILTER (WHERE was_in_preparation) AS n_perda,
           COUNT(*) FILTER (WHERE target = 'ORDER' AND status_before = 'Aguardando confirmação') AS recusados,
           COALESCE(SUM(amount_cents) FILTER (WHERE target = 'ORDER' AND status_before = 'Aguardando confirmação'),0) AS recusado_cents
    FROM cancellations WHERE ${R('created_at', from, to)}`);
    const motivosRecusa = await q(sql `
    SELECT lower(trim(reason)) AS motivo, COUNT(*) AS n FROM cancellations
    WHERE ${R('created_at', from, to)} AND target = 'ORDER' AND status_before = 'Aguardando confirmação' GROUP BY 1 ORDER BY n DESC LIMIT 3`);
    const desp = await q(sql `
    SELECT ec.name, SUM(e.amount_cents) AS cents FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id
    WHERE e.cancelled_at IS NULL AND e.date BETWEEN ${from}::date AND ${to}::date GROUP BY ec.name`);
    const [t] = await q(sql `
    SELECT COALESCE(ROUND(SUM(p.amount_cents::bigint * COALESCE(p.taxa_bp, pm.taxa_bp) / 10000.0)),0) AS taxas, COALESCE(SUM(p.amount_cents),0) AS recebido
    FROM payments p JOIN payment_methods pm ON pm.id = p.method_id WHERE p.reversed_at IS NULL AND ${R('p.created_at', from, to)}`);
    // cozinha: pedidos que foram à cozinha e ficaram prontos
    const coz = await q(sql `
    SELECT EXTRACT(EPOCH FROM (o.ready_at - o.confirmed_at))/60 AS min, COALESCE(o.expected_minutes, 15) AS meta,
           (o.started_at IS NOT NULL AND o.started_at < o.ready_at) AS com_inicio,
           EXTRACT(HOUR FROM o.created_at AT TIME ZONE ${TZ})::int AS hora,
           (o.created_at AT TIME ZONE ${TZ})::date::text AS dia
    FROM orders o WHERE o.goes_to_kitchen AND o.status IN ('READY','DELIVERED') AND o.ready_at IS NOT NULL AND o.confirmed_at IS NOT NULL
      AND ${R('o.created_at', from, to)}`);
    const [cozTot] = await q(sql `SELECT COUNT(*) AS n FROM orders o WHERE o.goes_to_kitchen AND o.status NOT IN ('AWAITING_CONFIRMATION','CANCELLED') AND ${R('o.created_at', from, to)}`);
    const cozRows = coz.map((r) => ({ min: Number(r.min), meta: n(r.meta), comInicio: !!r.com_inicio, hora: n(r.hora), dia: r.dia }));
    const validos = cozRows.filter((r) => r.min >= 0 && r.min <= 3 * r.meta);
    const esquecidos = cozRows.filter((r) => r.min > 3 * r.meta).length;
    const [cx] = await q(sql `
    SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE abs(difference_cents) > ${tolCaixa}::int) AS com_dif,
           COALESCE(SUM(difference_cents) FILTER (WHERE difference_cents < -(${tolCaixa}::int)),0) AS faltas
    FROM cash_registers WHERE status = 'CLOSED' AND difference_cents IS NOT NULL AND ${R('closed_at', from, to)}`);
    const cats = await q(sql `
    SELECT COALESCE(c.name,'Outros') AS cat,
           COALESCE(SUM(oi.unit_price_cents*oi.quantity) FILTER (WHERE oi.unit_cost_cents IS NOT NULL),0) AS receita,
           COALESCE(SUM(oi.unit_cost_cents*oi.quantity) FILTER (WHERE oi.unit_cost_cents IS NOT NULL),0) AS custo,
           COALESCE(SUM(oi.quantity) FILTER (WHERE oi.unit_cost_cents IS NOT NULL),0) AS qtd
    FROM orders o JOIN order_items oi ON oi.order_id = o.id LEFT JOIN products p ON p.id = oi.product_id LEFT JOIN categories c ON c.id = p.category_id
    WHERE ${R('o.created_at', from, to)} AND ${LIVE} GROUP BY 1`);
    // perdas de estoque (ajustes para menos) e dias zerados de produtos controlados que venderam
    const [perdas] = await q(sql `
    SELECT COALESCE(SUM(-m.quantity * COALESCE(m.unit_cost_cents, p.cost_cents, 0)),0) AS cents, COUNT(*) AS n
    FROM stock_movements m JOIN products p ON p.id = m.product_id
    WHERE m.type = 'AJUSTE' AND m.quantity < 0 AND ${R('m.created_at', from, to)}`);
    const zerados = await q(sql `
    SELECT p.id, p.name, COUNT(*) AS dias,
           -- dia de ruptura = terminou zerado E não vendeu nada (zerado e vendendo é divergência de contagem, não falta)
           COUNT(*) FILTER (WHERE x.saldo IS NOT NULL AND x.saldo <= 0 AND NOT EXISTS (
             SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.product_id = p.id AND oi.status = 'ACTIVE'
               AND o.status NOT IN ('AWAITING_CONFIRMATION','CANCELLED')
               AND o.created_at >= (g.dia::date::timestamp AT TIME ZONE ${TZ}) AND o.created_at < ((g.dia::date + 1)::timestamp AT TIME ZONE ${TZ}))) AS dias_zero
    FROM products p
    CROSS JOIN generate_series(${from}::date, ${to}::date, interval '1 day') g(dia)
    LEFT JOIN LATERAL (SELECT m."after" AS saldo FROM stock_movements m WHERE m.product_id = p.id
                       AND m.created_at < ((g.dia::date + 1)::timestamp AT TIME ZONE ${TZ}) ORDER BY m.created_at DESC, m.id DESC LIMIT 1) x ON TRUE
    WHERE p.track_stock AND EXISTS (SELECT 1 FROM stock_movements mm WHERE mm.product_id = p.id)
    GROUP BY p.id, p.name`);
    // fiado na data final da janela (saldo reconstruído até aquele instante)
    const fiado = await saldosFiado(tx, to);
    const venc = fiado.filter((f) => f.vencida);
    // ponto de equilíbrio: dia em que a margem de contribuição acumulada cobre as despesas da janela
    const porDia = await q(sql `
    SELECT (o.created_at AT TIME ZONE ${TZ})::date::text AS dia,
           SUM(oi.unit_price_cents*oi.quantity) AS bruto,
           SUM(oi.unit_cost_cents*oi.quantity) FILTER (WHERE oi.unit_cost_cents IS NOT NULL) AS custo
    FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE ${R('o.created_at', from, to)} AND ${LIVE} GROUP BY 1 ORDER BY 1`);
    const bruto = n(v.bruto), custo = n(v.custo), brutoComCusto = n(v.bruto_com_custo);
    const descontos = n(d.total), receita = bruto - descontos;
    const despesas = desp.reduce((s, x) => s + n(x.cents), 0);
    const taxas = n(t.taxas);
    const cobertura = bruto > 0 ? brutoComCusto / bruto : 0;
    const custoPct = brutoComCusto > 0 ? custo / brutoComCusto : null;
    // custo estimado das vendas sem custo cadastrado: mesma proporção das que têm (só quando a cobertura passa de 50%)
    const margemBruta = cobertura >= 0.5 && custoPct != null && receita > 0 ? (receita - custo - (bruto - brutoComCusto) * custoPct) / receita : null;
    const lucro = receita - custo - despesas - taxas;
    // contribuição de cada real vendido = (receita − custo estimado − taxas) ÷ vendas brutas
    const custoEst = custo + (bruto - brutoComCusto) * (custoPct ?? 0);
    const contrib = bruto > 0 ? (receita - custoEst - taxas) / bruto : 0;
    let acum = 0;
    let peDia = null;
    if (despesas > 0 && contrib > 0)
        for (const r of porDia) {
            acum += n(r.bruto) * contrib;
            if (acum >= despesas) {
                peDia = Number(r.dia.slice(8, 10));
                break;
            }
        }
    const pedidos = n(v.pedidos);
    return {
        from, to, dias: diasEntre(from, to) + 1, diasVenda: n(v.dias_venda),
        temDados: bruto > 0 || despesas > 0,
        bruto, custo, brutoComCusto, cobertura, descontos, receita, itens: n(v.itens), pedidos, contas: n(v.contas),
        ticket: n(v.contas) ? Math.round(receita / n(v.contas)) : null,
        descontosPct: bruto > 0 ? descontos / bruto : null,
        descontosTurno: { dia: n(d.dia), noite: n(d.noite) }, descontosN: n(d.n), ajustes: n(d.ajustes),
        motivosDesconto: motivosDesc.map((m) => ({ motivo: m.motivo, cents: n(m.cents), n: n(m.n) })),
        cancelado: n(c.cancelado), canceladoN: n(c.n), perdaCancel: n(c.perda), perdaCancelN: n(c.n_perda),
        cancelPct: bruto + n(c.cancelado) > 0 ? n(c.cancelado) / (bruto + n(c.cancelado)) : null,
        recusados: n(c.recusados), recusadoCents: n(c.recusado_cents), motivosRecusa: motivosRecusa.map((m) => ({ motivo: m.motivo, n: n(m.n) })),
        despesas, despesasCat: Object.fromEntries(desp.map((x) => [x.name, n(x.cents)])),
        despesasPct: receita > 0 ? despesas / receita : null,
        taxas, recebido: n(t.recebido), lucro,
        margemBruta, margemLiquida: receita > 0 && cobertura >= 0.5 ? lucro / receita : null,
        peDia,
        cozinha: {
            total: n(cozTot.n), prontos: cozRows.length, comHorarios: cozRows.filter((r) => r.comInicio).length,
            pctHorarios: n(cozTot.n) ? cozRows.filter((r) => r.comInicio).length / n(cozTot.n) : 0,
            mediana: median(validos.map((r) => r.min)), dentroMeta: validos.length ? validos.filter((r) => r.min <= r.meta).length / validos.length : null,
            validos: validos.length, esquecidos, linhas: validos,
        },
        caixa: { fechamentos: n(cx.n), comDiferenca: n(cx.com_dif), faltas: -n(cx.faltas) },
        categorias: cats.map((x) => ({ cat: x.cat, receita: n(x.receita), custo: n(x.custo), qtd: n(x.qtd) })),
        estoque: {
            controlados: zerados.length, perdas: n(perdas.cents), perdasN: n(perdas.n),
            diasZero: zerados.reduce((s, z) => s + n(z.dias_zero), 0),
            zerados: zerados.filter((z) => n(z.dias_zero) > 0).map((z) => ({ id: n(z.id), name: z.name, diasZero: n(z.dias_zero), dias: n(z.dias) })),
        },
        fiado: {
            contas: fiado.length, total: fiado.reduce((s, f) => s + f.saldo, 0),
            vencido: venc.reduce((s, f) => s + f.saldo, 0), vencidas: venc.length,
            mais30: fiado.filter((f) => f.idade > 30).reduce((s, f) => s + f.saldo, 0),
        },
    };
}
/** Contas fiado (pendentes) e o saldo de cada uma no fim do dia `to`. */
async function saldosFiado(tx, to) {
    const rows = (await tx.execute(sql `
    SELECT a.id, a.customer_id, lower(trim(COALESCE(a.customer_name, ''))) AS nome, a.promised_date::text AS prometido,
           (a.pending_at AT TIME ZONE ${TZ})::date::text AS desde,
           COALESCE((SELECT SUM(oi.unit_price_cents*oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                     WHERE o.account_id = a.id AND oi.status = 'ACTIVE' AND o.status NOT IN ('AWAITING_CONFIRMATION','CANCELLED') AND o.created_at < ${FIM(to)}),0)
           - COALESCE((SELECT SUM(amount_cents) FROM discounts WHERE account_id = a.id AND created_at < ${FIM(to)}),0)
           - COALESCE((SELECT SUM(amount_cents) FROM payments WHERE account_id = a.id AND created_at < ${FIM(to)} AND (reversed_at IS NULL OR reversed_at >= ${FIM(to)})),0) AS saldo
    FROM accounts a
    WHERE a.pending_at IS NOT NULL AND a.pending_at < ${FIM(to)} AND a.status NOT IN ('CANCELLED','MERGED')
      AND (a.status = 'PENDING' OR a.closed_at IS NULL OR a.closed_at >= ${FIM(to)})`)).rows;
    return rows.map((r) => {
        const idade = diasEntre(r.desde, to);
        const vencida = r.prometido ? r.prometido < to : idade > LIMIARES.fiadoDiasSemData;
        return { id: n(r.id), cliente: r.customer_id ? `c${r.customer_id}` : r.nome ? `n:${r.nome}` : `a${r.id}`, prometido: r.prometido, desde: r.desde, idade, vencida, saldo: n(r.saldo) };
    }).filter((r) => r.saldo > 0);
}
// ---------- extras do mês analisado (só a janela atual) ----------
async function carregarExtras(tx, from, to) {
    const q = async (s) => (await tx.execute(s)).rows;
    const produtos = await q(sql `
    SELECT oi.product_id AS id, oi.product_name AS name, COALESCE(c.name, 'Outros') AS cat, p.price_cents AS preco, p.cost_cents AS custo_atual,
           SUM(oi.quantity) AS qtd, SUM(oi.unit_price_cents*oi.quantity) AS receita,
           SUM(oi.unit_cost_cents*oi.quantity) FILTER (WHERE oi.unit_cost_cents IS NOT NULL) AS custo,
           SUM(oi.unit_price_cents*oi.quantity) FILTER (WHERE oi.unit_cost_cents IS NOT NULL) AS receita_com_custo,
           SUM(oi.quantity) FILTER (WHERE oi.unit_cost_cents IS NOT NULL) AS qtd_com_custo,
           bool_or(oi.is_custom) AS avulso
    FROM orders o JOIN order_items oi ON oi.order_id = o.id LEFT JOIN products p ON p.id = oi.product_id LEFT JOIN categories c ON c.id = p.category_id
    WHERE ${R('o.created_at', from, to)} AND ${LIVE} AND NOT oi.is_custom
    GROUP BY oi.product_id, oi.product_name, c.name, p.price_cents, p.cost_cents`);
    const avulsos = await q(sql `
    SELECT oi.product_name AS name, COUNT(*) AS n, SUM(oi.quantity) AS qtd, bool_and(oi.unit_cost_cents IS NULL) AS sem_custo
    FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE ${R('o.created_at', from, to)} AND ${LIVE} AND oi.is_custom GROUP BY oi.product_name`);
    const porDia = await q(sql `
    SELECT (o.created_at AT TIME ZONE ${TZ})::date::text AS dia, SUM(oi.unit_price_cents*oi.quantity) AS bruto
    FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE ${R('o.created_at', from, to)} AND ${LIVE} GROUP BY 1`);
    const porHora = await q(sql `
    SELECT EXTRACT(HOUR FROM o.created_at AT TIME ZONE ${TZ})::int AS h, COUNT(*) AS n FROM orders o
    WHERE ${R('o.created_at', from, to)} AND o.status NOT IN ('AWAITING_CONFIRMATION','CANCELLED') GROUP BY 1 ORDER BY 1`);
    const origem = await q(sql `
    SELECT o.origin, COUNT(*) AS n FROM orders o WHERE ${R('o.created_at', from, to)} AND o.status NOT IN ('AWAITING_CONFIRMATION','CANCELLED') GROUP BY 1`);
    const fila = await q(sql `
    SELECT EXTRACT(EPOCH FROM (o.confirmed_at - o.created_at))/60 AS min FROM orders o
    WHERE o.origin <> 'CAIXA' AND o.confirmed_at IS NOT NULL AND ${R('o.created_at', from, to)} AND o.status <> 'CANCELLED'`);
    // pares de produtos no mesmo pedido (combo)
    const pares = await q(sql `
    WITH it AS (SELECT DISTINCT o.id AS pedido, oi.product_id AS pid, oi.product_name AS nome
                FROM orders o JOIN order_items oi ON oi.order_id = o.id
                WHERE ${R('o.created_at', from, to)} AND ${LIVE} AND oi.product_id IS NOT NULL)
    SELECT a.pid AS a, a.nome AS na, b.pid AS b, b.nome AS nb, COUNT(*) AS juntos
    FROM it a JOIN it b ON a.pedido = b.pedido AND a.pid < b.pid GROUP BY 1,2,3,4 ORDER BY juntos DESC LIMIT 5`);
    const pedidosCom = await q(sql `
    SELECT oi.product_id AS pid, COUNT(DISTINCT o.id) AS n FROM orders o JOIN order_items oi ON oi.order_id = o.id
    WHERE ${R('o.created_at', from, to)} AND ${LIVE} AND oi.product_id IS NOT NULL GROUP BY 1`);
    // clientes identificados (histórico até o fim da janela)
    const clientes = await q(sql `
    SELECT a.customer_id AS id, bool_or(cu.aceita_ofertas) AS ofertas,
           MIN((o.created_at AT TIME ZONE ${TZ})::date)::text AS primeiro, MAX((o.created_at AT TIME ZONE ${TZ})::date)::text AS ultimo,
           COUNT(DISTINCT (o.created_at AT TIME ZONE ${TZ})::date) AS dias,
           COALESCE(SUM(oi.unit_price_cents*oi.quantity) FILTER (WHERE o.created_at >= ${FIM(to)} - interval '180 days'),0) AS gasto180,
           bool_or(${R('o.created_at', from, to)}) AS no_mes
    FROM accounts a JOIN customers cu ON cu.id = a.customer_id JOIN orders o ON o.account_id = a.id JOIN order_items oi ON oi.order_id = o.id
    WHERE a.customer_id IS NOT NULL AND o.created_at < ${FIM(to)} AND ${LIVE}
    GROUP BY a.customer_id`);
    // histórico de custo (cadastro de custo + entradas de estoque com custo), 120 dias
    const custos = await q(sql `
    SELECT product_id AS pid, (created_at AT TIME ZONE ${TZ})::date::text AS dia, cost_cents AS custo, NULL::text AS fornecedor, 'cadastro' AS origem
    FROM product_costs WHERE created_at < ${FIM(to)} AND created_at >= ${FIM(to)} - interval '150 days'
    UNION ALL
    SELECT product_id, (created_at AT TIME ZONE ${TZ})::date::text, unit_cost_cents, fornecedor, 'entrada'
    FROM stock_movements WHERE type = 'ENTRADA' AND unit_cost_cents IS NOT NULL AND created_at < ${FIM(to)} AND created_at >= ${FIM(to)} - interval '150 days'
    ORDER BY 2`);
    const custoAntes = await q(sql `
    SELECT DISTINCT ON (product_id) product_id AS pid, cost_cents AS custo FROM product_costs
    WHERE created_at < ${FIM(to)} - interval '150 days' ORDER BY product_id, created_at DESC, id DESC`);
    const precos = await q(sql `
    SELECT oi.product_id AS pid,
           AVG(oi.unit_price_cents) FILTER (WHERE o.created_at < ${FIM(to)} - interval '90 days') AS antes,
           AVG(oi.unit_price_cents) FILTER (WHERE o.created_at >= ${FIM(to)} - interval '30 days') AS agora
    FROM orders o JOIN order_items oi ON oi.order_id = o.id
    WHERE o.created_at < ${FIM(to)} AND o.created_at >= ${FIM(to)} - interval '150 days' AND ${LIVE} AND oi.product_id IS NOT NULL GROUP BY 1`);
    // estoque atual (controlados): saldo, custo, venda média dos últimos 30 dias até o fim da janela
    const estoque = await q(sql `
    SELECT p.id, p.name, p.stock_qty AS qtd, p.cost_cents AS custo, p.price_cents AS preco,
           COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                     WHERE oi.product_id = p.id AND ${LIVE} AND o.created_at < ${FIM(to)} AND o.created_at >= ${FIM(to)} - interval '30 days'),0) AS vendidos30
    FROM products p WHERE p.track_stock AND p.active`);
    const divergencias = await q(sql `
    SELECT p.id, p.name, COUNT(*) AS vezes, SUM(m.missing) AS faltou FROM stock_movements m JOIN products p ON p.id = m.product_id
    WHERE m.type = 'DIVERGENCIA' AND m.missing > 0 AND ${R('m.created_at', from, to)} GROUP BY p.id, p.name ORDER BY vezes DESC`);
    const perdasMotivo = await q(sql `
    SELECT COALESCE(NULLIF(lower(trim(m.reason)), ''), 'sem motivo') AS motivo, SUM(-m.quantity * COALESCE(m.unit_cost_cents, p.cost_cents, 0)) AS cents, SUM(-m.quantity) AS qtd
    FROM stock_movements m JOIN products p ON p.id = m.product_id
    WHERE m.type = 'AJUSTE' AND m.quantity < 0 AND ${R('m.created_at', from, to)} GROUP BY 1 ORDER BY cents DESC`);
    const fornecedores = await q(sql `
    SELECT m.product_id AS pid, p.name, m.fornecedor, (m.created_at AT TIME ZONE ${TZ})::date::text AS dia, m.unit_cost_cents AS custo, m.quantity AS qtd
    FROM stock_movements m JOIN products p ON p.id = m.product_id
    WHERE m.type = 'ENTRADA' AND m.unit_cost_cents IS NOT NULL AND m.fornecedor IS NOT NULL AND m.fornecedor <> ''
      AND m.created_at < ${FIM(to)} AND m.created_at >= ${FIM(to)} - interval '90 days' ORDER BY m.created_at`);
    // prazo de recebimento do fiado: contas que saíram do fiado nos 90 dias até o fim da janela
    const prazos = await q(sql `
    SELECT EXTRACT(EPOCH FROM (a.closed_at - a.pending_at))/86400 AS dias FROM accounts a
    WHERE a.pending_at IS NOT NULL AND a.closed_at IS NOT NULL AND a.status IN ('CLOSED','PAID')
      AND a.closed_at < ${FIM(to)} AND a.closed_at >= ${FIM(to)} - interval '90 days'`);
    const [primeiro] = await q(sql `SELECT MIN((created_at AT TIME ZONE ${TZ})::date)::text AS dia FROM orders WHERE status NOT IN ('AWAITING_CONFIRMATION','CANCELLED')`);
    const [qr] = await q(sql `SELECT qr_enabled AS on FROM restaurant_settings LIMIT 1`);
    return {
        produtos: produtos.map((p) => ({
            id: nn(p.id), name: p.name, cat: p.cat, preco: nn(p.preco), custoAtual: nn(p.custo_atual),
            qtd: n(p.qtd), receita: n(p.receita), custo: nn(p.custo), receitaComCusto: n(p.receita_com_custo), qtdComCusto: n(p.qtd_com_custo),
        })),
        avulsos: avulsos.map((a) => ({ name: a.name, n: n(a.n), qtd: n(a.qtd), semCusto: !!a.sem_custo })),
        porDia: porDia.map((r) => ({ dia: r.dia, bruto: n(r.bruto) })),
        porHora: porHora.map((r) => ({ h: n(r.h), n: n(r.n) })),
        origem: Object.fromEntries(origem.map((r) => [r.origin, n(r.n)])),
        fila: fila.map((r) => Number(r.min)).filter((x) => x >= 0 && x < 240),
        pares: pares.map((r) => ({ a: n(r.a), na: r.na, b: n(r.b), nb: r.nb, juntos: n(r.juntos) })),
        pedidosCom: new Map(pedidosCom.map((r) => [n(r.pid), n(r.n)])),
        clientes: clientes.map((c) => ({ id: n(c.id), ofertas: !!c.ofertas, primeiro: c.primeiro, ultimo: c.ultimo, dias: n(c.dias), gasto180: n(c.gasto180), noMes: !!c.no_mes })),
        custos: custos.map((c) => ({ pid: n(c.pid), dia: c.dia, custo: n(c.custo), fornecedor: c.fornecedor })),
        custoAntes: new Map(custoAntes.map((c) => [n(c.pid), n(c.custo)])),
        precos: new Map(precos.map((p) => [n(p.pid), { antes: nn(p.antes), agora: nn(p.agora) }])),
        estoque: estoque.map((e) => ({ id: n(e.id), name: e.name, qtd: n(e.qtd), custo: nn(e.custo), preco: n(e.preco), vendidos30: n(e.vendidos30) })),
        divergencias: divergencias.map((d) => ({ id: n(d.id), name: d.name, vezes: n(d.vezes), faltou: n(d.faltou) })),
        perdasMotivo: perdasMotivo.map((p) => ({ motivo: p.motivo, cents: n(p.cents), qtd: n(p.qtd) })),
        fornecedores: fornecedores.map((f) => ({ pid: n(f.pid), name: f.name, fornecedor: f.fornecedor, dia: f.dia, custo: n(f.custo), qtd: n(f.qtd) })),
        prazos: prazos.map((p) => Number(p.dias)),
        primeiroDia: primeiro?.dia ?? null,
        qrLigado: !!qr?.on,
    };
}
// ======================================================================================
// 2) CONFIANÇA (Módulo F)
// ======================================================================================
function confiancaGeral(diasHistorico, pedidos, pctHorarios) {
    const motivos = [];
    let c;
    if (diasHistorico < 14 || pedidos < 100 || (pctHorarios != null && pctHorarios < 0.5)) {
        c = 'BAIXA';
        if (diasHistorico < 14)
            motivos.push(`só ${diasHistorico} dias de histórico (precisa de 14+)`);
        if (pedidos < 100)
            motivos.push(`só ${pedidos} pedidos no período (precisa de 100+)`);
        if (pctHorarios != null && pctHorarios < 0.5)
            motivos.push(`só ${pct(pctHorarios)} dos pedidos com Iniciar/Pronto na cozinha`);
    }
    else if (diasHistorico > 60 && pedidos > 500 && (pctHorarios == null || pctHorarios >= 0.8)) {
        c = 'ALTA';
        motivos.push(`${diasHistorico} dias de histórico e ${pedidos} pedidos no período`);
    }
    else {
        c = 'MEDIA';
        motivos.push(`${diasHistorico} dias de histórico e ${pedidos} pedidos (alta: mais de 60 dias e 500 pedidos${pctHorarios != null ? ', 80% com horários' : ''})`);
    }
    return { nivel: c, motivos };
}
/** confiança de um achado: pela amostra do próprio achado, limitada pela confiança geral dos dados */
const confDe = (amostra, min, geral) => menorConf(amostra >= min * 3 ? 'ALTA' : amostra >= min * 1.5 ? 'MEDIA' : 'BAIXA', geral);
// ======================================================================================
// 3) TÉCNICAS DE GESTÃO (ligadas aos achados)
// ======================================================================================
export const TECNICAS = {
    engenharia_cardapio: { nome: 'Engenharia de cardápio', para: 'decidir preço, destaque e permanência de cada item pelo par popularidade × margem', passos: ['Classifique cada item na matriz (Estrela, Burro de carga, Quebra-cabeça, Abacaxi).', 'Burro de carga: suba o preço em degraus de até 10% ou reduza o custo da porção; Quebra-cabeça: destaque no cardápio e no caixa.', 'Abacaxi: reveja a receita ou retire; reavalie a matriz todo mês.'] },
    controle_cmv: { nome: 'Controle de CMV (custo da mercadoria vendida)', para: 'saber a margem real de cada venda e reagir quando o custo sobe', passos: ['Cadastre o custo de todos os produtos e atualize a cada compra com preço novo.', 'Toda segunda-feira compare o custo médio da semana com o preço de venda.', 'Custo subiu mais de 10%: reprecifique ou troque o fornecedor na mesma semana.'] },
    curva_abc_estoque: { nome: 'Curva ABC de estoque', para: 'concentrar dinheiro e atenção nos poucos itens que fazem a maior parte do giro', passos: ['Ordene os itens pelo valor vendido: A = 80% do valor, B = 15%, C = 5%.', 'Itens A: contagem semanal e estoque mínimo; itens C: compre só sob demanda.', 'Revise a classificação todo mês.'] },
    peps: { nome: 'PEPS (primeiro que entra, primeiro que sai)', para: 'reduzir perdas por validade e quebra', passos: ['Etiquete as entradas com a data e coloque o mais novo atrás.', 'Registre toda perda com motivo no sistema (ajuste de estoque).', 'Toda semana olhe as perdas por motivo e corrija a causa da maior.'] },
    escala_pico: { nome: 'Escala por pico', para: 'ter gente na hora certa: menos fila no pico, menos custo na hora parada', passos: ['Use o mapa de horários para ver os picos e as horas paradas.', 'Reforce a equipe 30 min antes do pico e deixe tarefas de preparo (pré-preparo) para as horas paradas.', 'Meça o tempo de cozinha no pico depois da mudança.'] },
    venda_sugestiva: { nome: 'Venda adicional / sugestiva', para: 'aumentar o ticket sem precisar de mais clientes', passos: ['Defina 1 sugestão por tipo de pedido (bebida com prato, sobremesa no fechamento).', 'Treine o caixa com uma frase pronta e curta.', 'Acompanhe o ticket médio semanal.'] },
    combos: { nome: 'Combos', para: 'transformar itens que já saem juntos em uma oferta que aumenta o ticket', passos: ['Pegue o par que mais sai junto no mesmo pedido.', 'Monte o combo com desconto pequeno (5% a 8%) que preserve a margem.', 'Teste por 30 dias e compare a venda do par antes e depois.'] },
    meta_ticket: { nome: 'Meta de ticket médio', para: 'dar à equipe um número simples para perseguir', passos: ['Fixe a meta: ticket atual + 5%.', 'Mostre o ticket da semana para a equipe toda segunda.', 'Reconheça quem mais vende adicional (sem punição).'] },
    controle_descontos: { nome: 'Controle de descontos', para: 'evitar que desconto vire hábito e coma a margem', passos: ['Defina o desconto máximo do caixa nas Configurações.', 'Exija motivo em todo desconto e revise os motivos toda semana.', 'Troque desconto por brinde de baixo custo quando possível.'] },
    ponto_equilibrio: { nome: 'Ponto de equilíbrio', para: 'saber quanto precisa vender por mês para pagar as despesas', passos: ['Ponto de equilíbrio = despesas ÷ (1 − custo% das vendas).', 'Divida pelo número de dias abertos: é a meta diária mínima.', 'Acompanhe o dia do mês em que o ponto é atingido: quanto mais cedo, melhor.'] },
    cotacao: { nome: 'Cotação de fornecedores', para: 'pagar menos pelo mesmo produto', passos: ['Cote os 5 itens mais comprados com pelo menos 2 fornecedores todo mês.', 'Registre o fornecedor e o custo em cada entrada de estoque.', 'Renegocie quando um fornecedor subir mais de 10%.'] },
    reativacao: { nome: 'Reativação de clientes', para: 'trazer de volta quem já comprava (só quem aceitou receber ofertas)', passos: ['Liste os clientes que sumiram e aceitaram ofertas.', 'Envie uma mensagem pessoal com um motivo para voltar (novidade ou cortesia pequena).', 'Meça quantos voltaram em 30 dias.'] },
    fechamento_caixa: { nome: 'Fechamento de caixa às cegas com conferência', para: 'achar e corrigir diferenças de caixa cedo', passos: ['Mantenha o fechamento às cegas ligado.', 'Confira toda diferença acima da tolerância no mesmo dia, com quem fechou.', 'Padronize sangrias e troco inicial.'] },
    disciplina_cozinha: { nome: 'Disciplina de tela na cozinha', para: 'medir o preparo de verdade e enxergar atrasos', passos: ['Combine com a cozinha: tocar Iniciar ao começar e Pronto ao terminar.', 'Revise os pedidos esquecidos toda semana.', 'Use o tempo real para ajustar o tempo-meta dos pratos.'] },
    politica_fiado: { nome: 'Política de fiado', para: 'vender a prazo sem virar prejuízo', passos: ['Sempre registre a data combinada de pagamento.', 'Defina um limite por cliente e não abra fiado novo com conta vencida.', 'Revise a lista de vencidos duas vezes por semana (cobrança feita por uma pessoa).'] },
    dia_fraco: { nome: 'Campanha para o dia fraco', para: 'ocupar a cozinha nos dias e horas de pouco movimento', passos: ['Escolha o dia mais fraco e crie uma oferta só dele (prato do dia, combo família).', 'Divulgue no grupo/cardápio digital na véspera.', 'Compare as vendas do dia nas 4 semanas seguintes.'] },
    ficha_tecnica: { nome: 'Ficha técnica', para: 'padronizar porção e custo de cada prato', passos: ['Escreva a receita com o peso de cada ingrediente.', 'Calcule o custo da porção e cadastre como custo do produto.', 'Revise a ficha a cada mudança de preço dos ingredientes.'] },
    canal_digital: { nome: 'Canal digital (cardápio online)', para: 'vender mais sem fila no caixa', passos: ['Divulgue o link/QR do cardápio nas mesas e no grupo de clientes.', 'Confirme os pedidos online em menos de 3 minutos.', 'Acompanhe a participação do online todo mês.'] },
};
const base = (a) => ({
    gravidade: 0.5, acao: null, dono: null, impacto: null, horizonte: null, esforco: null, tecnicas: [], ...a,
});
const imp = (centsMes, premissa, grupo, tipo = 'LUCRO') => centsMes >= 1000 ? { centsMes: Math.round(centsMes), premissa, estimativa: true, tipo, grupo } : null;
/** margem bruta usada nas estimativas (com premissa quando não há custo suficiente) */
const margemEst = (c) => (c.cur.margemBruta != null ? { m: c.cur.margemBruta, txt: `margem bruta do mês (${pct(c.cur.margemBruta)})` } : { m: 0.5, txt: 'margem bruta suposta de 50% (custo cadastrado insuficiente)' });
/** Indicadores de comparação neutros: o que subiu e o que caiu (vs mês anterior, média 3 meses, ano anterior). */
function comparativos(c) {
    if (!c.cur.temDados || c.cur.pedidos < 20)
        return c.cur.temDados ? 'AMOSTRA' : 'SEM_DADOS';
    const bases = [
        { nome: c.emCurso ? `no mesmo período do mês anterior (até o dia ${c.diaCorte})` : 'no mês anterior', id: 'ANT', f: c.prev && c.prev.temDados ? c.prev : null },
        { nome: c.emCurso ? `na média dos ${c.prev3.length} meses anteriores (até o dia ${c.diaCorte})` : `na média dos ${c.prev3.length} meses anteriores`, id: 'M3', f: c.prev3.length >= 2 ? media(c.prev3) : null },
        { nome: 'no mesmo mês do ano anterior', id: 'ANO', f: c.ano && c.ano.temDados ? c.ano : null },
    ];
    const metricas = [
        { k: 'vendas', nome: 'Vendas (receita)', pilar: 'vendas', v: (f) => f.receita, fmt: brl, bomSubir: true, tipo: 'rel' },
        { k: 'pedidos', nome: 'Pedidos', pilar: 'vendas', v: (f) => f.pedidos, fmt: (x) => String(Math.round(x)), bomSubir: true, tipo: 'rel' },
        { k: 'ticket', nome: 'Ticket médio por conta', pilar: 'vendas', v: (f) => f.ticket, fmt: brl, bomSubir: true, tipo: 'rel' },
        { k: 'lucro', nome: 'Resultado (lucro)', pilar: 'margem', v: (f) => (f.cobertura >= 0.5 ? f.lucro : null), fmt: brl, bomSubir: true, tipo: 'abs' },
        { k: 'margem', nome: 'Margem bruta', pilar: 'margem', v: (f) => f.margemBruta, fmt: (x) => pct(x, 1), bomSubir: true, tipo: 'pp' },
        { k: 'despesas', nome: 'Despesas', pilar: 'caixa', v: (f) => f.despesas || null, fmt: brl, bomSubir: false, tipo: 'rel' },
        { k: 'descontos', nome: 'Descontos (% das vendas)', pilar: 'caixa', v: (f) => f.descontosPct, fmt: (x) => pct(x, 1), bomSubir: false, tipo: 'pp' },
        { k: 'cancelamentos', nome: 'Cancelamentos (% do lançado)', pilar: 'caixa', v: (f) => f.cancelPct, fmt: (x) => pct(x, 1), bomSubir: false, tipo: 'pp' },
    ];
    const out = [];
    for (const m of metricas) {
        const atual = m.v(c.cur);
        if (atual == null)
            continue;
        for (const b of bases) {
            if (!b.f)
                continue;
            const ref = m.v(b.f);
            if (ref == null || (m.tipo === 'rel' && ref <= 0))
                continue;
            // rel = variação %; pp = pontos percentuais; abs = diferença em R$ (resultado pode ser negativo)
            const varr = m.tipo === 'rel' ? atual / ref - 1 : m.tipo === 'pp' ? atual - ref : (atual - ref) / Math.max(Math.abs(ref), 1);
            const peso = m.tipo === 'pp' ? varr * 5 : clamp(varr, -1, 1);
            const limiar = m.tipo === 'pp' ? 0.01 : 0.05;
            if (Math.abs(varr) < limiar)
                continue;
            const subiu = varr > 0;
            const bom = subiu === m.bomSubir;
            const forte = m.tipo === 'pp' ? Math.abs(varr) >= 0.02 : Math.abs(varr) >= 0.1;
            const amostraN = c.cur.pedidos;
            const dif = m.tipo === 'rel' ? sPct(varr) : m.tipo === 'pp' ? pp(varr) : `${atual - ref >= 0 ? '+' : '−'}${brl(Math.abs(atual - ref))}`;
            out.push(base({
                id: `CMP.${m.k}.${b.id}`, codigo: m.k, pilar: m.pilar, comparativo: true, variacao: peso,
                sentido: forte ? (bom ? 'POSITIVO' : 'NEGATIVO') : 'OPORTUNIDADE',
                gravidade: clamp(Math.abs(peso) * 2, 0.1, 0.9),
                titulo: `${m.nome} ${subiu ? 'subiu' : 'caiu'}`,
                frase: `${m.nome}: ${m.fmt(atual)} contra ${m.fmt(ref)} ${b.nome} (${dif}).`,
                numero: `${m.fmt(atual)} × ${m.fmt(ref)} (${dif})`,
                amostra: `${amostraN} pedidos no período`, amostraN,
                confianca: confDe(amostraN, LIMIARES.minPedidosMes, c.geral),
                limiar: m.tipo === 'pp' ? 'variação de 1 p.p. ou mais' : 'variação de 5% ou mais',
                metrica: { chave: m.k, antes: atual, unidade: m.tipo === 'pp' ? 'PCT' : m.k === 'pedidos' ? 'UN' : 'BRL' },
            }));
        }
    }
    return out;
}
/** média simples de várias janelas (só os campos usados nos comparativos) */
function media(fs) {
    const avg = (g) => { const v = fs.map(g).filter((x) => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
    return {
        ...fs[0], temDados: true, receita: avg((f) => f.receita), pedidos: avg((f) => f.pedidos), ticket: avg((f) => f.ticket),
        lucro: avg((f) => f.lucro), cobertura: Math.min(...fs.map((f) => f.cobertura)), margemBruta: avg((f) => f.margemBruta),
        despesas: avg((f) => f.despesas), descontosPct: avg((f) => f.descontosPct), cancelPct: avg((f) => f.cancelPct), bruto: avg((f) => f.bruto),
    };
}
/** nenhum detector (fora o fiado) roda com menos de 7 dias com venda no período */
const MIN_DIAS_VENDA = 7;
const DETECTORES = [
    { id: 'CMP', nome: 'Comparativo do mês (anterior, 3 meses, ano anterior)', pilar: 'vendas', limiar: 'variação ≥ 5% (ou ≥ 1 p.p.)', amostraMin: '20 pedidos no mês e mês de comparação com dados', run: comparativos },
    // ---------------- VENDAS E DEMANDA ----------------
    {
        id: 'V01', nome: 'Queda de vendas vs média de 3 meses', pilar: 'vendas', limiar: 'queda de 15% ou mais', amostraMin: `${LIMIARES.minPedidosMes} pedidos e 2 meses de base`,
        run: (c) => {
            if (c.prev3.length < 2)
                return 'SEM_DADOS';
            if (c.cur.pedidos < LIMIARES.minPedidosMes)
                return 'AMOSTRA';
            const ref = c.prev3.reduce((s, f) => s + f.receita, 0) / c.prev3.length;
            if (ref <= 0)
                return 'SEM_DADOS';
            const v = c.cur.receita / ref - 1;
            if (v > -0.15)
                return [];
            const me = margemEst(c);
            return [base({
                    id: 'V01', codigo: 'vendas', pilar: 'vendas', sentido: 'NEGATIVO', gravidade: clamp(-v * 2, 0.3, 1),
                    titulo: 'Vendas abaixo da média dos últimos meses',
                    frase: `As vendas ficaram ${pct(-v)} abaixo da média dos ${c.prev3.length} meses anteriores${c.emCurso ? ` no mesmo período (até o dia ${c.diaCorte})` : ''}.`,
                    numero: `${brl(c.cur.receita)} × média ${brl(ref)}`, amostra: `${c.cur.pedidos} pedidos no mês; base de ${c.prev3.length} meses`, amostraN: c.cur.pedidos,
                    confianca: confDe(c.cur.pedidos, LIMIARES.minPedidosMes, c.geral), limiar: 'queda de 15% ou mais',
                    acao: 'Descobrir em que dia/horário a queda se concentra e atacar com campanha do dia fraco e reativação de clientes.', dono: 'Dono',
                    impacto: imp((ref - c.cur.receita) * c.fatorMes * me.m * 0.5, `recuperar metade da queda (${brl0((ref - c.cur.receita) * c.fatorMes)}/mês) com a ${me.txt}`, 'demanda'),
                    horizonte: 'MEDIO', esforco: 'MEDIO', tecnicas: ['dia_fraco', 'reativacao'],
                    meta: `Voltar as vendas para a média de ${brl0(ref * c.fatorMes)} no mês`, metrica: { chave: 'vendas', antes: c.cur.receita, unidade: 'BRL' },
                })];
        },
    },
    {
        id: 'V02', nome: 'Ticket médio × volume de pedidos', pilar: 'vendas', limiar: 'pedidos ±5% e ticket na direção oposta ±5%', amostraMin: `${LIMIARES.minPedidosMes} contas no mês e no anterior`,
        run: (c) => {
            if (!c.prev?.temDados)
                return 'SEM_DADOS';
            if (c.cur.contas < LIMIARES.minPedidosMes || c.prev.contas < LIMIARES.minPedidosMes || !c.cur.ticket || !c.prev.ticket)
                return 'AMOSTRA';
            const vv = c.cur.contas / c.prev.contas - 1, vt = c.cur.ticket / c.prev.ticket - 1;
            const me = margemEst(c);
            const conf = confDe(c.cur.contas, LIMIARES.minPedidosMes, c.geral);
            if (vv >= 0.05 && vt <= -0.05) {
                return [base({
                        id: 'V02', codigo: 'ticket', pilar: 'vendas', sentido: 'NEGATIVO', gravidade: clamp(-vt * 3, 0.3, 0.9),
                        titulo: 'Mais clientes, mas cada um gasta menos',
                        frase: `O número de contas subiu ${pct(vv)}, mas o ticket médio caiu ${pct(-vt)} (de ${brl(c.prev.ticket)} para ${brl(c.cur.ticket)}).`,
                        numero: `ticket ${brl(c.cur.ticket)} (${sPct(vt)})`, amostra: `${c.cur.contas} contas × ${c.prev.contas} no mês anterior`, amostraN: c.cur.contas, confianca: conf,
                        limiar: 'pedidos +5% e ticket −5% ou mais', acao: 'Venda sugestiva no caixa (uma frase pronta por tipo de pedido) e meta de ticket para a equipe.', dono: 'Caixa',
                        impacto: imp((c.prev.ticket - c.cur.ticket) * c.cur.contas * c.fatorMes * me.m * 0.5, `recuperar metade da queda do ticket nas ${Math.round(c.cur.contas * c.fatorMes)} contas/mês, com a ${me.txt}`, 'demanda'),
                        horizonte: 'CURTO', esforco: 'BAIXO', tecnicas: ['venda_sugestiva', 'meta_ticket'],
                        meta: `Ticket médio de ${brl(c.cur.ticket)} para ${brl(Math.round(c.cur.ticket * 1.05))}`, metrica: { chave: 'ticket', antes: c.cur.ticket, unidade: 'BRL' },
                    })];
            }
            if (vv <= -0.05 && vt >= 0.05) {
                return [base({
                        id: 'V02', codigo: 'pedidos', pilar: 'vendas', sentido: 'NEGATIVO', gravidade: clamp(-vv * 3, 0.3, 0.9),
                        titulo: 'Menos clientes, cada um gastando mais',
                        frase: `O ticket médio subiu ${pct(vt)}, mas o número de contas caiu ${pct(-vv)} (${c.cur.contas} contra ${c.prev.contas}).`,
                        numero: `${c.cur.contas} contas (${sPct(vv)})`, amostra: `${c.cur.contas} contas × ${c.prev.contas}`, amostraN: c.cur.contas, confianca: conf,
                        limiar: 'pedidos −5% e ticket +5% ou mais', acao: 'Trazer movimento: reativar clientes que sumiram e divulgar o cardápio digital nos dias fracos.', dono: 'Dono',
                        impacto: imp((c.prev.contas - c.cur.contas) * c.cur.ticket * c.fatorMes * me.m * 0.5, `recuperar metade das contas perdidas com o ticket atual e a ${me.txt}`, 'demanda'),
                        horizonte: 'MEDIO', esforco: 'MEDIO', tecnicas: ['reativacao', 'dia_fraco'],
                        meta: `Voltar a ${c.prev.contas} contas no mês`, metrica: { chave: 'contas', antes: c.cur.contas, unidade: 'UN' },
                    })];
            }
            return [];
        },
    },
    {
        id: 'V03', nome: 'Dia da semana fraco', pilar: 'vendas', limiar: `< ${pct(LIMIARES.diaFraco)} da média dos outros dias abertos`, amostraMin: '2 ocorrências do dia e 4 dias da semana abertos',
        run: (c) => {
            const porDow = new Map();
            for (const d of c.x.porDia) {
                const w = new Date(d.dia + 'T12:00:00Z').getUTCDay();
                const a = porDow.get(w) ?? [];
                a.push(d.bruto);
                porDow.set(w, a);
            }
            const ok = [...porDow.entries()].filter(([, a]) => a.length >= 2);
            if (ok.length < 4)
                return c.x.porDia.length ? 'AMOSTRA' : 'SEM_DADOS';
            const medias = ok.map(([w, a]) => ({ w, m: a.reduce((s, x) => s + x, 0) / a.length, n: a.length }));
            const pior = [...medias].sort((a, b) => a.m - b.m)[0];
            const outros = medias.filter((x) => x.w !== pior.w);
            const mo = outros.reduce((s, x) => s + x.m, 0) / outros.length;
            if (pior.m >= mo * LIMIARES.diaFraco)
                return [];
            const me = margemEst(c);
            const ganho = (mo * 0.75 - pior.m) * (30 / 7) * me.m;
            return [base({
                    id: 'V03', codigo: `dia:${pior.w}`, pilar: 'vendas', sentido: 'NEGATIVO', gravidade: clamp(1 - pior.m / mo, 0.3, 0.8),
                    titulo: `${DIAS_PL[pior.w][0].toUpperCase() + DIAS_PL[pior.w].slice(1)} fracas`,
                    frase: `As ${DIAS_PL[pior.w]} vendem em média ${brl(pior.m)}, só ${pct(pior.m / mo)} da média dos outros dias abertos (${brl(mo)}).`,
                    numero: `${brl(pior.m)} × ${brl(mo)} (${pct(pior.m / mo)})`, amostra: `${pior.n} ${DIAS_PL[pior.w]} e ${c.x.porDia.length} dias com venda`, amostraN: pior.n,
                    confianca: confDe(pior.n, 2, c.geral), limiar: `abaixo de ${pct(LIMIARES.diaFraco)} da média`,
                    acao: `Criar uma oferta só das ${DIAS_PL[pior.w]} (prato do dia/combo) e divulgar na véspera; ajustar a escala nesse dia.`, dono: 'Dono',
                    impacto: imp(ganho, `levar as ${DIAS_PL[pior.w]} a 75% da média dos outros dias (≈4,3 por mês) com a ${me.txt}`, 'demanda'),
                    horizonte: 'MEDIO', esforco: 'MEDIO', tecnicas: ['dia_fraco', 'escala_pico'],
                    meta: `${DIAS_PL[pior.w][0].toUpperCase() + DIAS_PL[pior.w].slice(1)} de ${brl0(pior.m)} para ${brl0(mo * 0.75)} em média`, metrica: { chave: `dia:${pior.w}`, antes: Math.round(pior.m), unidade: 'BRL' },
                })];
        },
    },
    {
        id: 'V04', nome: 'Horas paradas e horas cheias', pilar: 'vendas', limiar: '3 horas seguidas concentram 50%+ dos pedidos', amostraMin: '100 pedidos',
        run: (c) => {
            const tot = c.x.porHora.reduce((s, h) => s + h.n, 0);
            if (tot < 100)
                return tot ? 'AMOSTRA' : 'SEM_DADOS';
            const arr = Array.from({ length: 24 }, (_, h) => c.x.porHora.find((x) => x.h === h)?.n ?? 0);
            let best = 0, ini = 0;
            for (let h = 0; h <= 21; h++) {
                const s = arr[h] + arr[h + 1] + arr[h + 2];
                if (s > best) {
                    best = s;
                    ini = h;
                }
            }
            const share = best / tot;
            if (share < 0.5)
                return [];
            const abertas = arr.map((v, h) => ({ v, h })).filter((x) => x.v > 0);
            const paradas = abertas.filter((x) => x.v < (best / 3) * 0.25).map((x) => `${x.h}h`);
            return [base({
                    id: 'V04', codigo: 'horas', pilar: 'vendas', sentido: 'OPORTUNIDADE', gravidade: 0.35,
                    titulo: 'Movimento concentrado em poucas horas',
                    frase: `${pct(share)} dos pedidos acontecem entre ${ini}h e ${ini + 3}h${paradas.length ? `; ${paradas.slice(0, 4).join(', ')} quase sem pedidos` : ''}.`,
                    numero: `${pct(share)} dos pedidos em 3 horas`, amostra: `${tot} pedidos`, amostraN: tot, confianca: confDe(tot, 100, c.geral),
                    limiar: '50% ou mais dos pedidos em 3 horas', acao: `Reforçar a equipe 30 min antes das ${ini}h e usar as horas paradas para pré-preparo.`, dono: 'Dono',
                    horizonte: 'MEDIO', esforco: 'BAIXO', tecnicas: ['escala_pico'],
                })];
        },
    },
    {
        id: 'V05', nome: 'Clientes novos × recorrentes', pilar: 'vendas', limiar: 'recorrentes ≥ 50% (positivo) ou < 25% (negativo)', amostraMin: '20 clientes identificados no mês',
        run: (c) => {
            const noMes = c.x.clientes.filter((k) => k.noMes);
            if (noMes.length < 20)
                return c.x.clientes.length ? 'AMOSTRA' : 'SEM_DADOS';
            const novos = noMes.filter((k) => k.primeiro >= c.cur.from).length;
            const rec = noMes.length - novos;
            const share = rec / noMes.length;
            const conf = confDe(noMes.length, 20, c.geral);
            if (share >= 0.5)
                return [base({
                        id: 'V05', codigo: 'clientes', pilar: 'vendas', sentido: 'POSITIVO', gravidade: 0.4, titulo: 'Base fiel de clientes',
                        frase: `${pct(share)} dos clientes identificados no mês já tinham comprado antes (${rec} recorrentes, ${novos} novos).`,
                        numero: `${pct(share)} recorrentes`, amostra: `${noMes.length} clientes identificados`, amostraN: noMes.length, confianca: conf, limiar: '50% ou mais recorrentes',
                    })];
            if (share < 0.25)
                return [base({
                        id: 'V05', codigo: 'clientes', pilar: 'vendas', sentido: 'NEGATIVO', gravidade: 0.45, titulo: 'Pouca recompra',
                        frase: `Só ${pct(share)} dos clientes identificados no mês voltaram a comprar (${rec} de ${noMes.length}).`,
                        numero: `${pct(share)} recorrentes`, amostra: `${noMes.length} clientes identificados`, amostraN: noMes.length, confianca: conf, limiar: 'menos de 25% recorrentes',
                        acao: 'Pedir o WhatsApp com consentimento de ofertas e fazer um convite de volta em 15 dias.', dono: 'Caixa', horizonte: 'MEDIO', esforco: 'BAIXO', tecnicas: ['reativacao'],
                    })];
            return [];
        },
    },
    {
        id: 'V06', nome: 'Clientes que sumiram', pilar: 'vendas', limiar: 'sem pedido há 2× o intervalo habitual (mín. 21 dias)', amostraMin: '5 clientes sumidos (com 3+ visitas)',
        run: (c) => {
            const ref = c.cur.to;
            const freq = c.x.clientes.filter((k) => k.dias >= 3);
            if (!freq.length)
                return 'SEM_DADOS';
            const sumidos = freq.filter((k) => {
                const intervalo = diasEntre(k.primeiro, k.ultimo) / (k.dias - 1);
                const sem = diasEntre(k.ultimo, ref);
                return sem >= Math.max(21, 2 * intervalo) && sem <= 180;
            });
            if (sumidos.length < 5)
                return sumidos.length ? 'AMOSTRA' : [];
            const ofertas = sumidos.filter((k) => k.ofertas).length;
            const gastoMes = sumidos.reduce((s, k) => s + k.gasto180 / 6, 0);
            const me = margemEst(c);
            return [base({
                    id: 'V06', codigo: 'clientes.sumidos', pilar: 'vendas', sentido: 'NEGATIVO', gravidade: clamp(sumidos.length / 40, 0.3, 0.8),
                    titulo: 'Clientes frequentes que pararam de vir',
                    frase: `${sumidos.length} clientes que vinham com frequência estão sem pedido há mais que o dobro do intervalo habitual; ${ofertas} aceitaram receber ofertas.`,
                    numero: `${sumidos.length} sumidos (${ofertas} com consentimento)`, amostra: `${freq.length} clientes com 3+ visitas`, amostraN: sumidos.length,
                    confianca: confDe(sumidos.length, 5, c.geral), limiar: 'sem pedido há 2× o intervalo habitual e 21+ dias',
                    acao: ofertas ? `Mandar uma mensagem pessoal de reativação para os ${ofertas} que aceitaram ofertas (envio feito por uma pessoa).` : 'Passar a pedir o consentimento de ofertas no caixa: hoje nenhum sumido pode ser contatado.', dono: 'Dono',
                    impacto: ofertas ? imp((gastoMes * (ofertas / sumidos.length)) * 0.2 * me.m, `20% dos ${ofertas} com consentimento voltam a gastar a média mensal que gastavam, com a ${me.txt}`, 'demanda') : null,
                    horizonte: 'CURTO', esforco: 'BAIXO', tecnicas: ['reativacao'],
                    meta: `Trazer de volta ${Math.max(1, Math.round(ofertas * 0.2))} clientes em 30 dias`, metrica: { chave: 'clientes.sumidos', antes: sumidos.length, unidade: 'UN' },
                })];
        },
    },
    {
        id: 'V07', nome: 'Peso do cardápio online', pilar: 'vendas', limiar: '< 10% (negativo, com cardápio ligado) ou ≥ 25% (positivo)', amostraMin: '100 pedidos',
        run: (c) => {
            const tot = Object.values(c.x.origem).reduce((s, x) => s + x, 0);
            if (tot < 100)
                return tot ? 'AMOSTRA' : 'SEM_DADOS';
            const online = tot - (c.x.origem.CAIXA ?? 0);
            const share = online / tot;
            const conf = confDe(tot, 100, c.geral);
            if (share >= 0.25)
                return [base({ id: 'V07', codigo: 'online', pilar: 'vendas', sentido: 'POSITIVO', gravidade: 0.35, titulo: 'Cardápio online forte', frase: `${pct(share)} dos pedidos chegaram pelo cardápio online/WhatsApp/entrega.`, numero: `${online} de ${tot} pedidos`, amostra: `${tot} pedidos`, amostraN: tot, confianca: conf, limiar: '25% ou mais dos pedidos' })];
            if (c.x.qrLigado && share < 0.1)
                return [base({
                        id: 'V07', codigo: 'online', pilar: 'vendas', sentido: 'OPORTUNIDADE', gravidade: 0.3, titulo: 'Cardápio online pouco usado',
                        frase: `Só ${pct(share)} dos pedidos vieram pelo cardápio online, que está ligado.`, numero: `${online} de ${tot} pedidos`, amostra: `${tot} pedidos`, amostraN: tot, confianca: conf,
                        limiar: 'menos de 10% com o cardápio ligado', acao: 'Divulgar o QR/link do cardápio nas mesas e no grupo de clientes; confirmar pedidos online em até 3 minutos.', dono: 'Dono',
                        horizonte: 'LONGO', esforco: 'BAIXO', tecnicas: ['canal_digital'], meta: `Online de ${pct(share)} para ${pct(Math.max(0.1, share + 0.05))}`, metrica: { chave: 'online', antes: share, unidade: 'PCT' },
                    })];
            return [];
        },
    },
    {
        id: 'V08', nome: 'Pedidos recusados', pilar: 'vendas', limiar: '3+ recusas e 5%+ dos pedidos online', amostraMin: '20 pedidos online',
        run: (c) => {
            const online = Object.entries(c.x.origem).filter(([k]) => k !== 'CAIXA').reduce((s, [, v]) => s + v, 0) + c.cur.recusados;
            if (online < 20)
                return online ? 'AMOSTRA' : 'SEM_DADOS';
            if (c.cur.recusados < 3 || c.cur.recusados / online < 0.05)
                return [];
            const me = margemEst(c);
            return [base({
                    id: 'V08', codigo: 'recusados', pilar: 'vendas', sentido: 'NEGATIVO', gravidade: 0.5, titulo: 'Pedidos online recusados',
                    frase: `${c.cur.recusados} pedidos online foram recusados (${pct(c.cur.recusados / online)} do online), somando ${brl(c.cur.recusadoCents)}${c.cur.motivosRecusa.length ? `; motivo mais comum: "${c.cur.motivosRecusa[0].motivo}"` : ''}.`,
                    numero: `${c.cur.recusados} recusas (${brl(c.cur.recusadoCents)})`, amostra: `${online} pedidos online`, amostraN: online, confianca: confDe(online, 20, c.geral),
                    limiar: '3+ recusas e 5%+ do online', acao: 'Marcar "acabou" no cardápio na hora em que o item acaba e combinar o horário de corte da cozinha.', dono: 'Caixa',
                    impacto: imp(c.cur.recusadoCents * c.fatorMes * me.m * 0.5, `metade das recusas vira venda, com a ${me.txt}`, 'recusas'),
                    horizonte: 'CURTO', esforco: 'BAIXO', tecnicas: ['canal_digital'], meta: `Recusas de ${c.cur.recusados} para no máximo ${Math.floor(c.cur.recusados / 2)}`, metrica: { chave: 'recusados', antes: c.cur.recusados, unidade: 'UN' },
                })];
        },
    },
    // ---------------- MARGEM E PREÇO ----------------
    {
        id: 'M01', nome: 'Produto de alto volume com margem abaixo da meta', pilar: 'margem', limiar: `margem < ${pct(LIMIARES.metaMargem)} e venda acima da média`, amostraMin: `${LIMIARES.minItensProduto} unidades com custo`,
        run: (c) => {
            const comCusto = c.x.produtos.filter((p) => p.id != null && p.qtdComCusto > 0 && p.preco && p.custoAtual != null);
            if (!comCusto.length)
                return 'SEM_DADOS';
            const mediaQtd = comCusto.reduce((s, p) => s + p.qtd, 0) / comCusto.length;
            const cand = comCusto.filter((p) => p.qtdComCusto >= LIMIARES.minItensProduto && p.qtd >= mediaQtd && (p.preco - p.custoAtual) / p.preco < LIMIARES.metaMargem);
            if (!cand.length)
                return comCusto.some((p) => p.qtdComCusto >= LIMIARES.minItensProduto) ? [] : 'AMOSTRA';
            return cand.map((p) => {
                const preco = p.preco, custo = p.custoAtual, m = (preco - custo) / preco;
                const novo = precoSugerido(preco, custo, LIMIARES.metaMargem);
                const qMes = p.qtd * c.fatorMes;
                const ganho = (novo - custo) * qMes * 0.95 - (preco - custo) * qMes;
                return base({
                    id: 'M01', codigo: `produto:${p.id}`, pilar: 'margem', sentido: 'NEGATIVO', gravidade: clamp((LIMIARES.metaMargem - m) * 3, 0.3, 0.9),
                    titulo: `${p.name}: vende muito com margem baixa`,
                    frase: `${p.name} vendeu ${p.qtd} unidades com margem de ${pct(m)} (meta ${pct(LIMIARES.metaMargem)}). Subir para ${brl(novo)} leva a margem a ${pct((novo - custo) / novo)}.`,
                    numero: `margem ${pct(m)} · ${p.qtd} un.`, amostra: `${p.qtdComCusto} unidades com custo no mês`, amostraN: p.qtdComCusto,
                    confianca: confDe(p.qtdComCusto, LIMIARES.minItensProduto, c.geral), limiar: `margem abaixo de ${pct(LIMIARES.metaMargem)} e venda acima da média`,
                    acao: `${p.name}: subir o preço de ${brl(preco)} para ${brl(novo)} ou reduzir o custo da porção.`, dono: 'Dono',
                    impacto: imp(ganho, `preço de ${brl(preco)} → ${brl(novo)} com queda de 5% no volume (${Math.round(qMes)} un./mês); custo atual ${brl(custo)}`, `margem:${p.cat}`),
                    horizonte: 'CURTO', esforco: 'BAIXO', tecnicas: ['engenharia_cardapio', 'controle_cmv'],
                    meta: `Preço de ${brl(preco)} para ${brl(novo)}; vendas do item caindo no máximo 5%`,
                    metrica: { chave: `produto:${p.id}`, antes: { preco: Math.round(p.receita / p.qtd), qtd: p.qtd, lucro: p.custo != null ? p.receitaComCusto - p.custo : 0 }, unidade: 'PRODUTO' },
                });
            }).sort((a, b) => (b.impacto?.centsMes ?? 0) - (a.impacto?.centsMes ?? 0)).slice(0, 5);
        },
    },
    {
        id: 'M02', nome: 'Custo de compra subiu sem repasse no preço', pilar: 'margem', limiar: 'custo +10% ou mais em até 150 dias e preço subiu menos (em R$) que o custo', amostraMin: '2 registros de custo e 5 unidades vendidas no mês',
        run: (c) => {
            const porProd = new Map();
            for (const k of c.x.custos) {
                const a = porProd.get(k.pid) ?? [];
                a.push(k);
                porProd.set(k.pid, a);
            }
            if (!porProd.size)
                return 'SEM_DADOS';
            const out = [];
            let algumComAmostra = false;
            for (const [pid, serie] of porProd) {
                const p = c.x.produtos.find((x) => x.id === pid);
                const antes = c.x.custoAntes.get(pid) ?? serie[0].custo;
                const agora = serie[serie.length - 1].custo;
                const pontos = serie.length + (c.x.custoAntes.has(pid) ? 1 : 0);
                if (!p || pontos < 2 || p.qtd < 5)
                    continue;
                algumComAmostra = true;
                if (antes <= 0 || agora / antes - 1 < 0.1)
                    continue;
                const pr = c.x.precos.get(pid);
                const precoAntes = pr?.antes ?? null;
                const precoAgora = pr?.agora ?? p.preco ?? null;
                const dCusto = agora - antes;
                const dPreco = precoAntes != null && precoAgora != null ? precoAgora - precoAntes : 0;
                if (dPreco >= dCusto)
                    continue;
                const qMes = p.qtd * c.fatorMes;
                const dias = diasEntre(c.x.custoAntes.has(pid) ? addDias(c.cur.to, -150) : serie[0].dia, serie[serie.length - 1].dia);
                out.push(base({
                    id: 'M02', codigo: `produto:${pid}`, pilar: 'margem', sentido: 'NEGATIVO', gravidade: clamp((agora / antes - 1) * 2, 0.4, 1),
                    titulo: `${p.name}: custo subiu e o preço não acompanhou`,
                    frase: `${p.name}: custo ${sPct(agora / antes - 1)} em ${Math.max(dias, 1)} dias (${brl(antes)} → ${brl(agora)}), preço ${dPreco > 0 ? `só +${brl(dPreco)}` : 'igual'} → −${brl0((dCusto - dPreco) * qMes)}/mês.`,
                    numero: `custo ${sPct(agora / antes - 1)}; preço ${dPreco > 0 ? '+' + brl(dPreco) : 'igual'}`, amostra: `${pontos} registros de custo; ${p.qtd} unidades no mês`, amostraN: p.qtd,
                    confianca: confDe(p.qtd, 5, c.geral), limiar: 'custo +10% e preço subiu menos que o custo (em R$)',
                    acao: `${p.name}: repassar a alta subindo o preço em pelo menos ${brl(Math.ceil((dCusto - dPreco) / 50) * 50)} ou cotar outro fornecedor.`, dono: 'Dono',
                    impacto: imp((dCusto - dPreco) * qMes, `${dPreco > 0 ? `alta do custo (${brl(dCusto)}) menos a do preço (${brl(dPreco)})` : `alta do custo (${brl(dCusto)}), preço não subiu`} × ${Math.round(qMes)} un./mês`, `margem:${p.cat}`),
                    horizonte: 'CURTO', esforco: 'BAIXO', tecnicas: ['controle_cmv', 'cotacao'],
                    meta: `Preço de ${p.name} +${brl(Math.ceil((dCusto - dPreco) / 50) * 50)}; margem do item de volta ao nível anterior`,
                    metrica: { chave: `produto:${pid}`, antes: { preco: Math.round(p.receita / p.qtd), qtd: p.qtd, lucro: p.custo != null ? p.receitaComCusto - p.custo : 0 }, unidade: 'PRODUTO' },
                }));
            }
            if (!out.length && !algumComAmostra)
                return 'AMOSTRA';
            return out.sort((a, b) => (b.impacto?.centsMes ?? 0) - (a.impacto?.centsMes ?? 0));
        },
    },
    {
        id: 'M03', nome: 'Produtos vendidos sem custo cadastrado', pilar: 'margem', limiar: '10% ou mais da venda sem custo', amostraMin: '30 itens vendidos',
        run: (c) => {
            if (c.cur.itens < 30)
                return c.cur.itens ? 'AMOSTRA' : 'SEM_DADOS';
            const sem = 1 - c.cur.cobertura;
            if (sem < 0.1)
                return c.cur.cobertura >= 0.98 ? [base({ id: 'M03', codigo: 'custo.cadastro', pilar: 'margem', sentido: 'POSITIVO', gravidade: 0.3, titulo: 'Custo cadastrado em quase tudo', frase: `${pct(c.cur.cobertura)} do valor vendido tem custo cadastrado: a margem calculada é confiável.`, numero: `${pct(c.cur.cobertura)} com custo`, amostra: `${c.cur.itens} itens`, amostraN: c.cur.itens, confianca: confDe(c.cur.itens, 30, c.geral), limiar: '98% ou mais com custo' })] : [];
            const nomes = c.x.produtos.filter((p) => p.qtd - p.qtdComCusto > 0).sort((a, b) => (b.receita - b.receitaComCusto) - (a.receita - a.receitaComCusto)).slice(0, 3).map((p) => p.name);
            return [base({
                    id: 'M03', codigo: 'custo.cadastro', pilar: 'margem', sentido: 'NEGATIVO', gravidade: clamp(sem * 1.5, 0.3, 0.9), titulo: 'Vendas sem custo: margem real desconhecida',
                    frase: `${pct(sem)} do valor vendido não tem custo cadastrado${nomes.length ? ` (principais: ${nomes.join(', ')})` : ''}. A margem desses itens é desconhecida.`,
                    numero: `${pct(sem)} sem custo`, amostra: `${c.cur.itens} itens vendidos`, amostraN: c.cur.itens, confianca: confDe(c.cur.itens, 30, c.geral), limiar: '10% ou mais sem custo',
                    acao: 'Cadastrar o custo dos itens sem custo (começar pelos que mais vendem).', dono: 'Dono', horizonte: 'CURTO', esforco: 'BAIXO', tecnicas: ['controle_cmv', 'ficha_tecnica'],
                    meta: `Venda sem custo de ${pct(sem)} para menos de 5%`, metrica: { chave: 'semCusto', antes: sem, unidade: 'PCT' },
                })];
        },
    },
    {
        id: 'M04', nome: 'Dependência de poucos itens no lucro', pilar: 'margem', limiar: '2 itens ou menos fazem 80% do lucro', amostraMin: '8 produtos com custo vendidos',
        run: (c) => {
            const ps = c.x.produtos.filter((p) => p.custo != null && p.qtdComCusto > 0).map((p) => ({ name: p.name, lucro: p.receitaComCusto - p.custo })).filter((p) => p.lucro > 0).sort((a, b) => b.lucro - a.lucro);
            if (ps.length < 8)
                return ps.length ? 'AMOSTRA' : 'SEM_DADOS';
            const tot = ps.reduce((s, p) => s + p.lucro, 0);
            let acc = 0, k = 0;
            for (const p of ps) {
                acc += p.lucro;
                k++;
                if (acc >= tot * 0.8)
                    break;
            }
            if (k > 2)
                return [];
            return [base({
                    id: 'M04', codigo: 'dependencia', pilar: 'margem', sentido: 'NEGATIVO', gravidade: 0.45, titulo: 'Lucro dependente de poucos itens',
                    frase: `${k === 1 ? `Só ${ps[0].name} faz` : `${ps[0].name} e ${ps[1].name} fazem`} 80% do lucro bruto do mês. Se faltar ou o custo subir, o mês inteiro sente.`,
                    numero: `${k} item(ns) = 80% do lucro`, amostra: `${ps.length} produtos com custo`, amostraN: ps.length, confianca: confDe(ps.length, 8, c.geral), limiar: '2 itens ou menos = 80% do lucro',
                    acao: 'Garantir estoque e fornecedor reserva desses itens e promover itens Quebra-cabeça para diluir a dependência.', dono: 'Dono', horizonte: 'LONGO', esforco: 'MEDIO', tecnicas: ['curva_abc_estoque', 'engenharia_cardapio'],
                })];
        },
    },
    {
        id: 'M05', nome: 'Itens Abacaxi e Quebra-cabeça (engenharia de cardápio)', pilar: 'margem', limiar: 'matriz popularidade × margem (Módulo B)', amostraMin: '6 produtos com custo e 100 itens vendidos',
        run: (c) => {
            const mx = matriz(c);
            if (!mx)
                return c.cur.itens ? 'AMOSTRA' : 'SEM_DADOS';
            const out = [];
            const abac = mx.itens.filter((i) => i.quadrante === 'ABACAXI');
            const qc = mx.itens.filter((i) => i.quadrante === 'QUEBRA_CABECA');
            const conf = confDe(mx.totalQtd, 100, c.geral);
            if (abac.length)
                out.push(base({
                    id: 'M05', codigo: 'cardapio.abacaxi', pilar: 'margem', sentido: 'NEGATIVO', gravidade: clamp(abac.length / 8, 0.25, 0.6), titulo: `${abac.length} item(ns) Abacaxi no cardápio`,
                    frase: `${abac.slice(0, 4).map((i) => i.name).join(', ')}${abac.length > 4 ? '…' : ''}: vendem pouco e têm margem abaixo da meta.`,
                    numero: `${abac.length} Abacaxi`, amostra: `${mx.itens.length} produtos com custo; ${mx.totalQtd} itens`, amostraN: mx.totalQtd, confianca: conf, limiar: 'pouco popular e margem abaixo da meta',
                    acao: 'Rever a receita/porção ou retirar do cardápio (menos estoque parado e cozinha mais simples).', dono: 'Dono', horizonte: 'MEDIO', esforco: 'MEDIO', tecnicas: ['engenharia_cardapio'],
                }));
            if (qc.length) {
                const ganho = qc.reduce((s, i) => s + i.qtd * 0.2 * (i.preco - i.custo), 0) * c.fatorMes;
                out.push(base({
                    id: 'M05', codigo: 'cardapio.quebracabeca', pilar: 'margem', sentido: 'OPORTUNIDADE', gravidade: 0.4, titulo: `${qc.length} item(ns) com boa margem que vendem pouco`,
                    frase: `${qc.slice(0, 4).map((i) => i.name).join(', ')}${qc.length > 4 ? '…' : ''} têm margem acima da meta, mas vendem abaixo da média.`,
                    numero: `${qc.length} Quebra-cabeça`, amostra: `${mx.itens.length} produtos com custo; ${mx.totalQtd} itens`, amostraN: mx.totalQtd, confianca: conf, limiar: 'pouco popular e margem acima da meta',
                    acao: 'Destacar no cardápio, sugerir no caixa e usar em combos.', dono: 'Caixa',
                    impacto: imp(ganho, 'cada item Quebra-cabeça vende 20% a mais com a margem unitária atual', 'cardapio.quebracabeca'),
                    horizonte: 'MEDIO', esforco: 'BAIXO', tecnicas: ['engenharia_cardapio', 'venda_sugestiva', 'combos'],
                }));
            }
            return out;
        },
    },
    {
        id: 'M06', nome: 'Categoria com margem caindo', pilar: 'margem', limiar: 'queda de 5 p.p. ou mais vs mês anterior', amostraMin: '30 itens com custo na categoria nos dois meses',
        run: (c) => {
            if (!c.prev?.temDados)
                return 'SEM_DADOS';
            const out = [];
            let algum = false;
            for (const k of c.cur.categorias) {
                const p = c.prev.categorias.find((x) => x.cat === k.cat);
                if (!p || k.qtd < 30 || p.qtd < 30 || k.receita <= 0 || p.receita <= 0)
                    continue;
                algum = true;
                const ma = (k.receita - k.custo) / k.receita, mb = (p.receita - p.custo) / p.receita;
                if (mb - ma < 0.05)
                    continue;
                out.push(base({
                    id: 'M06', codigo: `categoria:${k.cat}`, pilar: 'margem', sentido: 'NEGATIVO', gravidade: clamp((mb - ma) * 5, 0.3, 0.9), titulo: `Margem de ${k.cat} caiu`,
                    frase: `A margem de ${k.cat} caiu de ${pct(mb, 1)} para ${pct(ma, 1)} (${pp(ma - mb)}).`, numero: `${pct(ma, 1)} (${pp(ma - mb)})`,
                    amostra: `${k.qtd} itens com custo × ${p.qtd} no mês anterior`, amostraN: k.qtd, confianca: confDe(k.qtd, 30, c.geral), limiar: 'queda de 5 p.p. ou mais',
                    acao: `Conferir os custos de ${k.cat} item a item e reprecificar o que subiu.`, dono: 'Dono',
                    impacto: imp((mb - ma) * k.receita * c.fatorMes, `voltar à margem do mês anterior sobre a receita de ${k.cat} (${brl0(k.receita * c.fatorMes)}/mês)`, `margem:${k.cat}`),
                    horizonte: 'CURTO', esforco: 'BAIXO', tecnicas: ['controle_cmv'], meta: `Margem de ${k.cat} de volta a ${pct(mb)}`, metrica: { chave: `categoria:${k.cat}`, antes: ma, unidade: 'PCT' },
                }));
            }
            return out.length ? out : algum ? [] : 'AMOSTRA';
        },
    },
    {
        id: 'M07', nome: 'Pares de produtos que viram combo', pilar: 'margem', limiar: 'par no mesmo pedido em 8+ pedidos', amostraMin: '50 pedidos',
        run: (c) => {
            if (c.cur.pedidos < 50)
                return c.cur.pedidos ? 'AMOSTRA' : 'SEM_DADOS';
            const p = c.x.pares[0];
            if (!p || p.juntos < 8)
                return [];
            const na = c.x.pedidosCom.get(p.a) ?? 0, nb = c.x.pedidosCom.get(p.b) ?? 0;
            const [semB, alvo, prodB] = na - p.juntos >= nb - p.juntos ? [na - p.juntos, p.nb, c.x.produtos.find((x) => x.id === p.b)] : [nb - p.juntos, p.na, c.x.produtos.find((x) => x.id === p.a)];
            const margUnit = prodB && prodB.preco != null && prodB.custoAtual != null ? prodB.preco - prodB.custoAtual : prodB?.preco ? prodB.preco * margemEst(c).m : 0;
            return [base({
                    id: 'M07', codigo: `combo:${p.a}-${p.b}`, pilar: 'margem', sentido: 'OPORTUNIDADE', gravidade: 0.35, titulo: `Combo natural: ${p.na} + ${p.nb}`,
                    frase: `${p.na} e ${p.nb} saíram juntos em ${p.juntos} pedidos; em ${semB} pedidos só um dos dois foi pedido (sem ${alvo}).`,
                    numero: `${p.juntos} pedidos juntos`, amostra: `${c.cur.pedidos} pedidos`, amostraN: p.juntos, confianca: confDe(p.juntos, 8, c.geral), limiar: '8+ pedidos com o par',
                    acao: `Montar o combo ${p.na} + ${p.nb} com desconto pequeno e sugerir ${alvo} a quem pede só o outro.`, dono: 'Caixa',
                    impacto: imp(semB * 0.1 * margUnit * c.fatorMes, `10% dos ${semB} pedidos sem ${alvo} passam a levar o item, com a margem unitária dele`, `combo`),
                    horizonte: 'MEDIO', esforco: 'BAIXO', tecnicas: ['combos', 'venda_sugestiva'],
                })];
        },
    },
    {
        id: 'M08', nome: 'Margem bruta geral vs meta', pilar: 'margem', limiar: `≥ meta (${pct(LIMIARES.metaMargem)}) positivo; < meta − 10 p.p. negativo`, amostraMin: '50% das vendas com custo',
        run: (c) => {
            if (c.cur.margemBruta == null)
                return c.cur.bruto ? 'AMOSTRA' : 'SEM_DADOS';
            const m = c.cur.margemBruta;
            const comum = { codigo: 'margem', pilar: 'margem', numero: `margem bruta ${pct(m, 1)}`, amostra: `${pct(c.cur.cobertura)} das vendas com custo; ${c.cur.itens} itens`, amostraN: c.cur.itens, confianca: confDe(c.cur.itens, 30, menorConf(c.geral, c.cur.cobertura >= 0.8 ? 'ALTA' : 'MEDIA')) };
            if (m >= LIMIARES.metaMargem)
                return [base({ ...comum, id: 'M08', sentido: 'POSITIVO', gravidade: 0.5, titulo: 'Margem bruta acima da meta', frase: `A margem bruta do mês foi ${pct(m, 1)}, acima da meta de ${pct(LIMIARES.metaMargem)}.`, limiar: `margem ≥ ${pct(LIMIARES.metaMargem)}` })];
            if (m < LIMIARES.metaMargem - 0.1)
                return [base({ ...comum, id: 'M08', sentido: 'NEGATIVO', gravidade: clamp((LIMIARES.metaMargem - m) * 3, 0.4, 0.9), titulo: 'Margem bruta baixa', frase: `A margem bruta do mês foi ${pct(m, 1)}, mais de 10 p.p. abaixo da meta de ${pct(LIMIARES.metaMargem)}.`, limiar: `margem < ${pct(LIMIARES.metaMargem - 0.1)}`, acao: 'Revisar preços e custos dos itens que mais vendem (engenharia de cardápio).', dono: 'Dono', horizonte: 'MEDIO', esforco: 'MEDIO', tecnicas: ['engenharia_cardapio', 'controle_cmv'], meta: `Margem bruta de ${pct(m)} para ${pct(Math.min(LIMIARES.metaMargem, m + 0.05))}`, metrica: { chave: 'margem', antes: m, unidade: 'PCT' } })];
            return [];
        },
    },
    // ---------------- CAIXA E CONTROLE ----------------
    {
        id: 'C01', nome: 'Descontos acima do normal', pilar: 'caixa', limiar: `> ${pct(LIMIARES.descontoLimite)} das vendas ou 1,5× a média de 3 meses`, amostraMin: 'R$ 1.000 em vendas',
        run: (c) => {
            if (c.cur.bruto < 100_000)
                return c.cur.bruto ? 'AMOSTRA' : 'SEM_DADOS';
            const p = c.cur.descontosPct ?? 0;
            const m3 = c.prev3.filter((f) => f.descontosPct != null && f.bruto > 0);
            const ref = m3.length ? m3.reduce((s, f) => s + f.descontosPct, 0) / m3.length : null;
            const acima = p > LIMIARES.descontoLimite || (ref != null && ref > 0 && p > ref * 1.5 && p > 0.015);
            if (!acima)
                return p <= 0.01 ? [base({ id: 'C01', codigo: 'descontos', pilar: 'caixa', sentido: 'POSITIVO', gravidade: 0.3, titulo: 'Descontos sob controle', frase: `Os descontos foram ${pct(p, 1)} das vendas brutas.`, numero: `${pct(p, 1)} das vendas`, amostra: `${c.cur.descontosN} descontos; ${brl(c.cur.bruto)} vendidos`, amostraN: c.cur.pedidos, confianca: confDe(c.cur.pedidos, 30, c.geral), limiar: 'até 1% das vendas' })] : [];
            const alvo = Math.max(LIMIARES.descontoLimite, ref ?? 0) * 0.9;
            const turno = c.cur.descontosTurno.noite > c.cur.descontosTurno.dia ? 'à noite (depois das 17h)' : 'durante o dia (antes das 17h)';
            return [base({
                    id: 'C01', codigo: 'descontos', pilar: 'caixa', sentido: 'NEGATIVO', gravidade: clamp((p - LIMIARES.descontoLimite) * 15 + 0.4, 0.4, 1), titulo: 'Descontos comendo a margem',
                    frase: `Os descontos somaram ${brl(c.cur.descontos)} (${pct(p, 1)} das vendas brutas${ref != null ? `; média de 3 meses ${pct(ref, 1)}` : ''}). A maior parte ${turno}${c.cur.motivosDesconto[0] ? `; motivo mais comum: "${c.cur.motivosDesconto[0].motivo}"` : ''}.`,
                    numero: `${pct(p, 1)} das vendas (${brl(c.cur.descontos)})`, amostra: `${c.cur.descontosN} descontos em ${c.cur.pedidos} pedidos`, amostraN: c.cur.pedidos,
                    confianca: confDe(c.cur.pedidos, 30, c.geral), limiar: `acima de ${pct(LIMIARES.descontoLimite)} ou 1,5× a média`,
                    acao: 'Definir o desconto máximo do caixa nas Configurações e revisar os motivos toda semana.', dono: 'Dono',
                    impacto: imp((p - alvo) * c.cur.bruto * c.fatorMes, `descontos voltam a ${pct(alvo, 1)} das vendas brutas (${brl0(c.cur.bruto * c.fatorMes)}/mês)`, 'descontos'),
                    horizonte: 'CURTO', esforco: 'BAIXO', tecnicas: ['controle_descontos'],
                    meta: `Descontos de ${pct(p, 1)} para ${pct(alvo, 1)} das vendas`, metrica: { chave: 'descontos', antes: p, unidade: 'PCT' },
                })];
        },
    },
    {
        id: 'C02', nome: 'Cancelamentos depois do preparo', pilar: 'caixa', limiar: '3+ cancelamentos com comida já em preparo/pronta e R$ 50+', amostraMin: '30 pedidos',
        run: (c) => {
            if (c.cur.pedidos < 30)
                return c.cur.pedidos ? 'AMOSTRA' : 'SEM_DADOS';
            if (c.cur.perdaCancelN < 3 || c.cur.perdaCancel < 5000)
                return [];
            const custoPct = c.cur.brutoComCusto > 0 ? c.cur.custo / c.cur.brutoComCusto : 0.35;
            return [base({
                    id: 'C02', codigo: 'cancelamentos', pilar: 'caixa', sentido: 'NEGATIVO', gravidade: clamp(c.cur.perdaCancel / Math.max(1, c.cur.bruto) * 20, 0.3, 0.8), titulo: 'Comida pronta cancelada',
                    frase: `${c.cur.perdaCancelN} cancelamentos aconteceram com a comida já em preparo ou pronta (${brl(c.cur.perdaCancel)} em venda; custo perdido estimado ${brl(c.cur.perdaCancel * custoPct)}).`,
                    numero: `${c.cur.perdaCancelN} cancelamentos (${brl(c.cur.perdaCancel)})`, amostra: `${c.cur.pedidos} pedidos`, amostraN: c.cur.pedidos, confianca: confDe(c.cur.pedidos, 30, c.geral),
                    limiar: '3+ e R$ 50+', acao: 'Ligar "Cancelar item já pronto: só o Dono" e conferir o pedido com o cliente antes de mandar para a cozinha.', dono: 'Caixa',
                    impacto: imp(c.cur.perdaCancel * custoPct * c.fatorMes * 0.5, `reduzir pela metade o custo perdido (custo = ${c.cur.brutoComCusto > 0 ? `${pct(custoPct)} da venda, pelo custo cadastrado` : '35% da venda, suposto'})`, 'cancelamentos'),
                    horizonte: 'CURTO', esforco: 'BAIXO', tecnicas: ['disciplina_cozinha'], meta: `Cancelamentos após preparo de ${c.cur.perdaCancelN} para ${Math.floor(c.cur.perdaCancelN / 2)}`, metrica: { chave: 'cancelPerda', antes: c.cur.perdaCancel, unidade: 'BRL' },
                })];
        },
    },
    {
        id: 'C03', nome: 'Diferença de caixa recorrente', pilar: 'caixa', limiar: '2+ fechamentos com diferença acima da tolerância', amostraMin: '5 fechamentos',
        run: (c) => {
            if (c.cur.caixa.fechamentos < 5)
                return c.cur.caixa.fechamentos ? 'AMOSTRA' : 'SEM_DADOS';
            if (c.cur.caixa.comDiferenca < 2)
                return c.cur.caixa.comDiferenca === 0 ? [base({ id: 'C03', codigo: 'caixa.diferenca', pilar: 'caixa', sentido: 'POSITIVO', gravidade: 0.3, titulo: 'Caixa fechando certo', frase: `Os ${c.cur.caixa.fechamentos} fechamentos de caixa do mês ficaram dentro da tolerância.`, numero: `${c.cur.caixa.fechamentos} fechamentos sem diferença`, amostra: `${c.cur.caixa.fechamentos} fechamentos`, amostraN: c.cur.caixa.fechamentos, confianca: confDe(c.cur.caixa.fechamentos, 5, c.geral), limiar: 'nenhuma diferença acima da tolerância' })] : [];
            return [base({
                    id: 'C03', codigo: 'caixa.diferenca', pilar: 'caixa', sentido: 'NEGATIVO', gravidade: clamp(c.cur.caixa.comDiferenca / c.cur.caixa.fechamentos * 2, 0.3, 0.9), titulo: 'Diferença de caixa recorrente',
                    frase: `${c.cur.caixa.comDiferenca} de ${c.cur.caixa.fechamentos} fechamentos tiveram diferença acima da tolerância${c.cur.caixa.faltas ? `; faltas somam ${brl(c.cur.caixa.faltas)}` : ''}.`,
                    numero: `${c.cur.caixa.comDiferenca} de ${c.cur.caixa.fechamentos} fechamentos`, amostra: `${c.cur.caixa.fechamentos} fechamentos`, amostraN: c.cur.caixa.fechamentos, confianca: confDe(c.cur.caixa.fechamentos, 5, c.geral),
                    limiar: '2+ com diferença acima da tolerância', acao: 'Conferir cada diferença no mesmo dia com quem fechou e padronizar sangria e troco (apoio, não punição).', dono: 'Dono',
                    impacto: imp(c.cur.caixa.faltas * c.fatorMes, 'zerar as faltas de caixa do mês', 'caixa.diferenca'),
                    horizonte: 'CURTO', esforco: 'BAIXO', tecnicas: ['fechamento_caixa'], meta: `Fechamentos com diferença de ${c.cur.caixa.comDiferenca} para no máximo 1`, metrica: { chave: 'caixa.diferenca', antes: c.cur.caixa.comDiferenca, unidade: 'UN' },
                })];
        },
    },
    {
        id: 'C04', nome: 'Avulsos repetidos e sem custo', pilar: 'caixa', limiar: 'mesmo avulso lançado 3+ vezes', amostraMin: '3 lançamentos',
        run: (c) => {
            if (!c.x.avulsos.length)
                return 'SEM_DADOS';
            const grupos = new Map();
            for (const a of c.x.avulsos) {
                const k = normNome(a.name);
                const g = grupos.get(k) ?? { nome: a.name, n: 0, semCusto: true };
                g.n += a.n;
                g.semCusto = g.semCusto && a.semCusto;
                grupos.set(k, g);
            }
            const rep = [...grupos.values()].filter((g) => g.n >= 3).sort((a, b) => b.n - a.n);
            if (!rep.length)
                return 'AMOSTRA';
            return [base({
                    id: 'C04', codigo: 'avulsos', pilar: 'caixa', sentido: 'NEGATIVO', gravidade: 0.3, titulo: 'Avulsos que deveriam ser produto',
                    frase: `${rep.slice(0, 3).map((g) => `"${g.nome}" (${g.n}×)`).join(', ')} foram lançados como avulso${rep.some((g) => g.semCusto) ? ', sem custo' : ''}: ficam fora do estoque, da margem e da engenharia de cardápio.`,
                    numero: `${rep.length} avulso(s) repetido(s)`, amostra: `${c.x.avulsos.reduce((s, a) => s + a.n, 0)} lançamentos avulsos`, amostraN: rep[0].n, confianca: confDe(rep[0].n, 3, c.geral), limiar: '3+ lançamentos do mesmo avulso',
                    acao: 'Cadastrar esses avulsos como produtos com preço e custo (aparecem em Pendências).', dono: 'Dono', horizonte: 'CURTO', esforco: 'BAIXO', tecnicas: ['controle_cmv'],
                })];
        },
    },
    {
        id: 'C05', nome: 'Despesas: categoria disparou e peso sobre as vendas', pilar: 'caixa', limiar: `categoria +20% vs mês anterior; despesas > ${pct(LIMIARES.despesaLimite)} da receita`, amostraMin: 'R$ 100 na categoria nos dois meses; mês encerrado para o peso',
        run: (c) => {
            if (!c.cur.despesas)
                return 'SEM_DADOS';
            const out = [];
            if (c.prev?.temDados) {
                for (const [cat, v] of Object.entries(c.cur.despesasCat)) {
                    const ant = c.prev.despesasCat[cat] ?? 0;
                    if (v < 10_000 || ant < 10_000 || v / ant - 1 < 0.2)
                        continue;
                    out.push(base({
                        id: 'C05', codigo: `despesa:${cat}`, pilar: 'caixa', sentido: 'NEGATIVO', gravidade: clamp((v / ant - 1), 0.3, 0.8), titulo: `Despesa com ${cat} disparou`,
                        frase: `${cat}: ${brl(v)} contra ${brl(ant)} no ${c.emCurso ? 'mesmo período do mês anterior' : 'mês anterior'} (${sPct(v / ant - 1)}).`,
                        numero: `${brl(v)} (${sPct(v / ant - 1)})`, amostra: 'despesas lançadas nos dois meses', amostraN: 2, confianca: menorConf(c.geral, 'MEDIA'), limiar: 'subida de 20% ou mais',
                        acao: `Ver os lançamentos de ${cat} e renegociar ou cortar o que for recorrente.`, dono: 'Dono',
                        impacto: imp((v - ant) * c.fatorMes * 0.5, `cortar metade da alta de ${cat}`, `despesa:${cat}`),
                        horizonte: 'CURTO', esforco: 'MEDIO', tecnicas: ['ponto_equilibrio'], meta: `${cat} de ${brl0(v)} para ${brl0((v + ant) / 2)}`, metrica: { chave: `despesa:${cat}`, antes: v, unidade: 'BRL' },
                    }));
                }
            }
            if (!c.emCurso && c.cur.despesasPct != null && c.cur.despesasPct > LIMIARES.despesaLimite) {
                out.push(base({
                    id: 'C05', codigo: 'despesas', pilar: 'caixa', sentido: 'NEGATIVO', gravidade: clamp(c.cur.despesasPct - LIMIARES.despesaLimite + 0.4, 0.4, 0.9), titulo: 'Despesas pesadas para o tamanho das vendas',
                    frase: `As despesas do mês (${brl(c.cur.despesas)}) foram ${pct(c.cur.despesasPct)} da receita (limite de referência ${pct(LIMIARES.despesaLimite)}).`,
                    numero: `${pct(c.cur.despesasPct)} da receita`, amostra: 'mês encerrado', amostraN: 1, confianca: menorConf(c.geral, 'MEDIA'), limiar: `acima de ${pct(LIMIARES.despesaLimite)} da receita`,
                    acao: 'Separar despesas fixas e variáveis e calcular o ponto de equilíbrio diário.', dono: 'Dono', horizonte: 'LONGO', esforco: 'ALTO', tecnicas: ['ponto_equilibrio'],
                }));
            }
            return out;
        },
    },
    {
        id: 'C06', nome: 'Ponto de equilíbrio e lucro do mês', pilar: 'caixa', limiar: 'ponto de equilíbrio 3+ dias mais tarde que no mês anterior; lucro com margem ≥ 10%', amostraMin: 'mês encerrado com despesas e 50% das vendas com custo',
        run: (c) => {
            if (c.emCurso)
                return 'AMOSTRA';
            if (!c.cur.despesas || c.cur.cobertura < 0.5)
                return 'SEM_DADOS';
            const out = [];
            const ml = c.cur.margemLiquida;
            if (c.cur.peDia == null)
                out.push(base({
                    id: 'C06', codigo: 'lucro', pilar: 'caixa', sentido: 'NEGATIVO', gravidade: 0.9, titulo: 'O mês não pagou as despesas',
                    frase: `A margem das vendas não cobriu as despesas do mês: resultado de ${brl(c.cur.lucro)}.`, numero: `resultado ${brl(c.cur.lucro)}`, amostra: `${c.cur.diasVenda} dias com venda`, amostraN: c.cur.diasVenda,
                    confianca: menorConf(c.geral, 'MEDIA'), limiar: 'ponto de equilíbrio não atingido', acao: 'Calcular a meta diária mínima (ponto de equilíbrio ÷ dias abertos) e cortar despesas que não geram venda.', dono: 'Dono', horizonte: 'MEDIO', esforco: 'ALTO', tecnicas: ['ponto_equilibrio'],
                }));
            else if (c.prev?.peDia != null && c.cur.peDia - c.prev.peDia >= 3)
                out.push(base({
                    id: 'C06', codigo: 'equilibrio', pilar: 'caixa', sentido: 'NEGATIVO', gravidade: 0.5, titulo: 'Ponto de equilíbrio chegou mais tarde',
                    frase: `As despesas foram cobertas só no dia ${c.cur.peDia} (no mês anterior, no dia ${c.prev.peDia}).`, numero: `dia ${c.cur.peDia} × dia ${c.prev.peDia}`, amostra: '2 meses encerrados', amostraN: 2,
                    confianca: menorConf(c.geral, 'MEDIA'), limiar: '3+ dias mais tarde', acao: 'Acompanhar a meta diária mínima e o dia do equilíbrio toda semana.', dono: 'Dono', horizonte: 'MEDIO', esforco: 'MEDIO', tecnicas: ['ponto_equilibrio'],
                }));
            if (ml != null && ml >= 0.1 && c.cur.lucro > 0)
                out.push(base({
                    id: 'C06', codigo: 'lucro', pilar: 'caixa', sentido: 'POSITIVO', gravidade: 0.6, titulo: 'Mês com lucro saudável',
                    frase: `O mês fechou com lucro de ${brl(c.cur.lucro)} (${pct(ml)} da receita), despesas cobertas no dia ${c.cur.peDia}.`, numero: `lucro ${brl(c.cur.lucro)} (${pct(ml)})`, amostra: `${c.cur.diasVenda} dias com venda`, amostraN: c.cur.diasVenda,
                    confianca: menorConf(c.geral, 'MEDIA'), limiar: 'margem líquida de 10% ou mais',
                }));
            return out;
        },
    },
    // ---------------- OPERAÇÃO E TEMPO ----------------
    {
        id: 'O01', nome: 'Tempo de preparo acima da meta no pico', pilar: 'operacao', limiar: '40%+ dos pedidos do pico acima do tempo-meta', amostraMin: '20 pedidos no pico com horário',
        run: (c) => {
            const k = c.cur.cozinha;
            if (!k.validos)
                return 'SEM_DADOS';
            const porH = new Map();
            for (const r of k.linhas)
                porH.set(r.hora, (porH.get(r.hora) ?? 0) + 1);
            const pico = [...porH.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h]) => h);
            const noPico = k.linhas.filter((r) => pico.includes(r.hora));
            if (noPico.length < 20)
                return 'AMOSTRA';
            const acima = noPico.filter((r) => r.min > r.meta).length / noPico.length;
            const conf = confDe(noPico.length, 20, c.geralTempos);
            const med = median(noPico.map((r) => r.min));
            if (acima >= 0.4)
                return [base({
                        id: 'O01', codigo: 'cozinha.pico', pilar: 'operacao', sentido: 'NEGATIVO', gravidade: clamp(acima, 0.4, 0.9), titulo: 'Cozinha atrasa no pico',
                        frase: `No pico (${pico.sort((a, b) => a - b).map((h) => `${h}h`).join(', ')}), ${pct(acima)} dos pedidos passaram do tempo-meta; mediana de ${Math.round(med)} min.`,
                        numero: `${pct(acima)} acima da meta no pico`, amostra: `${noPico.length} pedidos no pico`, amostraN: noPico.length, confianca: conf, limiar: '40%+ acima do tempo-meta',
                        acao: 'Pré-preparo antes do pico e uma pessoa a mais na montagem no horário de maior movimento.', dono: 'Cozinha', horizonte: 'CURTO', esforco: 'MEDIO', tecnicas: ['escala_pico', 'disciplina_cozinha'],
                        meta: `Pedidos do pico acima da meta de ${pct(acima)} para ${pct(Math.max(0.2, acima - 0.2))}`, metrica: { chave: 'cozinha.pico', antes: acima, unidade: 'PCT' },
                    })];
            return [];
        },
    },
    {
        id: 'O02', nome: 'Fila de confirmação no caixa (pedidos online)', pilar: 'operacao', limiar: 'mediana acima de 5 min para confirmar', amostraMin: '10 pedidos online confirmados',
        run: (c) => {
            if (c.x.fila.length < 10)
                return c.x.fila.length ? 'AMOSTRA' : 'SEM_DADOS';
            const m = median(c.x.fila);
            if (m <= 5)
                return [];
            return [base({
                    id: 'O02', codigo: 'fila.confirmacao', pilar: 'operacao', sentido: 'NEGATIVO', gravidade: clamp(m / 15, 0.3, 0.8), titulo: 'Pedido online espera para ser confirmado',
                    frase: `O caixa leva em mediana ${num1(m)} min para confirmar um pedido online.`, numero: `${num1(m)} min (mediana)`, amostra: `${c.x.fila.length} pedidos online`, amostraN: c.x.fila.length,
                    confianca: confDe(c.x.fila.length, 10, c.geral), limiar: 'mais de 5 min', acao: 'Som ligado no caixa e uma pessoa responsável por confirmar pedidos online no pico.', dono: 'Caixa',
                    horizonte: 'CURTO', esforco: 'BAIXO', tecnicas: ['canal_digital'], meta: `Confirmação de ${num1(m)} min para menos de 3 min`, metrica: { chave: 'fila.confirmacao', antes: m, unidade: 'MIN' },
                })];
        },
    },
    {
        id: 'O03', nome: 'Pedidos esquecidos na cozinha', pilar: 'operacao', limiar: '3+ pedidos com mais de 3× o tempo-meta e 3%+ do total', amostraMin: '30 pedidos prontos',
        run: (c) => {
            const k = c.cur.cozinha;
            if (k.prontos < 30)
                return k.prontos ? 'AMOSTRA' : 'SEM_DADOS';
            if (k.esquecidos < 3 || k.esquecidos / k.prontos < 0.03)
                return [];
            return [base({
                    id: 'O03', codigo: 'cozinha.esquecidos', pilar: 'operacao', sentido: 'NEGATIVO', gravidade: clamp(k.esquecidos / k.prontos * 5, 0.3, 0.8), titulo: 'Pedidos esquecidos',
                    frase: `${k.esquecidos} pedidos (${pct(k.esquecidos / k.prontos)}) ficaram mais de 3× o tempo-meta na cozinha.`, numero: `${k.esquecidos} pedidos`, amostra: `${k.prontos} pedidos prontos`, amostraN: k.prontos,
                    confianca: confDe(k.prontos, 30, c.geralTempos), limiar: '3+ e 3%+ dos pedidos', acao: 'Revisar a tela da cozinha a cada 10 min no pico e tocar "Pronto" na hora certa.', dono: 'Cozinha',
                    horizonte: 'CURTO', esforco: 'BAIXO', tecnicas: ['disciplina_cozinha'], meta: `Esquecidos de ${k.esquecidos} para no máximo ${Math.floor(k.esquecidos / 2)}`, metrica: { chave: 'cozinha.esquecidos', antes: k.esquecidos, unidade: 'UN' },
                })];
        },
    },
    {
        id: 'O04', nome: 'Pedidos sem Iniciar/Pronto (baixa a confiança)', pilar: 'operacao', limiar: 'menos de 50% dos pedidos da cozinha com Iniciar e Pronto', amostraMin: '30 pedidos de cozinha',
        run: (c) => {
            const k = c.cur.cozinha;
            if (k.total < 30)
                return k.total ? 'AMOSTRA' : 'SEM_DADOS';
            if (k.pctHorarios >= 0.5)
                return k.pctHorarios >= 0.8 ? [base({ id: 'O04', codigo: 'cozinha.horarios', pilar: 'operacao', sentido: 'POSITIVO', gravidade: 0.3, titulo: 'Cozinha registrando os horários', frase: `${pct(k.pctHorarios)} dos pedidos da cozinha têm Iniciar e Pronto: os tempos são confiáveis.`, numero: `${pct(k.pctHorarios)} com horários`, amostra: `${k.total} pedidos de cozinha`, amostraN: k.total, confianca: confDe(k.total, 30, c.geral), limiar: '80% ou mais com horários' })] : [];
            return [base({
                    id: 'O04', codigo: 'cozinha.horarios', pilar: 'operacao', sentido: 'NEGATIVO', gravidade: 0.5, titulo: 'Cozinha não registra o início do preparo',
                    frase: `Só ${pct(k.pctHorarios)} dos pedidos da cozinha têm Iniciar e Pronto registrados. Os tempos de preparo deste relatório têm confiança baixa.`,
                    numero: `${pct(k.pctHorarios)} com horários`, amostra: `${k.total} pedidos de cozinha`, amostraN: k.total, confianca: confDe(k.total, 30, c.geral), limiar: 'menos de 50%',
                    acao: 'Combinar com a cozinha: tocar Iniciar ao começar e Pronto ao terminar cada pedido.', dono: 'Cozinha', horizonte: 'CURTO', esforco: 'BAIXO', tecnicas: ['disciplina_cozinha'],
                    meta: `Pedidos com horários de ${pct(k.pctHorarios)} para 80%`, metrica: { chave: 'cozinha.horarios', antes: k.pctHorarios, unidade: 'PCT' },
                })];
        },
    },
    {
        id: 'O05', nome: 'Capacidade da cozinha × pico', pilar: 'operacao', limiar: 'pico 25%+ acima da capacidade estimada', amostraMin: '20 faixas dia×hora com 3+ pedidos',
        run: (c) => {
            const k = c.cur.cozinha;
            const faixas = new Map();
            for (const r of k.linhas) {
                const key = `${r.dia}:${r.hora}`;
                const f = faixas.get(key) ?? { n: 0, t: [], meta: [] };
                f.n++;
                f.t.push(r.min);
                f.meta.push(r.meta);
                faixas.set(key, f);
            }
            const fs = [...faixas.values()].filter((f) => f.n >= 3);
            if (fs.length < 20)
                return k.validos ? 'AMOSTRA' : 'SEM_DADOS';
            const noPrazo = fs.filter((f) => median(f.t) <= median(f.meta)).map((f) => f.n);
            if (noPrazo.length < 5)
                return 'AMOSTRA';
            const cap = quantil(noPrazo, 0.75);
            const pico = quantil(fs.map((f) => f.n), 0.9);
            if (pico <= cap * 1.25)
                return [];
            return [base({
                    id: 'O05', codigo: 'cozinha.capacidade', pilar: 'operacao', sentido: 'NEGATIVO', gravidade: 0.5, titulo: 'Pico passa da capacidade da cozinha',
                    frase: `A cozinha entrega no prazo até cerca de ${cap} pedidos por hora; nas horas de pico chegam ${pico} pedidos por hora.`, numero: `pico ${pico}/h × capacidade ${cap}/h`,
                    amostra: `${fs.length} faixas de hora com 3+ pedidos`, amostraN: fs.length, confianca: confDe(fs.length, 20, c.geralTempos), limiar: 'pico 25% acima da capacidade',
                    acao: 'Simplificar o cardápio no pico (itens de preparo rápido em destaque) e reforçar a equipe nesse horário.', dono: 'Dono', horizonte: 'MEDIO', esforco: 'MEDIO', tecnicas: ['escala_pico', 'engenharia_cardapio'],
                })];
        },
    },
    {
        id: 'O06', nome: 'Cozinha dentro do tempo-meta', pilar: 'operacao', limiar: '85%+ dos pedidos no tempo-meta', amostraMin: '30 pedidos com horário',
        run: (c) => {
            const k = c.cur.cozinha;
            if (k.validos < 30 || k.dentroMeta == null)
                return k.validos ? 'AMOSTRA' : 'SEM_DADOS';
            if (k.dentroMeta < 0.85)
                return [];
            return [base({ id: 'O06', codigo: 'cozinha.prazo', pilar: 'operacao', sentido: 'POSITIVO', gravidade: 0.45, titulo: 'Cozinha no prazo', frase: `${pct(k.dentroMeta)} dos pedidos ficaram prontos dentro do tempo-meta (mediana ${Math.round(k.mediana ?? 0)} min).`, numero: `${pct(k.dentroMeta)} no prazo`, amostra: `${k.validos} pedidos com horário`, amostraN: k.validos, confianca: confDe(k.validos, 30, c.geralTempos), limiar: '85% ou mais no prazo' })];
        },
    },
    // ---------------- ESTOQUE ----------------
    {
        id: 'E01', nome: 'Ruptura de item que vende bem', pilar: 'estoque', limiar: '2+ dias zerado de item que vende 1+ por dia', amostraMin: 'produto controlado com 1+ unidade/dia',
        run: (c) => {
            if (!c.cur.estoque.controlados)
                return 'SEM_DADOS';
            const out = [];
            for (const z of c.cur.estoque.zerados) {
                const p = c.x.produtos.find((x) => x.id === z.id);
                const diasCom = Math.max(1, z.dias - z.diasZero);
                const porDia = p ? p.qtd / diasCom : 0;
                if (z.diasZero < 2 || porDia < 1)
                    continue;
                const mu = p && p.preco != null ? (p.custoAtual != null ? p.preco - p.custoAtual : p.preco * margemEst(c).m) : 0;
                out.push(base({
                    id: 'E01', codigo: `estoque:${z.id}`, pilar: 'estoque', sentido: 'NEGATIVO', gravidade: clamp(z.diasZero / 10, 0.4, 0.9), titulo: `${z.name} ficou sem estoque`,
                    frase: `${z.name} ficou zerado em ${z.diasZero} dia(s) do mês; nos outros dias vendeu em média ${num1(porDia)} por dia.`, numero: `${z.diasZero} dias zerado`,
                    amostra: `${z.dias} dias acompanhados; ${p?.qtd ?? 0} vendidos`, amostraN: z.dias, confianca: confDe(z.dias, 7, c.geral), limiar: '2+ dias zerado e 1+ venda/dia',
                    acao: `Definir estoque mínimo de ${z.name} (${Math.ceil(porDia * c.coberturaMeta)} un. = ${c.coberturaMeta} dias) e repor antes de zerar.`, dono: 'Compras',
                    impacto: imp(z.diasZero * porDia * mu * 0.5 * c.fatorMes, `metade das vendas dos dias zerados foi perdida (${num1(porDia)}/dia × ${z.diasZero} dias) com margem unitária de ${brl(mu)}`, `estoque:${z.id}`),
                    horizonte: 'CURTO', esforco: 'BAIXO', tecnicas: ['curva_abc_estoque', 'peps'], meta: `${z.name} sem nenhum dia zerado`, metrica: { chave: `ruptura:${z.id}`, antes: z.diasZero, unidade: 'DIAS' },
                }));
            }
            return out.sort((a, b) => (b.impacto?.centsMes ?? 0) - (a.impacto?.centsMes ?? 0)).slice(0, 3);
        },
    },
    {
        id: 'E02', nome: 'Capital parado no estoque', pilar: 'estoque', limiar: `cobertura acima de ${LIMIARES.capitalParadoX}× a meta de dias`, amostraMin: 'R$ 100 parados e 30 dias de histórico',
        run: (c) => {
            if (!c.x.estoque.length)
                return 'SEM_DADOS';
            if (c.diasHist < 30)
                return 'AMOSTRA'; // a venda média usa 30 dias de histórico
            const parados = c.x.estoque.map((e) => {
                const dia = e.vendidos30 / 30;
                const cob = dia > 0 ? e.qtd / dia : e.qtd > 0 ? Infinity : 0;
                const excesso = Math.max(0, e.qtd - dia * c.coberturaMeta * 2);
                return { ...e, cob, valor: excesso * (e.custo ?? 0) };
            }).filter((e) => e.cob > c.coberturaMeta * LIMIARES.capitalParadoX && e.valor > 0).sort((a, b) => b.valor - a.valor);
            const total = parados.reduce((s, e) => s + e.valor, 0);
            if (total < 10_000)
                return parados.length ? 'AMOSTRA' : [];
            return [base({
                    id: 'E02', codigo: 'estoque.parado', pilar: 'estoque', sentido: 'NEGATIVO', gravidade: 0.4, titulo: 'Dinheiro parado no estoque',
                    frase: `${brl(total)} em estoque além do necessário (cobertura acima de ${c.coberturaMeta * LIMIARES.capitalParadoX} dias): ${parados.slice(0, 3).map((e) => `${e.name} (${Number.isFinite(e.cob) ? Math.round(e.cob) + ' dias' : 'sem venda'})`).join(', ')}.`,
                    numero: `${brl(total)} parados`, amostra: `${c.x.estoque.length} produtos controlados; vendas dos últimos 30 dias`, amostraN: c.x.estoque.length, confianca: confDe(c.x.estoque.length, 3, c.geral),
                    limiar: `cobertura acima de ${LIMIARES.capitalParadoX}× a meta (${c.coberturaMeta} dias)`, acao: 'Suspender a compra desses itens até a cobertura voltar à meta; promover os de giro lento.', dono: 'Compras',
                    impacto: imp(total, `dinheiro liberado ao baixar o estoque a 2× a meta de ${c.coberturaMeta} dias (uma vez, não por mês)`, 'estoque.parado', 'CAIXA'),
                    horizonte: 'MEDIO', esforco: 'BAIXO', tecnicas: ['curva_abc_estoque'], meta: `Capital parado de ${brl0(total)} para menos de ${brl0(total / 2)}`, metrica: { chave: 'estoque.parado', antes: total, unidade: 'BRL' },
                })];
        },
    },
    {
        id: 'E03', nome: 'Perdas e quebras por motivo', pilar: 'estoque', limiar: 'R$ 50+ em ajustes para menos', amostraMin: '3 ajustes',
        run: (c) => {
            if (!c.cur.estoque.controlados)
                return 'SEM_DADOS';
            if (c.cur.estoque.perdasN < 3)
                return c.cur.estoque.perdasN ? 'AMOSTRA' : [];
            if (c.cur.estoque.perdas < 5000)
                return [];
            const top = c.x.perdasMotivo.slice(0, 3);
            return [base({
                    id: 'E03', codigo: 'estoque.perdas', pilar: 'estoque', sentido: 'NEGATIVO', gravidade: clamp(c.cur.estoque.perdas / Math.max(1, c.cur.custo) * 5, 0.3, 0.9), titulo: 'Perdas no estoque',
                    frase: `Perdas e quebras somaram ${brl(c.cur.estoque.perdas)} pelo custo: ${top.map((t) => `${t.motivo} ${brl(t.cents)}`).join(', ')}.`, numero: `${brl(c.cur.estoque.perdas)} perdidos`,
                    amostra: `${c.cur.estoque.perdasN} ajustes para menos`, amostraN: c.cur.estoque.perdasN, confianca: confDe(c.cur.estoque.perdasN, 3, c.geral), limiar: 'R$ 50+ em perdas',
                    acao: `Atacar a maior causa ("${top[0]?.motivo ?? 'sem motivo'}") com PEPS e etiqueta de data.`, dono: 'Compras',
                    impacto: imp(c.cur.estoque.perdas * 0.5 * c.fatorMes, 'reduzir as perdas pela metade', 'estoque.perdas'),
                    horizonte: 'CURTO', esforco: 'BAIXO', tecnicas: ['peps'], meta: `Perdas de ${brl0(c.cur.estoque.perdas * c.fatorMes)} para ${brl0(c.cur.estoque.perdas * c.fatorMes / 2)} no mês`, metrica: { chave: 'estoque.perdas', antes: c.cur.estoque.perdas, unidade: 'BRL' },
                })];
        },
    },
    {
        id: 'E04', nome: 'Divergências recorrentes (vendido sem estoque)', pilar: 'estoque', limiar: 'mesmo produto 3+ vezes no mês', amostraMin: '3 divergências',
        run: (c) => {
            if (!c.cur.estoque.controlados)
                return 'SEM_DADOS';
            const rec = c.x.divergencias.filter((d) => d.vezes >= 3);
            if (!rec.length)
                return c.x.divergencias.length ? 'AMOSTRA' : [];
            return [base({
                    id: 'E04', codigo: 'estoque.divergencia', pilar: 'estoque', sentido: 'NEGATIVO', gravidade: 0.35, titulo: 'Estoque do sistema não bate',
                    frase: `${rec.slice(0, 3).map((d) => `${d.name} (${d.vezes}×, ${d.faltou} un.)`).join(', ')} foram vendidos sem estoque registrado: a contagem está errada ou falta lançar entradas.`,
                    numero: `${rec.length} produto(s) com divergência recorrente`, amostra: `${c.x.divergencias.reduce((s, d) => s + d.vezes, 0)} divergências`, amostraN: rec[0].vezes, confianca: confDe(rec[0].vezes, 3, c.geral),
                    limiar: '3+ divergências no mesmo produto', acao: 'Contar esses itens e lançar toda entrada no dia em que chega.', dono: 'Compras', horizonte: 'CURTO', esforco: 'BAIXO', tecnicas: ['curva_abc_estoque'],
                })];
        },
    },
    {
        id: 'E05', nome: 'Variação de custo por fornecedor', pilar: 'estoque', limiar: 'custo de compra +15% em 90 dias no mesmo fornecedor', amostraMin: '2 entradas do mesmo produto e fornecedor',
        run: (c) => {
            if (!c.x.fornecedores.length)
                return 'SEM_DADOS';
            const g = new Map();
            for (const f of c.x.fornecedores) {
                const k = `${f.pid}|${normNome(f.fornecedor)}`;
                const a = g.get(k) ?? [];
                a.push(f);
                g.set(k, a);
            }
            const out = [];
            let algum = false;
            for (const [, a] of g) {
                if (a.length < 2)
                    continue;
                algum = true;
                const ini = a[0].custo, fim = a[a.length - 1].custo;
                if (ini <= 0 || fim / ini - 1 < 0.15)
                    continue;
                const outros = c.x.fornecedores.filter((f) => f.pid === a[0].pid && normNome(f.fornecedor) !== normNome(a[0].fornecedor));
                const melhor = outros.length ? outros.reduce((m, f) => (f.custo < m.custo ? f : m)) : null;
                const qtdMes = a.reduce((s, f) => s + f.qtd, 0) / 3;
                out.push(base({
                    id: 'E05', codigo: `fornecedor:${a[0].pid}:${normNome(a[0].fornecedor)}`, pilar: 'estoque', sentido: 'NEGATIVO', gravidade: clamp(fim / ini - 1, 0.3, 0.8),
                    titulo: `${a[0].name}: ${a[0].fornecedor} subiu o preço`,
                    frase: `${a[0].name} (${a[0].fornecedor}): custo de compra ${sPct(fim / ini - 1)} em ${Math.max(1, diasEntre(a[0].dia, a[a.length - 1].dia))} dias (${brl(ini)} → ${brl(fim)})${melhor && melhor.custo < fim ? `; ${melhor.fornecedor} vendeu a ${brl(melhor.custo)}` : ''}.`,
                    numero: `${sPct(fim / ini - 1)} no fornecedor`, amostra: `${a.length} entradas em 90 dias`, amostraN: a.length, confianca: confDe(a.length, 2, c.geral), limiar: '+15% em 90 dias',
                    acao: melhor && melhor.custo < fim ? `Comprar ${a[0].name} de ${melhor.fornecedor} ou renegociar com ${a[0].fornecedor}.` : `Cotar ${a[0].name} com outro fornecedor e renegociar.`, dono: 'Compras',
                    impacto: melhor && melhor.custo < fim ? imp((fim - melhor.custo) * qtdMes, `comprar pelo menor custo visto (${brl(melhor.custo)}) a quantidade média comprada por mês (${Math.round(qtdMes)} un.)`, `margem:fornecedor:${a[0].pid}`) : null,
                    horizonte: 'MEDIO', esforco: 'MEDIO', tecnicas: ['cotacao'],
                }));
            }
            return out.length ? out.slice(0, 3) : algum ? [] : 'AMOSTRA';
        },
    },
    // ---------------- FIADO ----------------
    {
        id: 'F01', nome: 'Fiado vencido crescendo', pilar: 'fiado', limiar: 'vencido +20% vs fim do mês anterior e R$ 100+', amostraMin: '3 contas vencidas',
        run: (c) => {
            const f = c.cur.fiado;
            if (!f.contas)
                return 'SEM_DADOS';
            if (f.vencidas < 3)
                return 'AMOSTRA';
            const ant = c.prev?.fiado.vencido ?? null;
            const cresceu = ant == null ? f.vencido >= 10_000 : f.vencido >= 10_000 && f.vencido > ant * 1.2;
            if (!cresceu)
                return ant != null && f.vencido < ant * 0.8 ? [base({ id: 'F01', codigo: 'fiado.vencido', pilar: 'fiado', sentido: 'POSITIVO', gravidade: 0.4, titulo: 'Fiado vencido diminuiu', frase: `O fiado vencido caiu de ${brl(ant)} para ${brl(f.vencido)}.`, numero: `${brl(f.vencido)} (${sPct(f.vencido / ant - 1)})`, amostra: `${f.vencidas} contas vencidas`, amostraN: f.vencidas, confianca: confDe(f.vencidas, 3, c.geral), limiar: 'queda de 20% ou mais' })] : [];
            return [base({
                    id: 'F01', codigo: 'fiado.vencido', pilar: 'fiado', sentido: 'NEGATIVO', gravidade: clamp(f.vencido / Math.max(1, c.cur.receita) * 4, 0.4, 1), titulo: 'Fiado vencido crescendo',
                    frase: `Há ${brl(f.vencido)} em fiado vencido (${f.vencidas} contas)${ant != null ? `, contra ${brl(ant)} no fim do mês anterior` : ''}.`, numero: `${brl(f.vencido)} vencidos`,
                    amostra: `${f.contas} contas no fiado`, amostraN: f.vencidas, confianca: confDe(f.vencidas, 3, c.geral), limiar: ant != null ? 'vencido +20% e R$ 100+' : 'R$ 100+ vencidos',
                    acao: 'Cobrar as vencidas com mensagem pronta (envio feito por uma pessoa) e não abrir fiado novo para quem tem conta vencida.', dono: 'Dono',
                    impacto: imp(f.vencido * 0.5, 'recuperar metade do vencido (entra no caixa uma vez)', 'fiado', 'CAIXA'),
                    horizonte: 'CURTO', esforco: 'BAIXO', tecnicas: ['politica_fiado'], meta: `Fiado vencido de ${brl0(f.vencido)} para ${brl0(f.vencido / 2)}`, metrica: { chave: 'fiado.vencido', antes: f.vencido, unidade: 'BRL' },
                })];
        },
    },
    {
        id: 'F02', nome: 'Prazo médio de recebimento do fiado', pilar: 'fiado', limiar: 'acima de 15 dias (negativo) ou até 7 (positivo)', amostraMin: '5 contas recebidas em 90 dias',
        run: (c) => {
            if (c.x.prazos.length < 5)
                return c.x.prazos.length ? 'AMOSTRA' : 'SEM_DADOS';
            const m = c.x.prazos.reduce((s, x) => s + x, 0) / c.x.prazos.length;
            const comum = { codigo: 'fiado.prazo', pilar: 'fiado', numero: `${num1(m)} dias em média`, amostra: `${c.x.prazos.length} contas recebidas em 90 dias`, amostraN: c.x.prazos.length, confianca: confDe(c.x.prazos.length, 5, c.geral) };
            if (m > 15)
                return [base({ ...comum, id: 'F02', sentido: 'NEGATIVO', gravidade: clamp(m / 45, 0.3, 0.8), titulo: 'Fiado demora para voltar', frase: `O fiado leva em média ${num1(m)} dias para ser pago.`, limiar: 'mais de 15 dias', acao: 'Combinar data de pagamento em toda venda fiado e lembrar no dia combinado.', dono: 'Caixa', horizonte: 'CURTO', esforco: 'BAIXO', tecnicas: ['politica_fiado'], meta: `Prazo médio de ${num1(m)} para 10 dias`, metrica: { chave: 'fiado.prazo', antes: m, unidade: 'DIAS' } })];
            if (m <= 7)
                return [base({ ...comum, id: 'F02', sentido: 'POSITIVO', gravidade: 0.35, titulo: 'Fiado volta rápido', frase: `O fiado é pago em média em ${num1(m)} dias.`, limiar: 'até 7 dias' })];
            return [];
        },
    },
    {
        id: 'F03', nome: 'Concentração do fiado', pilar: 'fiado', limiar: '3 clientes ou menos fazem 80% do saldo', amostraMin: '5 contas e R$ 200 no fiado',
        run: (c) => {
            if (!c.cur.fiado.contas)
                return 'SEM_DADOS';
            if (c.cur.fiado.contas < 5 || c.cur.fiado.total < 20_000)
                return 'AMOSTRA';
            const lista = c.x_fiadoAtual ?? [];
            const porCli = new Map();
            for (const f of lista)
                porCli.set(f.cliente, (porCli.get(f.cliente) ?? 0) + f.saldo);
            const vals = [...porCli.values()].sort((a, b) => b - a);
            const tot = vals.reduce((s, x) => s + x, 0);
            let acc = 0, k = 0;
            for (const v of vals) {
                acc += v;
                k++;
                if (acc >= tot * 0.8)
                    break;
            }
            if (k > 3 || porCli.size < 4)
                return [];
            return [base({
                    id: 'F03', codigo: 'fiado.concentracao', pilar: 'fiado', sentido: 'NEGATIVO', gravidade: 0.45, titulo: 'Fiado concentrado em poucos clientes',
                    frase: `${k} cliente(s) concentram 80% do fiado (${brl(acc)} de ${brl(tot)}). Um calote desses pesa no mês.`, numero: `${k} de ${porCli.size} clientes = 80%`,
                    amostra: `${lista.length} contas de ${porCli.size} clientes`, amostraN: lista.length, confianca: confDe(lista.length, 5, c.geral), limiar: '3 ou menos = 80% do saldo',
                    acao: 'Definir limite de fiado por cliente e combinar pagamento parcial dos maiores saldos.', dono: 'Dono', horizonte: 'MEDIO', esforco: 'MEDIO', tecnicas: ['politica_fiado'],
                })];
        },
    },
    {
        id: 'F04', nome: 'Inadimplência (fiado com mais de 30 dias)', pilar: 'fiado', limiar: '30%+ do saldo com mais de 30 dias', amostraMin: '5 contas no fiado',
        run: (c) => {
            const f = c.cur.fiado;
            if (!f.contas)
                return 'SEM_DADOS';
            if (f.contas < 5)
                return 'AMOSTRA';
            const p = f.total > 0 ? f.mais30 / f.total : 0;
            if (p < 0.3)
                return [];
            return [base({
                    id: 'F04', codigo: 'fiado.inadimplencia', pilar: 'fiado', sentido: 'NEGATIVO', gravidade: clamp(p, 0.4, 0.9), titulo: 'Fiado antigo (risco de calote)',
                    frase: `${pct(p)} do fiado (${brl(f.mais30)}) está pendente há mais de 30 dias.`, numero: `${pct(p)} com 30+ dias`, amostra: `${f.contas} contas no fiado`, amostraN: f.contas,
                    confianca: confDe(f.contas, 5, c.geral), limiar: '30%+ do saldo com mais de 30 dias', acao: 'Propor acordo de parcelamento para as contas com mais de 30 dias.', dono: 'Dono',
                    impacto: imp(f.mais30 * 0.3, 'acordo recupera 30% do fiado com mais de 30 dias (entra no caixa uma vez)', 'fiado', 'CAIXA'),
                    horizonte: 'CURTO', esforco: 'MEDIO', tecnicas: ['politica_fiado'],
                })];
        },
    },
];
const ACAO_QUADRANTE = {
    ESTRELA: 'Manter e destacar (não mexer no preço sem motivo).',
    BURRO_DE_CARGA: 'Subir o preço em degraus ou baixar o custo da porção.',
    QUEBRA_CABECA: 'Divulgar, colocar em combo e sugerir no caixa.',
    ABACAXI: 'Rever a receita ou tirar do cardápio.',
};
function matriz(c) {
    const itens = c.x.produtos.filter((p) => p.id != null && p.preco && p.custoAtual != null && p.qtd > 0);
    const totalQtd = itens.reduce((s, p) => s + p.qtd, 0);
    if (itens.length < 6 || totalQtd < 100)
        return null;
    const corte = 0.7 * (totalQtd / itens.length);
    return {
        corte, totalQtd, meta: LIMIARES.metaMargem,
        itens: itens.map((p) => {
            const preco = Math.round(p.receita / p.qtd), custo = p.custoAtual;
            const margem = (preco - custo) / preco;
            const pop = p.qtd >= corte, boa = margem >= LIMIARES.metaMargem;
            const quadrante = pop && boa ? 'ESTRELA' : pop ? 'BURRO_DE_CARGA' : boa ? 'QUEBRA_CABECA' : 'ABACAXI';
            return { id: p.id, name: p.name, cat: p.cat, qtd: p.qtd, preco, custo, margem, lucro: (preco - custo) * p.qtd, quadrante, acao: ACAO_QUADRANTE[quadrante] };
        }).sort((a, b) => b.qtd - a.qtd),
        semCusto: c.x.produtos.filter((p) => p.custoAtual == null || !p.preco).map((p) => ({ name: p.name, qtd: p.qtd })),
    };
}
// ======================================================================================
// Nota 0–100 e os 6 pilares
// ======================================================================================
export const PILARES = [
    { id: 'vendas', nome: 'Vendas e demanda' }, { id: 'margem', nome: 'Margem e preço' }, { id: 'operacao', nome: 'Operação e tempo' },
    { id: 'estoque', nome: 'Estoque' }, { id: 'caixa', nome: 'Caixa e controle' }, { id: 'fiado', nome: 'Fiado' },
];
function notaPilares(f, baseVendas) {
    const r = {};
    // vendas
    if (!f.temDados || f.pedidos === 0)
        r.vendas = { nota: null, numero: 'sem dados', comoSubir: 'Registrar todas as vendas no sistema.' };
    else if (!baseVendas || baseVendas.ref <= 0)
        r.vendas = { nota: null, numero: `${brl(f.receita)} (sem mês anterior para comparar)`, comoSubir: 'A nota de vendas aparece com um mês completo de comparação.' };
    else {
        const v = f.receita / baseVendas.ref - 1;
        r.vendas = { nota: Math.round(clamp(70 + v * 150, 0, 100)), numero: `vendas ${sPct(v)} vs ${baseVendas.nome}`, comoSubir: 'Atacar o dia mais fraco, venda sugestiva e reativação de clientes.' };
    }
    // margem
    if (f.margemBruta == null)
        r.margem = { nota: null, numero: f.bruto ? `só ${pct(f.cobertura)} das vendas com custo` : 'sem dados', comoSubir: 'Cadastrar o custo dos produtos (precisa de 50% das vendas com custo).' };
    else {
        const m = f.margemBruta;
        const nota = m >= LIMIARES.metaMargem ? 85 + (m - LIMIARES.metaMargem) * 100 : (m / LIMIARES.metaMargem) * 85;
        r.margem = { nota: Math.round(clamp(nota, 0, 100)), numero: `margem bruta ${pct(m, 1)} (meta ${pct(LIMIARES.metaMargem)})`, comoSubir: 'Reprecificar os Burros de carga e repassar altas de custo.' };
    }
    // operação
    const k = f.cozinha;
    if (k.validos < 20 || k.pctHorarios < 0.5)
        r.operacao = { nota: null, numero: k.total ? `só ${pct(k.pctHorarios)} dos pedidos com Iniciar/Pronto` : 'sem pedidos de cozinha', comoSubir: 'A cozinha precisa tocar Iniciar e Pronto (50%+ dos pedidos) para medir.' };
    else
        r.operacao = { nota: Math.round(clamp((k.dentroMeta ?? 0) * 100 - (k.esquecidos / Math.max(1, k.prontos)) * 100, 0, 100)), numero: `${pct(k.dentroMeta ?? 0)} no tempo-meta; ${k.esquecidos} esquecidos`, comoSubir: 'Pré-preparo antes do pico e revisão da tela da cozinha.' };
    // estoque
    if (!f.estoque.controlados)
        r.estoque = { nota: null, numero: 'nenhum produto com estoque controlado', comoSubir: 'Ligar o controle de estoque dos itens comprados prontos (bebidas, etc.).' };
    else {
        const perdaPct = f.custo > 0 ? f.estoque.perdas / f.custo : 0;
        r.estoque = { nota: Math.round(clamp(100 - Math.min(40, f.estoque.diasZero * 3) - Math.min(40, perdaPct * 400), 0, 100)), numero: `${f.estoque.diasZero} dias-produto zerados; perdas ${brl(f.estoque.perdas)}`, comoSubir: 'Estoque mínimo nos itens que mais vendem e PEPS para reduzir perdas.' };
    }
    // caixa e controle
    if (!f.temDados)
        r.caixa = { nota: null, numero: 'sem dados', comoSubir: '—' };
    else {
        const d = f.descontosPct ?? 0, cp = f.bruto > 0 ? f.perdaCancel / f.bruto : 0, dp = f.despesasPct ?? 0;
        const nota = 100 - Math.max(0, d - 0.02) * 1000 - cp * 500 - f.caixa.comDiferenca * 5 - Math.max(0, dp - LIMIARES.despesaLimite) * 100;
        r.caixa = { nota: Math.round(clamp(nota, 0, 100)), numero: `descontos ${pct(d, 1)}; ${f.caixa.comDiferenca} caixa(s) com diferença`, comoSubir: 'Limite de desconto no caixa, conferência das diferenças e controle das despesas.' };
    }
    // fiado
    if (!f.fiado.contas)
        r.fiado = { nota: f.temDados ? 100 : null, numero: f.temDados ? 'nenhum fiado em aberto' : 'sem dados', comoSubir: 'Manter o fiado com data combinada.' };
    else {
        const p = f.receita > 0 ? f.fiado.vencido / f.receita : 1;
        r.fiado = { nota: Math.round(clamp(100 - p * 300, 0, 100)), numero: `vencido ${brl(f.fiado.vencido)} (${pct(p, 1)} da receita)`, comoSubir: 'Cobrar as vencidas e não abrir fiado novo para quem deve.' };
    }
    const vals = Object.values(r).map((x) => x.nota).filter((x) => x != null);
    return { pilares: r, nota: vals.length ? Math.round(vals.reduce((s, x) => s + x, 0) / vals.length) : null, pilaresComNota: vals.length };
}
export async function pacoteDoMes(tx, opts) {
    const { mes, hoje } = opts;
    const hojeMes = hoje.slice(0, 7);
    const [ano, m] = mes.split('-').map(Number);
    const nd = diasNoMes(ano, m);
    const emCurso = mes === hojeMes;
    const diaCorte = emCurso ? Number(hoje.slice(8, 10)) : nd;
    const from = `${mes}-01`, to = `${mes}-${String(diaCorte).padStart(2, '0')}`;
    const tolCaixa = Number(await lerConfig('tolerancia_caixa', tx).catch(() => 500)) || 500;
    const coberturaMeta = Number(await lerConfig('estoque_dias_cobertura', tx).catch(() => 7)) || 7;
    // comparações: no mês em curso, os outros meses são cortados no MESMO dia (comparação justa)
    const janela = (k) => { const [a, mm] = k.split('-').map(Number); const d = Math.min(diaCorte, diasNoMes(a, mm)); return { from: `${k}-01`, to: `${k}-${String(emCurso ? d : diasNoMes(a, mm)).padStart(2, '0')}` }; };
    const cur = await carregarJanela(tx, from, to, tolCaixa);
    const prevK = [1, 2, 3].map((i) => somarMeses(mes, -i));
    const prevs = [];
    for (const k of prevK) {
        const j = janela(k);
        prevs.push(await carregarJanela(tx, j.from, j.to, tolCaixa));
    }
    const anoJ = janela(somarMeses(mes, -12));
    const anoF = await carregarJanela(tx, anoJ.from, anoJ.to, tolCaixa);
    const prev = prevs[0].temDados ? prevs[0] : null;
    const prev3 = prevs.filter((f) => f.temDados && f.pedidos > 0);
    const x = await carregarExtras(tx, from, to);
    const fiadoAtual = await saldosFiado(tx, to);
    // meses completos (para previsão e gráfico de 12 meses)
    const serie12 = [];
    for (let i = 11; i >= 0; i--) {
        const k = somarMeses(mes, -i);
        if (i === 0) {
            serie12.push({ mes: k, receita: cur.temDados ? cur.receita : null, lucro: cur.temDados && cur.cobertura >= 0.5 ? cur.lucro : null, margem: cur.margemBruta });
            continue;
        }
        const pi = prevK.indexOf(k);
        const f = pi >= 0 && !emCurso ? prevs[pi] : await carregarResumo(tx, k);
        serie12.push({ mes: k, receita: f.temDados ? f.receita : null, lucro: f.temDados && f.cobertura >= 0.5 ? f.lucro : null, margem: f.margemBruta });
    }
    const diasHist = x.primeiroDia ? diasEntre(x.primeiroDia, to) + 1 : 0;
    const geralSem = confiancaGeral(diasHist, cur.pedidos, null);
    const geralCom = confiancaGeral(diasHist, cur.pedidos, cur.cozinha.total ? cur.cozinha.pctHorarios : null);
    const fatorMes = nd / diaCorte;
    const ctx = { mes, emCurso, diaCorte, fatorMes, cur, prev, prev3, ano: anoF.temDados ? anoF : null, x, geral: geralSem.nivel, geralTempos: geralCom.nivel, L: LIMIARES, coberturaMeta, hoje, x_fiadoAtual: fiadoAtual, diasHist };
    // ---------- roda os detectores ----------
    const achados = [];
    const detectores = [];
    for (const d of DETECTORES) {
        let r;
        // amostra mínima geral: 7+ dias com venda no período (o fiado é foto do saldo e não depende disso)
        if (d.pilar !== 'fiado' && cur.diasVenda < MIN_DIAS_VENDA) {
            detectores.push({ id: d.id, nome: d.nome, pilar: d.pilar, limiar: d.limiar, amostraMin: `${d.amostraMin}; ${MIN_DIAS_VENDA}+ dias com venda`, status: cur.temDados ? 'AMOSTRA' : 'SEM_DADOS', achados: 0 });
            continue;
        }
        try {
            r = d.run(ctx);
        }
        catch (e) {
            r = 'SEM_DADOS';
            console.error(`[analise] detector ${d.id} falhou:`, e.message);
        }
        const status = r === 'AMOSTRA' ? 'AMOSTRA' : r === 'SEM_DADOS' ? 'SEM_DADOS' : r.length ? 'DISPAROU' : 'NAO_DISPAROU';
        if (Array.isArray(r))
            achados.push(...r);
        detectores.push({ id: d.id, nome: d.nome, pilar: d.pilar, limiar: d.limiar, amostraMin: d.amostraMin, status, achados: Array.isArray(r) ? r.length : 0 });
    }
    // ---------- seções com deduplicação por código do fato ----------
    const usados = new Set();
    const pega = (pool, max) => { const out = []; for (const a of pool) {
        if (out.length >= max)
            break;
        if (usados.has(a.codigo))
            continue;
        usados.add(a.codigo);
        out.push(a);
    } return out; };
    const pesoGargalo = (a) => PESO_CONF[a.confianca] * ((a.impacto?.tipo === 'LUCRO' ? a.impacto.centsMes / 100 : 0) + a.gravidade * 300);
    const naoCmp = achados.filter((a) => !a.comparativo);
    const gargalos = pega(naoCmp.filter((a) => a.sentido === 'NEGATIVO' && ((a.impacto && a.impacto.tipo === 'LUCRO') || a.gravidade >= 0.6)).sort((a, b) => pesoGargalo(b) - pesoGargalo(a)), 5);
    const comparativo = pega(achados.filter((a) => a.comparativo).sort((a, b) => Math.abs(b.variacao ?? 0) - Math.abs(a.variacao ?? 0)), 5);
    const positivos = pega(achados.filter((a) => a.sentido === 'POSITIVO').sort((a, b) => PESO_CONF[b.confianca] * b.gravidade - PESO_CONF[a.confianca] * a.gravidade), 5);
    const negativos = pega(achados.filter((a) => a.sentido === 'NEGATIVO').sort((a, b) => PESO_CONF[b.confianca] * b.gravidade - PESO_CONF[a.confianca] * a.gravidade), 5);
    const motivoMenos = (lista, nome) => (lista.length >= 5 ? null : lista.length === 0
        ? `Nenhum ${nome} passou na amostra mínima e no limiar este mês.`
        : `Só ${lista.length} ${nome} passaram na amostra mínima e no limiar (5 é o máximo, não a meta).`);
    // ---------- dinheiro na mesa (sem dupla contagem) ----------
    const porGrupo = new Map();
    for (const a of naoCmp) {
        if (!a.impacto || a.impacto.tipo !== 'LUCRO' || a.sentido === 'POSITIVO')
            continue;
        const atual = porGrupo.get(a.impacto.grupo);
        if (!atual || a.impacto.centsMes * PESO_CONF[a.confianca] > atual.impacto.centsMes * PESO_CONF[atual.confianca])
            porGrupo.set(a.impacto.grupo, a);
    }
    const itensMesa = [...porGrupo.values()].map((a) => ({ id: a.id, codigo: a.codigo, titulo: a.titulo, centsMes: a.impacto.centsMes, considerado: Math.round(a.impacto.centsMes * PESO_CONF[a.confianca]), confianca: a.confianca, premissa: a.impacto.premissa, grupo: a.impacto.grupo }))
        .sort((a, b) => b.considerado - a.considerado);
    const caixaGrupos = new Map();
    for (const a of naoCmp)
        if (a.impacto?.tipo === 'CAIXA') {
            const g = caixaGrupos.get(a.impacto.grupo);
            if (!g || a.impacto.centsMes > g.impacto.centsMes)
                caixaGrupos.set(a.impacto.grupo, a);
        }
    const dinheiroNaMesa = {
        lucroMesCents: itensMesa.reduce((s, i) => s + i.considerado, 0),
        itens: itensMesa,
        caixaCents: [...caixaGrupos.values()].reduce((s, a) => s + a.impacto.centsMes, 0),
        caixaItens: [...caixaGrupos.values()].map((a) => ({ id: a.id, titulo: a.titulo, cents: a.impacto.centsMes, premissa: a.impacto.premissa })),
        premissa: 'Estimativa conservadora: soma das oportunidades de lucro extra por mês, contando só a maior de cada grupo (mesmo dinheiro não entra duas vezes) e descontando pela confiança (alta 100%, média 70%, baixa 40%). Dinheiro a recuperar ou liberar (fiado, estoque parado) aparece à parte e não entra na soma.',
    };
    // ---------- destravas por horizonte ----------
    const candidatas = naoCmp.filter((a) => a.acao && a.horizonte && a.sentido !== 'POSITIVO')
        .sort((a, b) => (b.impacto?.tipo === 'LUCRO' ? b.impacto.centsMes * PESO_CONF[b.confianca] : 0) - (a.impacto?.tipo === 'LUCRO' ? a.impacto.centsMes * PESO_CONF[a.confianca] : 0) || b.gravidade - a.gravidade);
    const usadosDestrava = new Set();
    const destrava = (h) => {
        const out = [];
        for (const a of candidatas) {
            if (out.length >= 5)
                break;
            if (a.horizonte !== h || usadosDestrava.has(a.codigo))
                continue;
            usadosDestrava.add(a.codigo);
            out.push({ achadoId: a.id, codigo: a.codigo, acao: a.acao, porque: a.frase, impacto: a.impacto, confianca: a.confianca, esforco: a.esforco, dono: a.dono });
        }
        return out;
    };
    const destravas = { CURTO: destrava('CURTO'), MEDIO: destrava('MEDIO'), LONGO: destrava('LONGO') };
    // ---------- técnicas de gestão ligadas aos achados ----------
    const tecMap = new Map();
    for (const a of naoCmp.filter((x) => x.sentido !== 'POSITIVO'))
        for (const t of a.tecnicas) {
            const e = tecMap.get(t) ?? { achados: [], peso: 0 };
            if (!e.achados.some((y) => y.codigo === a.codigo))
                e.achados.push({ id: a.id, codigo: a.codigo, titulo: a.titulo });
            e.peso += (a.impacto?.tipo === 'LUCRO' ? a.impacto.centsMes / 100 : 0) + a.gravidade * 100;
            tecMap.set(t, e);
        }
    const tecnicas = [...tecMap.entries()].sort((a, b) => b[1].peso - a[1].peso).slice(0, 6)
        .map(([id, e]) => ({ id, ...TECNICAS[id], achados: e.achados.slice(0, 4) }));
    // ---------- plano de 30 dias (máx. 5 ações, semana a semana) ----------
    const fontesPlano = [...destravas.CURTO, ...destravas.MEDIO].filter((d) => d.acao);
    const plano = fontesPlano.slice(0, 5).map((d, i) => {
        const a = naoCmp.find((y) => y.codigo === d.codigo && y.id === d.achadoId);
        return {
            id: `${a.id}:${a.codigo}`, texto: a.acao, meta: a.meta ?? 'Executar e acompanhar no próximo relatório', semana: Math.min(4, i + 1),
            esperadoCents: a.impacto?.tipo === 'LUCRO' ? a.impacto.centsMes : null, premissa: a.impacto?.premissa ?? null, dono: a.dono, metrica: a.metrica ?? null, status: 'PENDENTE',
        };
    });
    // ---------- indicadores (para medir o plano no mês seguinte) ----------
    const indicadores = montarIndicadores(cur, x, ctx);
    const resultadoPlanoAnterior = medirPlano(opts.acoesMesAnterior ?? null, indicadores, opts.mesAnteriorStatus ?? null);
    // ---------- nota ----------
    const baseV = (f, ps) => { const b = ps.filter((p) => p.temDados && p.pedidos > 0); return b.length ? { ref: b.reduce((s, p) => s + p.receita, 0) / b.length, nome: b.length >= 2 ? `média de ${b.length} meses` : 'mês anterior' } : null; };
    const notaAtual = notaPilares(cur, baseV(cur, prevs));
    let notaAnterior = null;
    if (prev) {
        const antes = [2, 3, 4].map((i) => somarMeses(mes, -i));
        const pp3 = [];
        for (const k of antes) {
            const j = janela(k);
            pp3.push(k === prevK[1] ? prevs[1] : k === prevK[2] ? prevs[2] : await carregarJanela(tx, j.from, j.to, tolCaixa));
        }
        notaAnterior = notaPilares(prev, baseV(prev, pp3));
    }
    const nota = {
        valor: notaAtual.nota, anterior: notaAnterior?.nota ?? null,
        variacao: notaAtual.nota != null && notaAnterior?.nota != null ? notaAtual.nota - notaAnterior.nota : null,
        pilaresComNota: notaAtual.pilaresComNota,
        pilares: PILARES.map((p) => ({
            id: p.id, nome: p.nome, ...notaAtual.pilares[p.id], anterior: notaAnterior?.pilares[p.id].nota ?? null,
            variacao: notaAtual.pilares[p.id].nota != null && notaAnterior?.pilares[p.id].nota != null ? notaAtual.pilares[p.id].nota - notaAnterior.pilares[p.id].nota : null,
        })),
        regra: 'Média simples dos pilares que têm dados. Pilar sem dados fica de fora (não vale zero). Cada pilar mostra o número que o justifica.',
    };
    // ---------- mais vende × mais lucra e cardápio ----------
    const mx = matriz(ctx);
    const quad = new Map((mx?.itens ?? []).map((i) => [i.id, i]));
    const vende = [...x.produtos].filter((p) => p.id != null).sort((a, b) => b.qtd - a.qtd).slice(0, 5).map((p) => ({ name: p.name, qtd: p.qtd, receita: p.receita, quadrante: quad.get(p.id)?.quadrante ?? null, leitura: quad.get(p.id)?.acao ?? 'Sem custo cadastrado: cadastre para saber a margem.' }));
    const lucra = x.produtos.filter((p) => p.custo != null && p.qtdComCusto > 0).map((p) => ({ name: p.name, id: p.id, qtd: p.qtd, lucro: p.receitaComCusto - p.custo, margem: p.receitaComCusto ? (p.receitaComCusto - p.custo) / p.receitaComCusto : 0 }))
        .sort((a, b) => b.lucro - a.lucro).slice(0, 5).map((p) => ({ ...p, quadrante: p.id != null ? quad.get(p.id)?.quadrante ?? null : null, leitura: p.id != null ? quad.get(p.id)?.acao ?? '' : '' }));
    // ---------- estoque ----------
    const estoque = {
        controlados: x.estoque.length,
        cobertura: x.estoque.map((e) => { const dia = e.vendidos30 / 30; return { name: e.name, qtd: e.qtd, porDia: Math.round(dia * 10) / 10, dias: dia > 0 ? Math.round(e.qtd / dia) : null, meta: coberturaMeta, situacao: dia <= 0 ? (e.qtd > 0 ? 'SEM_GIRO' : 'ZERADO') : e.qtd <= 0 ? 'ZERADO' : e.qtd / dia < coberturaMeta / 2 ? 'BAIXO' : e.qtd / dia > coberturaMeta * LIMIARES.capitalParadoX ? 'PARADO' : 'OK' }; })
            .sort((a, b) => (a.dias ?? 9999) - (b.dias ?? 9999)),
        rupturas: cur.estoque.zerados, perdasPorMotivo: x.perdasMotivo, perdasCents: cur.estoque.perdas, divergencias: x.divergencias,
        custoFornecedor: agruparFornecedores(x.fornecedores),
        compraSugerida: x.estoque.map((e) => { const dia = e.vendidos30 / 30; const q = Math.max(0, Math.ceil(dia * coberturaMeta - e.qtd)); return { name: e.name, comprar: q, conta: `${num1(dia)}/dia × ${coberturaMeta} dias − ${e.qtd} em estoque` }; }).filter((c) => c.comprar > 0),
    };
    // ---------- clientes e fiado (+ recuperação de vendas) ----------
    const noMes = x.clientes.filter((k) => k.noMes);
    const novos = noMes.filter((k) => k.primeiro >= from).length;
    const aging = [[0, 7], [8, 15], [16, 30], [31, 60], [61, 100000]].map(([a, b]) => { const l = fiadoAtual.filter((f) => f.idade >= a && f.idade <= b); return { faixa: b > 1000 ? `${a}+ dias` : `${a}–${b} dias`, contas: l.length, cents: l.reduce((s, f) => s + f.saldo, 0) }; });
    const promessasVencidas = fiadoAtual.filter((f) => f.prometido && f.prometido < to);
    const porCli = new Map();
    for (const f of fiadoAtual)
        porCli.set(f.cliente, (porCli.get(f.cliente) ?? 0) + f.saldo);
    const valsCli = [...porCli.values()].sort((a, b) => b - a);
    const totF = valsCli.reduce((s, v) => s + v, 0);
    let accF = 0, conc = 0;
    for (const v of valsCli) {
        accF += v;
        conc++;
        if (accF >= totF * 0.8)
            break;
    }
    const prazoMedio = x.prazos.length ? x.prazos.reduce((s, v) => s + v, 0) / x.prazos.length : null;
    const recuperacao = [];
    if (cur.fiado.vencido > 0)
        recuperacao.push(`Começar pelas ${promessasVencidas.length} contas com data combinada já vencida (${brl(promessasVencidas.reduce((s, f) => s + f.saldo, 0))}): a pessoa já se comprometeu, a conversa é mais fácil.`);
    const velhas = fiadoAtual.filter((f) => f.idade > 30);
    if (velhas.length)
        recuperacao.push(`${velhas.length} conta(s) com mais de 30 dias (${brl(velhas.reduce((s, f) => s + f.saldo, 0))}): propor acordo de parcelamento; quanto mais velha, menor a chance de receber.`);
    if (conc && valsCli.length >= 4 && conc <= 3)
        recuperacao.push(`${conc} cliente(s) concentram 80% do fiado: negociar com eles primeiro rende mais por contato.`);
    const semData = fiadoAtual.filter((f) => !f.prometido).length;
    if (semData)
        recuperacao.push(`${semData} conta(s) sem data combinada: registrar a data em toda venda fiado (sem data, ninguém sabe quando cobrar).`);
    if (prazoMedio != null)
        recuperacao.push(`Prazo médio de recebimento: ${num1(prazoMedio)} dias (${x.prazos.length} contas pagas em 90 dias).`);
    if (!recuperacao.length)
        recuperacao.push('Sem fiado em aberto: nada a recuperar.');
    const clientesFiado = {
        clientes: { identificados: noMes.length, novos, recorrentes: noMes.length - novos, comConsentimento: x.clientes.filter((k) => k.ofertas).length },
        fiado: {
            totalCents: cur.fiado.total, vencidoCents: cur.fiado.vencido, contas: cur.fiado.contas, vencidas: cur.fiado.vencidas,
            inadimplenciaPct: cur.fiado.total ? cur.fiado.mais30 / cur.fiado.total : null, prazoMedioDias: prazoMedio, concentracao80: valsCli.length ? conc : null, clientesComFiado: valsCli.length,
            aging, promessasVencidas: promessasVencidas.length,
        },
        recuperacao,
        aviso: 'Sem nomes nem telefones (o relatório pode ir para o Dono em PDF). A cobrança em si é feita na Recuperação de vendas.',
    };
    // ---------- previsão do próximo mês ----------
    const previsao = preverProximo(mes, serie12, cur, ctx);
    // ---------- resumo executivo (3 frases por regra) ----------
    const baseRes = prev3.length >= 2 ? { ref: prev3.reduce((s, f) => s + f.receita, 0) / prev3.length, nome: `a média dos ${prev3.length} meses anteriores` } : prev ? { ref: prev.receita, nome: 'o mês anterior' } : null;
    const f1 = !cur.temDados ? `Sem dados de vendas em ${nomeMes(mes)}.`
        : `Em ${nomeMes(mes)}${emCurso ? ` (até o dia ${diaCorte})` : ''} o restaurante vendeu ${brl(cur.receita)}${baseRes && baseRes.ref > 0 ? ` (${sPct(cur.receita / baseRes.ref - 1)} contra ${baseRes.nome}${emCurso ? ' no mesmo período' : ''})` : ' — ainda sem mês anterior para comparar'}${cur.cobertura >= 0.5 ? `, com resultado de ${brl(cur.lucro)}` : ''}.`;
    const f2 = gargalos[0] ? `O maior problema: ${gargalos[0].frase}` : 'Nenhum gargalo passou na amostra mínima este mês.';
    const topD = [...destravas.CURTO, ...destravas.MEDIO, ...destravas.LONGO].filter((d) => d.impacto?.tipo === 'LUCRO').sort((a, b) => b.impacto.centsMes - a.impacto.centsMes)[0];
    const f3 = topD ? `A maior oportunidade: ${topD.acao} (≈ ${brl0(topD.impacto.centsMes)}/mês, estimativa).` : dinheiroNaMesa.lucroMesCents > 0 ? `Há ${brl0(dinheiroNaMesa.lucroMesCents)}/mês em oportunidades estimadas.` : 'Sem oportunidade em R$ com dados suficientes ainda.';
    const confianca = {
        nivel: geralSem.nivel, motivos: geralSem.motivos, nivelTempos: geralCom.nivel, motivosTempos: geralCom.motivos,
        diasHistorico: diasHist, pedidos: cur.pedidos, pctHorarios: cur.cozinha.total ? cur.cozinha.pctHorarios : null, coberturaCusto: cur.cobertura,
        comoMelhorar: [
            ...(diasHist < 60 ? ['Mais histórico: a confiança sobe com 60+ dias de uso.'] : []),
            ...(cur.pedidos < 500 ? ['Registrar todas as vendas no sistema (500+ pedidos no período dão confiança alta).'] : []),
            ...(cur.cobertura < 0.9 ? ['Cadastrar o custo de todos os produtos.'] : []),
            ...(cur.cozinha.total && cur.cozinha.pctHorarios < 0.8 ? ['Cozinha tocar Iniciar e Pronto em todos os pedidos.'] : []),
        ],
        primeirosMeses: diasHist < 60,
        aviso: diasHist < 60 ? 'Primeiros meses de uso: confiança baixa ou média. O relatório mostra os números, mas não finge tendência.' : null,
    };
    const metodologia = [
        'Todos os números vêm dos registros do sistema (vendas com o custo congelado no momento da venda, pagamentos, descontos, cancelamentos, despesas, estoque, fiado e horários dos pedidos). Nenhuma IA escreveu ou calculou nada.',
        'Cada achado vem de um detector com limiar e amostra mínima escritos. Abaixo da amostra mínima o achado não aparece.',
        emCurso ? `Mês em andamento: as comparações usam os outros meses cortados no mesmo dia (até o dia ${diaCorte}); valores "por mês" projetam o período proporcionalmente.` : 'Mês encerrado: comparações com meses inteiros.',
        'Um fato aparece em uma seção só; "5" é o máximo, nunca uma meta; meses sem dados aparecem como "sem dados" (nunca zero).',
        'Todo valor em R$ marcado como estimativa traz a premissa ao lado.',
        'Sugestões de apoio à decisão baseadas nos dados. Não substituem contador.',
    ];
    return {
        versao: 1, mes, nome: nomeMes(mes), emCurso, diaCorte, diasNoMes: nd, periodo: { from, to }, geradoEm: new Date().toISOString(),
        resumo: [f1, f2, f3],
        nota, dinheiroNaMesa,
        gargalos, comparativo, positivos, negativos,
        avisosSecoes: { gargalos: motivoMenos(gargalos, 'gargalos'), comparativo: motivoMenos(comparativo, 'pontos do comparativo'), positivos: motivoMenos(positivos, 'pontos positivos'), negativos: motivoMenos(negativos, 'pontos negativos') },
        destravas, tecnicas,
        maisVende: vende, maisLucra: lucra,
        cardapio: mx ? { corteQtd: Math.round(mx.corte * 10) / 10, metaMargem: mx.meta, itens: mx.itens, semCusto: mx.semCusto, regra: `Popular = vende pelo menos 70% da média por item (${num1(mx.corte)} un.); margem boa = ${pct(mx.meta)} ou mais. Produto sem custo fica de fora.` } : { corteQtd: null, metaMargem: LIMIARES.metaMargem, itens: [], semCusto: x.produtos.filter((p) => p.custoAtual == null).map((p) => ({ name: p.name, qtd: p.qtd })), regra: 'Precisa de 6 produtos com custo e 100 itens vendidos no mês.' },
        estoque, clientesFiado, plano, resultadoPlanoAnterior, previsao,
        serie12, numeros: resumoNumeros(cur, prev),
        confianca, metodologia, achados, detectores, indicadores, limiares: { ...LIMIARES, coberturaDias: coberturaMeta, toleranciaCaixa: tolCaixa },
    };
}
/** Resumo mensal leve (gráfico de 12 meses): receita e lucro de um mês inteiro. */
async function carregarResumo(tx, k) {
    const [a, m] = k.split('-').map(Number);
    const from = `${k}-01`, to = `${k}-${String(diasNoMes(a, m)).padStart(2, '0')}`;
    const q = async (s) => (await tx.execute(s)).rows;
    const [v] = await q(sql `SELECT COALESCE(SUM(oi.unit_price_cents*oi.quantity),0) AS bruto,
      COALESCE(SUM(oi.unit_cost_cents*oi.quantity) FILTER (WHERE oi.unit_cost_cents IS NOT NULL),0) AS custo,
      COALESCE(SUM(oi.unit_price_cents*oi.quantity) FILTER (WHERE oi.unit_cost_cents IS NOT NULL),0) AS bcc
    FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE ${R('o.created_at', from, to)} AND ${LIVE}`);
    const [d] = await q(sql `SELECT COALESCE(SUM(d.amount_cents),0) AS c FROM discounts d JOIN accounts a ON a.id = d.account_id WHERE ${R('d.created_at', from, to)} AND a.status <> 'CANCELLED'`);
    const [e] = await q(sql `SELECT COALESCE(SUM(amount_cents),0) AS c FROM expenses WHERE cancelled_at IS NULL AND date BETWEEN ${from}::date AND ${to}::date`);
    const [t] = await q(sql `SELECT COALESCE(ROUND(SUM(p.amount_cents::bigint * COALESCE(p.taxa_bp, pm.taxa_bp) / 10000.0)),0) AS c FROM payments p JOIN payment_methods pm ON pm.id = p.method_id WHERE p.reversed_at IS NULL AND ${R('p.created_at', from, to)}`);
    const bruto = n(v.bruto), receita = bruto - n(d.c), cob = bruto ? n(v.bcc) / bruto : 0;
    return { temDados: bruto > 0 || n(e.c) > 0, receita, lucro: receita - n(v.custo) - n(e.c) - n(t.c), cobertura: cob, margemBruta: cob >= 0.5 && receita > 0 && n(v.bcc) ? (receita - n(v.custo) - (bruto - n(v.bcc)) * (n(v.custo) / n(v.bcc))) / receita : null };
}
function agruparFornecedores(fs) {
    const g = new Map();
    for (const f of fs) {
        const k = `${f.pid}|${f.fornecedor}`;
        const a = g.get(k) ?? [];
        a.push(f);
        g.set(k, a);
    }
    return [...g.values()].filter((a) => a.length >= 2).map((a) => ({ produto: a[0].name, fornecedor: a[0].fornecedor, primeiro: a[0].custo, ultimo: a[a.length - 1].custo, variacao: a[0].custo ? a[a.length - 1].custo / a[0].custo - 1 : 0, entradas: a.length }))
        .sort((a, b) => b.variacao - a.variacao).slice(0, 10);
}
function resumoNumeros(cur, prev) {
    const linha = (nome, a, b, tipo) => ({ nome, atual: a, anterior: prev ? b : null, tipo });
    return [
        linha('Vendas (receita)', cur.temDados ? cur.receita : null, prev?.receita ?? null, 'BRL'),
        linha('Pedidos', cur.temDados ? cur.pedidos : null, prev?.pedidos ?? null, 'UN'),
        linha('Ticket médio', cur.ticket, prev?.ticket ?? null, 'BRL'),
        linha('Margem bruta', cur.margemBruta, prev?.margemBruta ?? null, 'PCT'),
        linha('Despesas', cur.temDados ? cur.despesas : null, prev?.despesas ?? null, 'BRL'),
        linha('Resultado', cur.temDados && cur.cobertura >= 0.5 ? cur.lucro : null, prev && prev.cobertura >= 0.5 ? prev.lucro : null, 'BRL'),
        linha('Descontos', cur.descontosPct, prev?.descontosPct ?? null, 'PCT'),
        linha('Fiado vencido', cur.fiado.contas ? cur.fiado.vencido : cur.temDados ? 0 : null, prev ? prev.fiado.vencido : null, 'BRL'),
    ];
}
function montarIndicadores(cur, x, c) {
    const out = {
        vendas: cur.temDados ? cur.receita : null, pedidos: cur.pedidos || null, contas: cur.contas || null, ticket: cur.ticket, margem: cur.margemBruta,
        lucro: cur.cobertura >= 0.5 ? cur.lucro : null, despesas: cur.despesas || null, descontos: cur.descontosPct, cancelamentos: cur.cancelPct,
        cancelPerda: cur.perdaCancel, 'caixa.diferenca': cur.caixa.comDiferenca, semCusto: cur.bruto ? 1 - cur.cobertura : null,
        'cozinha.horarios': cur.cozinha.total ? cur.cozinha.pctHorarios : null, 'cozinha.esquecidos': cur.cozinha.esquecidos, 'fila.confirmacao': median(x.fila),
        'estoque.perdas': cur.estoque.perdas, 'fiado.vencido': cur.fiado.vencido, 'fiado.prazo': x.prazos.length ? x.prazos.reduce((s, v) => s + v, 0) / x.prazos.length : null,
        recusados: cur.recusados, online: (() => { const t = Object.values(x.origem).reduce((s, v) => s + v, 0); return t ? (t - (x.origem.CAIXA ?? 0)) / t : null; })(),
    };
    for (const p of x.produtos)
        if (p.id != null && p.qtd)
            out[`produto:${p.id}`] = { preco: Math.round(p.receita / p.qtd), qtd: p.qtd, lucro: p.custo != null ? p.receitaComCusto - p.custo : 0 };
    for (const k of cur.categorias)
        if (k.receita)
            out[`categoria:${k.cat}`] = (k.receita - k.custo) / k.receita;
    for (const [cat, v] of Object.entries(cur.despesasCat))
        out[`despesa:${cat}`] = v;
    for (const z of cur.estoque.zerados)
        out[`ruptura:${z.id}`] = z.diasZero;
    const porDow = new Map();
    for (const d of x.porDia) {
        const w = new Date(d.dia + 'T12:00:00Z').getUTCDay();
        const a = porDow.get(w) ?? [];
        a.push(d.bruto);
        porDow.set(w, a);
    }
    for (const [w, a] of porDow)
        out[`dia:${w}`] = Math.round(a.reduce((s, v) => s + v, 0) / a.length);
    void c;
    return out;
}
/** Resultado do plano do mês passado: para cada ação, feito/não feito e o efeito medido. */
function medirPlano(acoes, ind, status) {
    if (!acoes)
        return { existe: false, statusRelatorio: status, texto: 'Sem plano registrado no relatório do mês anterior.', itens: [] };
    const fmt = (v, u) => (u === 'BRL' ? brl(v) : u === 'PCT' ? pct(v, 1) : u === 'MIN' ? `${num1(v)} min` : u === 'DIAS' ? `${num1(v)} dias` : String(Math.round(v)));
    const itens = acoes.map((a) => {
        let efeito = 'Sem medição automática para esta ação.';
        let depois = null;
        if (a.metrica && a.metrica.antes != null) {
            depois = ind[a.metrica.chave] ?? null;
            if (a.metrica.unidade === 'PRODUTO' && typeof a.metrica.antes === 'object') {
                const an = a.metrica.antes;
                const de = depois;
                efeito = !de ? 'O produto não vendeu neste mês.'
                    : `preço ${sPct(an.preco ? de.preco / an.preco - 1 : 0)}, vendas ${sPct(an.qtd ? de.qtd / an.qtd - 1 : 0)}, lucro do item ${de.lucro - an.lucro >= 0 ? '+' : '−'}${brl(Math.abs(de.lucro - an.lucro))}`;
            }
            else if (typeof a.metrica.antes === 'number') {
                efeito = depois == null || typeof depois !== 'number' ? 'Sem dado neste mês para comparar.' : `${fmt(a.metrica.antes, a.metrica.unidade)} → ${fmt(depois, a.metrica.unidade)}`;
            }
        }
        return { id: a.id, texto: a.texto, meta: a.meta, status: a.status, antes: a.metrica?.antes ?? null, depois, efeito };
    });
    const feitos = itens.filter((i) => i.status === 'FEITO').length;
    return { existe: true, statusRelatorio: status, texto: `${feitos} de ${itens.length} ações marcadas como feitas.`, itens };
}
function preverProximo(mes, serie, cur, c) {
    const prox = somarMeses(mes, 1);
    const completos = serie.slice(0, -1).filter((s) => s.receita != null).slice(-3);
    const atualProj = c.emCurso ? (cur.temDados ? Math.round(cur.receita * c.fatorMes) : null) : (cur.temDados ? cur.receita : null);
    const baseLista = [...completos.map((s) => s.receita), ...(atualProj != null ? [atualProj] : [])].slice(-3);
    if (!baseLista.length)
        return { ok: false, mes: prox, nome: nomeMes(prox), motivo: 'Sem meses com vendas para prever.' };
    const media = Math.round(baseLista.reduce((s, v) => s + v, 0) / baseLista.length);
    // sazonalidade: só com os dois meses do ano anterior (o equivalente ao atual e ao próximo)
    const anoAtual = serie.find((s) => s.mes === somarMeses(mes, -12))?.receita ?? null;
    const anoProx = serie.find((s) => s.mes === somarMeses(mes, -11))?.receita ?? null;
    const fator = anoAtual && anoProx ? anoProx / anoAtual : null;
    const centro = Math.round(media * (fator ?? 1));
    const margem = cur.margemLiquida;
    return {
        ok: true, mes: prox, nome: nomeMes(prox), vendasCents: centro, faixa: [Math.round(centro * 0.9), Math.round(centro * 1.1)],
        lucroCents: margem != null ? Math.round(centro * margem) : null,
        conta: `média dos últimos ${baseLista.length} mês(es) (${baseLista.map((v) => brl0(v)).join(' + ')}) ÷ ${baseLista.length} = ${brl0(media)}${c.emCurso ? ' (o mês atual entra projetado pelo ritmo proporcional)' : ''}` +
            (fator ? ` × sazonalidade do ano anterior (${brl0(anoProx)} ÷ ${brl0(anoAtual)} = ${num1(fator)}) = ${brl0(centro)}` : '; sem o mesmo período do ano anterior, sem ajuste de sazonalidade') +
            (margem != null ? `. Lucro = vendas × margem líquida do mês (${pct(margem)}).` : '.'),
        confianca: menorConf(c.geral, baseLista.length >= 3 ? 'ALTA' : baseLista.length === 2 ? 'MEDIA' : 'BAIXA'),
        aviso: 'Previsão, não promessa: faixa de ±10% em volta do ponto central.',
    };
}
// ======================================================================================
// 6) TEXTOS: resumo para WhatsApp e roteiro da reunião
// ======================================================================================
export function textoWhatsapp(p, nomeRestaurante) {
    const linhas = [];
    linhas.push(`*Relatório ONE UP — ${p.nome}*${p.emCurso ? ` (parcial, até o dia ${p.diaCorte})` : ''} · ${nomeRestaurante}`);
    linhas.push(p.nota.valor != null ? `Nota do restaurante: *${p.nota.valor}/100*${p.nota.variacao != null ? ` (${p.nota.variacao >= 0 ? '▲' : '▼'} ${Math.abs(p.nota.variacao)} vs mês anterior)` : ''}` : 'Nota do restaurante: ainda sem dados suficientes');
    linhas.push(p.dinheiroNaMesa.lucroMesCents > 0 ? `Dinheiro na mesa: *≈ ${brl0(p.dinheiroNaMesa.lucroMesCents)}/mês* de lucro extra possível (estimativa)` : 'Dinheiro na mesa: sem oportunidade em R$ com dados suficientes');
    if (p.dinheiroNaMesa.caixaCents > 0)
        linhas.push(`A recuperar/liberar: ${brl0(p.dinheiroNaMesa.caixaCents)} (fiado/estoque, uma vez)`);
    linhas.push(p.resumo[0]);
    const top = p.plano.slice(0, 3);
    if (top.length) {
        linhas.push('*Top 3 ações:*');
        top.forEach((a, i) => linhas.push(`${i + 1}. ${a.texto}${a.esperadoCents ? ` (≈ +${brl0(a.esperadoCents)}/mês)` : ''}`));
    }
    else
        linhas.push('Ações: ainda sem achados com amostra suficiente.');
    linhas.push('Detalhes e premissas na nossa reunião. — ONE UP');
    return linhas.slice(0, 10).join('\n');
}
export function roteiroReuniao(p) {
    const g = p.gargalos[0];
    const comecar = p.positivos[0] ? `Abrir pelo que está indo bem: ${p.positivos[0].frase} (o que NÃO mexer).` : `Abrir pelo resumo: ${p.resumo[0]}`;
    const numero = p.dinheiroNaMesa.lucroMesCents > 0 ? `≈ ${brl0(p.dinheiroNaMesa.lucroMesCents)}/mês de dinheiro na mesa (estimativa; premissas no relatório).` : p.nota.valor != null ? `Nota ${p.nota.valor}/100.` : 'Receita do mês.';
    const decisoes = p.plano.slice(0, 3).map((a) => `${a.texto} — meta: ${a.meta}${a.dono ? ` (responsável sugerido: ${a.dono})` : ''}`);
    const objecoes = [];
    for (const a of [...p.gargalos, ...p.negativos]) {
        if (objecoes.length >= 4)
            break;
        const ja = (t) => objecoes.some((o) => o.objecao === t);
        if ((a.id === 'M01' || a.id === 'M02') && ja('"Se eu subir o preço, o cliente some."'))
            continue;
        if (a.id.startsWith('F') && ja('"Cobrar fiado espanta o cliente."'))
            continue;
        if (a.id.startsWith('O') && objecoes.some((o) => o.objecao.startsWith('"A cozinha')))
            continue;
        if (a.id.startsWith('E') && ja('"Estoque eu controlo de cabeça."'))
            continue;
        if (a.id === 'M01' || a.id === 'M02')
            objecoes.push({ objecao: '"Se eu subir o preço, o cliente some."', resposta: `Teste em um item só por 30 dias: a premissa já considera 5% menos volume e o próximo relatório mede o efeito real (${a.numero}).` });
        else if (a.id === 'C01')
            objecoes.push({ objecao: '"Desconto fideliza o cliente."', resposta: `Fideliza quando é regra; hoje é ${a.numero}. Troque por brinde de baixo custo e limite no caixa.` });
        else if (a.id.startsWith('F'))
            objecoes.push({ objecao: '"Cobrar fiado espanta o cliente."', resposta: 'Lembrete educado na data combinada não espanta; dinheiro parado no fiado é capital de giro que falta.' });
        else if (a.id.startsWith('O'))
            objecoes.push({ objecao: '"A cozinha está sempre corrida, não dá para apertar botão."', resposta: 'Sem os dois toques não dá para provar onde está a demora nem dimensionar a equipe do pico.' });
        else if (a.id.startsWith('E'))
            objecoes.push({ objecao: '"Estoque eu controlo de cabeça."', resposta: `Os números mostram outra coisa: ${a.numero}.` });
    }
    if (!objecoes.length)
        objecoes.push({ objecao: '"Esses números estão certos?"', resposta: `Saem dos registros do próprio sistema; confiança dos dados: ${NIVEL[p.confianca.nivel]} (${p.confianca.motivos.join('; ')}).` });
    const texto = [
        `ROTEIRO DA REUNIÃO — ${p.nome}`,
        '',
        `1. Por onde começar: ${comecar}`,
        `2. Número a mostrar primeiro: ${numero}`,
        g ? `3. Gargalo principal: ${g.frase} (${g.numero}; confiança ${NIVEL[g.confianca]}).` : '3. Gargalo principal: nenhum passou na amostra mínima — foque no plano e na qualidade dos dados.',
        '4. Decisões a tirar do Dono:',
        ...(decisoes.length ? decisoes.map((d, i) => `   ${i + 1}) ${d}`) : ['   1) Combinar a melhoria dos registros (custo, horários da cozinha) para o próximo relatório.']),
        '5. Objeções prováveis:',
        ...objecoes.map((o) => `   • ${o.objecao} → ${o.resposta}`),
        `6. Fechar com: o plano de 30 dias e a data do próximo relatório. Confiança dos dados: ${NIVEL[p.confianca.nivel]}.`,
    ].join('\n');
    return { texto, comecar, numero, decisoes, objecoes };
}
