/**
 * ONE UP Insights — inteligência operacional determinística.
 * Todos os números vêm de consultas e estatística simples sobre dados reais.
 * Nenhum texto afirma causa; comparações são sempre com base equivalente e explícita.
 */
import { sql } from 'drizzle-orm';
import type { Executor } from '../db/index.js';
import { insightLog } from '../db/schema.js';
import { dataVersion } from '../lib/cache.js';

const TZ = 'America/Sao_Paulo';

export type InsightType = 'OPORTUNIDADE' | 'TENDENCIA' | 'ANOMALIA' | 'ALERTA' | 'DESEMPENHO' | 'PRODUTO' | 'OPERACIONAL' | 'FINANCEIRO';
export type InsightKind = 'DADO' | 'ESTIMATIVA' | 'INSIGHT' | 'RECOMENDACAO';
type Unit = 'BRL' | 'COUNT' | 'PCT' | 'MIN';
export type Insight = {
  key: string; bucket: string; type: InsightType; kind: InsightKind; scope: 'DIA' | 'PERIODO';
  title: string; text: string; action?: string;
  metric: { label: string; current: number; reference?: number; diffAbs?: number; diffPct?: number; unit: Unit; range?: [number, number] };
  period: string; comparison?: string;
  confidence: 'ALTA' | 'MEDIA'; score: number; repeated?: boolean;
  detail: { method: string; samples: string; series?: { label: string; value: number; highlight?: boolean }[]; seriesUnit?: Unit };
};

// ---------- utilidades ----------
const brl = (c: number) => {
  const neg = c < 0; const [i, d] = (Math.abs(c) / 100).toFixed(2).split('.');
  return `${neg ? '-' : ''}R$ ${i.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${d}`;
};
const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits).replace('.', ',')}%`;
const pp = (x: number) => `${(x * 100).toFixed(1).replace('.', ',')} p.p.`;
const signPct = (x: number) => `${x >= 0 ? '+' : '−'}${pct(Math.abs(x))}`;
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const sd = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const WD_PLURAL = ['domingos', 'segundas-feiras', 'terças-feiras', 'quartas-feiras', 'quintas-feiras', 'sextas-feiras', 'sábados'];
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}h${String(min % 60).padStart(2, '0')}`;
const fmtDate = (d: string) => d.split('-').reverse().slice(0, 2).join('/');
const addDays = (d: string, n: number) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const weekday = (d: string) => new Date(d + 'T12:00:00Z').getUTCDay();
const bucketOf = (x: number, step = 0.05) => `${x >= 0 ? 'up' : 'down'}:${Math.round(Math.abs(x) / step)}`;

function scoreOf(o: { pct?: number; impactCents?: number; confidence: 'ALTA' | 'MEDIA'; type: InsightType }) {
  const mag = Math.min(1, Math.abs(o.pct ?? 0) / 0.5);
  const imp = Math.min(1, Math.abs(o.impactCents ?? 0) / 100_000);
  const w = o.type === 'ALERTA' || o.type === 'ANOMALIA' ? 1.15 : o.type === 'OPERACIONAL' ? 1.05 : 1;
  return Math.round((mag * 0.5 + imp * 0.5) * (o.confidence === 'ALTA' ? 1 : 0.65) * w * 1000) / 10;
}

// ---------- carga de dados (70 dias, agregada no banco) ----------
type OrderRow = { id: number; day: string; minute: number; wd: number; accountId: number; gross: number; kitchenMin: number | null; expected: number | null };
type ItemRow = { day: string; minute: number; productId: number | null; name: string; category: string; qty: number; revenue: number; cost: number | null };

async function load(tx: Executor, today: string) {
  const from = addDays(today, -70);
  const q = async <T>(s: ReturnType<typeof sql>) => (await tx.execute(s)).rows as T[];
  const excluded = new Set((await q<{ day: string }>(sql`SELECT to_char(day,'YYYY-MM-DD') AS day FROM excluded_days`)).map((r) => r.day));
  const ordersRaw = await q<any>(sql`
    SELECT o.id, to_char((o.created_at AT TIME ZONE ${TZ})::date,'YYYY-MM-DD') AS day,
           (EXTRACT(HOUR FROM o.created_at AT TIME ZONE ${TZ})*60 + EXTRACT(MINUTE FROM o.created_at AT TIME ZONE ${TZ}))::int AS minute,
           o.account_id,
           COALESCE((SELECT SUM(unit_price_cents*quantity) FROM order_items WHERE order_id=o.id AND status='ACTIVE'),0)::int AS gross,
           CASE WHEN o.ready_at IS NOT NULL AND o.confirmed_at IS NOT NULL AND o.goes_to_kitchen
                THEN EXTRACT(EPOCH FROM (o.ready_at - o.confirmed_at))/60 END AS kitchen_min,
           o.expected_minutes
    FROM orders o
    WHERE o.created_at >= (${from}::date)::timestamp AT TIME ZONE ${TZ}
      AND o.status NOT IN ('AWAITING_CONFIRMATION','CANCELLED')`);
  const orders: OrderRow[] = ordersRaw.filter((r) => !excluded.has(r.day) && Number(r.gross) > 0).map((r) => ({
    id: Number(r.id), day: r.day, minute: Number(r.minute), wd: weekday(r.day), accountId: Number(r.account_id), gross: Number(r.gross),
    kitchenMin: r.kitchen_min == null ? null : Number(r.kitchen_min), expected: r.expected_minutes == null ? null : Number(r.expected_minutes),
  }));
  const items: ItemRow[] = (await q<any>(sql`
    SELECT to_char((o.created_at AT TIME ZONE ${TZ})::date,'YYYY-MM-DD') AS day,
           (EXTRACT(HOUR FROM o.created_at AT TIME ZONE ${TZ})*60 + EXTRACT(MINUTE FROM o.created_at AT TIME ZONE ${TZ}))::int AS minute,
           oi.product_id, oi.product_name AS name, COALESCE(c.name, 'Outros') AS category, oi.quantity AS qty,
           (oi.unit_price_cents*oi.quantity)::int AS revenue,
           CASE WHEN oi.unit_cost_cents IS NULL THEN NULL ELSE (oi.unit_cost_cents*oi.quantity)::int END AS cost
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    LEFT JOIN products p ON p.id = oi.product_id LEFT JOIN categories c ON c.id = p.category_id
    WHERE oi.status='ACTIVE' AND o.status NOT IN ('AWAITING_CONFIRMATION','CANCELLED')
      AND o.created_at >= (${from}::date)::timestamp AT TIME ZONE ${TZ}`))
    .filter((r) => !excluded.has(r.day))
    .map((r) => ({ day: r.day, minute: Number(r.minute), productId: r.product_id == null ? null : Number(r.product_id), name: r.name, category: r.category, qty: Number(r.qty), revenue: Number(r.revenue), cost: r.cost == null ? null : Number(r.cost) }));
  const pays = (await q<any>(sql`
    SELECT to_char((p.created_at AT TIME ZONE ${TZ})::date,'YYYY-MM-DD') AS day, pm.name AS method, p.amount_cents::int AS amount
    FROM payments p JOIN payment_methods pm ON pm.id = p.method_id
    WHERE p.reversed_at IS NULL AND p.created_at >= (${from}::date)::timestamp AT TIME ZONE ${TZ}`)).filter((r) => !excluded.has(r.day))
    .map((r) => ({ day: r.day, method: r.method as string, amount: Number(r.amount) }));
  const discs = (await q<any>(sql`
    SELECT to_char((d.created_at AT TIME ZONE ${TZ})::date,'YYYY-MM-DD') AS day, d.amount_cents::int AS amount, u.name AS user_name
    FROM discounts d JOIN users u ON u.id = d.user_id
    WHERE d.created_at >= (${from}::date)::timestamp AT TIME ZONE ${TZ}`)).filter((r) => !excluded.has(r.day))
    .map((r) => ({ day: r.day, amount: Number(r.amount), user: r.user_name as string }));
  const cancels = (await q<any>(sql`
    SELECT to_char((c.created_at AT TIME ZONE ${TZ})::date,'YYYY-MM-DD') AS day, c.amount_cents::int AS amount
    FROM cancellations c WHERE c.target <> 'ACCOUNT' AND c.created_at >= (${from}::date)::timestamp AT TIME ZONE ${TZ}`)).filter((r) => !excluded.has(r.day))
    .map((r) => ({ day: r.day, amount: Number(r.amount) }));
  return { orders, items, pays, discs, cancels, excluded };
}

// ---------- janelas ----------
type Win = { from: string; to: string; label: string };
const win = (from: string, to: string, label: string): Win => ({ from, to, label });
const inWin = (d: string, w: Win) => d >= w.from && d <= w.to;
const fmtWin = (w: Win) => `${fmtDate(w.from)} a ${fmtDate(w.to)}`;

function nowLocal() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return { day: `${g('year')}-${g('month')}-${g('day')}`, minute: (Number(g('hour')) % 24) * 60 + Number(g('minute')) };
}

let cache: { key: string; at: number; value: InsightsResult } | null = null;
export type InsightsResult = {
  level: 1 | 2 | 3 | 4; dataDays: number; firstDay: string | null; message: string;
  top: Insight[]; all: Insight[]; generatedAt: string;
};

export async function computeInsights(tx: Executor, opts: { now?: { day: string; minute: number }; log?: boolean } = {}): Promise<InsightsResult> {
  const now = opts.now ?? nowLocal();
  const cacheKey = `${now.day}:${Math.floor(now.minute / 5)}:${dataVersion()}`;
  if (!opts.now && cache && cache.key === cacheKey && Date.now() - cache.at < 60_000) return cache.value;

  const D = await load(tx, now.day);
  const pastDays = [...new Set(D.orders.map((o) => o.day))].filter((d) => d < now.day).sort();
  const dataDays = pastDays.length;
  const level: 1 | 2 | 3 | 4 = dataDays < 7 ? 1 : dataDays < 28 ? 2 : dataDays < 56 ? 3 : 4;
  const out: Insight[] = [];
  const push = (i: Omit<Insight, 'score'> & { impactCents?: number; pctForScore?: number }) => {
    const { impactCents, pctForScore, ...rest } = i;
    out.push({ ...rest, score: scoreOf({ pct: pctForScore ?? i.metric.diffPct, impactCents, confidence: i.confidence, type: i.type }) });
  };

  const salesByDay = new Map<string, number>();
  for (const o of D.orders) salesByDay.set(o.day, (salesByDay.get(o.day) ?? 0) + o.gross);
  const salesUntil = (day: string, minute: number) => D.orders.filter((o) => o.day === day && o.minute <= minute).reduce((s, o) => s + o.gross, 0);
  const todayOrders = D.orders.filter((o) => o.day === now.day);
  const todaySales = todayOrders.reduce((s, o) => s + o.gross, 0);

  // ===== DIA =====
  // A) Ritmo do dia × base equivalente no mesmo horário
  if (level >= 2 && todayOrders.length) {
    const wd = weekday(now.day);
    const sameWd = pastDays.filter((d) => weekday(d) === wd).slice(-4);
    const useWd = level >= 3 && sameWd.length >= 3;
    const refDays = useWd ? sameWd : pastDays.slice(-7);
    if (refDays.length >= 3) {
      const refs = refDays.map((d) => salesUntil(d, now.minute));
      const ref = mean(refs);
      const cur = salesUntil(now.day, now.minute);
      const diff = cur - ref;
      const p = ref > 0 ? diff / ref : 0;
      const dev = sd(refs);
      const beyondNoise = refs.length < 4 || Math.abs(diff) > dev;
      if (ref >= 5000 && Math.abs(p) >= 0.15 && Math.abs(diff) >= 5000 && beyondNoise) {
        const base = useWd ? `média das últimas ${refDays.length} ${WD_PLURAL[wd]} até ${hhmm(now.minute)}` : `média dos últimos ${refDays.length} dias até ${hhmm(now.minute)}`;
        push({
          key: 'day.pace', bucket: bucketOf(p, 0.1), type: 'DESEMPENHO', kind: 'INSIGHT', scope: 'DIA',
          title: p > 0 ? 'Hoje acima do padrão' : 'Hoje abaixo do padrão',
          text: `Até ${hhmm(now.minute)}, as vendas de hoje somam ${brl(cur)}, ${pct(Math.abs(p))} ${p > 0 ? 'acima' : 'abaixo'} da ${base} (${brl(Math.round(ref))}).`,
          metric: { label: 'Vendas até agora', current: cur, reference: Math.round(ref), diffAbs: Math.round(diff), diffPct: p, unit: 'BRL' },
          period: `Hoje até ${hhmm(now.minute)}`, comparison: base, confidence: useWd && refs.length >= 4 ? 'ALTA' : 'MEDIA',
          impactCents: diff,
          detail: {
            method: `Soma das vendas (itens ativos) de hoje até ${hhmm(now.minute)} comparada com a ${base}. Só aparece com diferença de 15% ou mais, de pelo menos R$ 50, e acima da oscilação normal desses dias.`,
            samples: `${refDays.length} dias de referência: ${refDays.map(fmtDate).join(', ')}`,
            series: [...refDays.map((d, i) => ({ label: fmtDate(d), value: refs[i] })), { label: 'Hoje', value: cur, highlight: true }], seriesUnit: 'BRL',
          },
        });
      }
    }
  }

  // B) Projeção de fechamento (ESTIMATIVA, em faixa)
  if (level >= 2 && todaySales > 0) {
    const wd = weekday(now.day);
    const sameWd = pastDays.filter((d) => weekday(d) === wd).slice(-6);
    const refDays = level >= 3 && sameWd.length >= 4 ? sameWd : pastDays.slice(-10);
    const fr = refDays.map((d) => { const tot = salesByDay.get(d) ?? 0; return tot > 0 ? salesUntil(d, now.minute) / tot : null; }).filter((x): x is number => x != null);
    const f = mean(fr);
    if (fr.length >= 5 && f >= 0.15 && f <= 0.85) {
      const cur = salesUntil(now.day, now.minute);
      const s = sd(fr);
      const lo = Math.round(cur / Math.min(0.99, f + s));
      const hi = Math.round(cur / Math.max(0.05, f - s));
      const mid = Math.round(cur / f);
      push({
        key: 'day.projection', bucket: `${Math.round(mid / 20000)}`, type: 'DESEMPENHO', kind: 'ESTIMATIVA', scope: 'DIA',
        title: 'Projeção de fechamento do dia',
        text: `No ritmo atual, o dia deve fechar entre ${brl(lo)} e ${brl(hi)} (estimativa). Até ${hhmm(now.minute)} costuma acontecer ${pct(f)} das vendas do dia.`,
        metric: { label: 'Fechamento estimado', current: mid, unit: 'BRL', range: [lo, hi] },
        period: 'Hoje', comparison: `proporção vendida até ${hhmm(now.minute)} em ${fr.length} dias anteriores`, confidence: fr.length >= 6 ? 'ALTA' : 'MEDIA',
        pctForScore: 0.2, impactCents: 20000,
        detail: {
          method: 'Estimativa, não é certeza: vendas até agora ÷ fração do dia que costuma estar vendida neste horário. A faixa considera a variação dessa fração nos dias de referência.',
          samples: `${fr.length} dias: ${refDays.map(fmtDate).join(', ')}`,
        },
      });
    }
  }

  // C) Destaque do dia (participação de um produto)
  {
    const todayItems = D.items.filter((i) => i.day === now.day);
    const totalQty = todayItems.reduce((s, i) => s + i.qty, 0);
    const totalRev = todayItems.reduce((s, i) => s + i.revenue, 0);
    if (totalQty >= 15 && totalRev > 0) {
      const byName = new Map<string, { qty: number; rev: number }>();
      for (const i of todayItems) { const v = byName.get(i.name) ?? { qty: 0, rev: 0 }; v.qty += i.qty; v.rev += i.revenue; byName.set(i.name, v); }
      const [name, v] = [...byName.entries()].sort((a, b) => b[1].rev - a[1].rev)[0];
      const share = v.rev / totalRev;
      if (share >= 0.2) {
        // participação habitual (se houver base)
        const past = D.items.filter((i) => i.day < now.day && i.day >= addDays(now.day, -28));
        const pastTotal = past.reduce((s, i) => s + i.revenue, 0);
        const pastShare = pastTotal > 0 ? past.filter((i) => i.name === name).reduce((s, i) => s + i.revenue, 0) / pastTotal : null;
        const hasBase = level >= 2 && pastShare != null;
        push({
          key: `day.highlight:${name}`, bucket: `${Math.round(share * 10)}`, type: 'PRODUTO', kind: hasBase ? 'INSIGHT' : 'DADO', scope: 'DIA',
          title: `${name} puxa as vendas de hoje`,
          text: `${name} representa ${pct(share)} do faturamento de hoje (${v.qty} un., ${brl(v.rev)})${hasBase ? `; nos últimos 28 dias a participação média foi ${pct(pastShare!)}` : ''}.`,
          metric: { label: 'Participação hoje', current: share, reference: hasBase ? pastShare! : undefined, diffPct: hasBase && pastShare! > 0 ? share / pastShare! - 1 : undefined, unit: 'PCT' },
          period: 'Hoje', comparison: hasBase ? 'participação média dos últimos 28 dias' : undefined, confidence: totalQty >= 30 ? 'ALTA' : 'MEDIA',
          pctForScore: hasBase ? share - pastShare! : share / 2, impactCents: v.rev / 2,
          detail: { method: 'Faturamento do produto hoje ÷ faturamento total de hoje. Aparece com 15+ itens vendidos e participação de 20% ou mais.', samples: `${totalQty} itens vendidos hoje` },
        });
      }
    }
  }

  // D) Rupturas de hoje (o que acabou e quando)
  {
    const rows = (await tx.execute(sql`
      SELECT DISTINCT ON (p.name) p.name,
             to_char(m.created_at AT TIME ZONE ${TZ}, 'HH24"h"MI') AS at
      FROM stock_movements m JOIN products p ON p.id = m.product_id
      WHERE m.after = 0 AND m.quantity < 0 AND (m.created_at AT TIME ZONE ${TZ})::date = ${now.day}::date
      UNION
      SELECT DISTINCT ON (l.message) substring(l.message from '"([^"]+)"') AS name, to_char(l.created_at AT TIME ZONE ${TZ}, 'HH24"h"MI') AS at
      FROM audit_logs l WHERE l.action = 'menu.availability' AND l.message LIKE '%INDISPONÍVEL%' AND (l.created_at AT TIME ZONE ${TZ})::date = ${now.day}::date`)).rows as { name: string; at: string }[];
    const list = rows.filter((r) => r.name);
    if (list.length) {
      push({
        key: 'day.ruptures', bucket: list.map((r) => r.name).sort().join('|'), type: 'OPERACIONAL', kind: 'DADO', scope: 'DIA',
        title: list.length === 1 ? `${list[0].name} acabou hoje` : `${list.length} produtos acabaram hoje`,
        text: list.slice(0, 4).map((r) => `${r.name} (${r.at})`).join(', ') + (list.length > 4 ? '…' : '') + '. Vale conferir a reposição para os próximos dias.',
        metric: { label: 'Produtos que acabaram', current: list.length, unit: 'COUNT' },
        period: 'Hoje', confidence: 'ALTA', pctForScore: 0.4, impactCents: 30000,
        detail: { method: 'Produtos que chegaram a zero no estoque ou foram marcados como "acabou" hoje.', samples: list.map((r) => `${r.name} às ${r.at}`).join('; ') },
      });
    }
  }

  // E) Cozinha hoje × padrão
  {
    const valid = (o: OrderRow) => o.kitchenMin != null && o.kitchenMin > 0 && (!o.expected || o.kitchenMin <= o.expected * 3);
    const t = todayOrders.filter(valid).map((o) => o.kitchenMin!);
    const hist = D.orders.filter((o) => o.day < now.day && o.day >= addDays(now.day, -28) && valid(o)).map((o) => o.kitchenMin!);
    if (t.length >= 8 && hist.length >= 30) {
      const cur = median(t); const ref = median(hist); const p = cur / ref - 1;
      if (Math.abs(p) >= 0.2 && Math.abs(cur - ref) >= 3) {
        push({
          key: 'day.kitchen', bucket: bucketOf(p, 0.1), type: 'OPERACIONAL', kind: 'INSIGHT', scope: 'DIA',
          title: p > 0 ? 'Cozinha mais lenta hoje' : 'Cozinha mais rápida hoje',
          text: `O tempo mediano de cozinha hoje é ${Math.round(cur)} min, contra ${Math.round(ref)} min nos últimos 28 dias (${signPct(p)}).`,
          metric: { label: 'Tempo de cozinha (mediana)', current: Math.round(cur), reference: Math.round(ref), diffAbs: Math.round(cur - ref), diffPct: p, unit: 'MIN' },
          period: 'Hoje', comparison: 'mediana dos últimos 28 dias', confidence: t.length >= 15 ? 'ALTA' : 'MEDIA', impactCents: 25000,
          detail: { method: 'Mediana do tempo entre o envio à cozinha e o "pronto". Tempos acima de 3× o padrão do pedido (esquecidos) ficam de fora.', samples: `${t.length} pedidos hoje; ${hist.length} na base` },
        });
      }
    }
  }

  // F) Controle do dia: descontos e cancelamentos acima do normal (sem acusar ninguém)
  if (level >= 2) {
    const gross = (d: string) => salesByDay.get(d) ?? 0;
    const discDay = (d: string) => D.discs.filter((x) => x.day === d).reduce((s, x) => s + x.amount, 0);
    const base = pastDays.slice(-28);
    const baseGross = base.reduce((s, d) => s + gross(d), 0);
    const baseDisc = base.reduce((s, d) => s + discDay(d), 0);
    const tg = gross(now.day);
    if (tg >= 30000 && baseGross > 0 && base.length >= 7) {
      const cur = discDay(now.day) / tg; const ref = baseDisc / baseGross;
      if (cur - ref >= 0.02 && discDay(now.day) >= 2000) {
        push({
          key: 'day.discounts', bucket: `${Math.round(cur * 100)}`, type: 'ALERTA', kind: 'DADO', scope: 'DIA',
          title: 'Descontos acima do habitual hoje',
          text: `Os descontos de hoje somam ${brl(discDay(now.day))} (${pct(cur, 1)} das vendas), contra ${pct(ref, 1)} em média nos últimos ${base.length} dias. Indicador administrativo, para acompanhamento.`,
          metric: { label: 'Descontos / vendas', current: cur, reference: ref, diffAbs: cur - ref, unit: 'PCT' },
          period: 'Hoje', comparison: `média dos últimos ${base.length} dias`, confidence: 'MEDIA', pctForScore: (cur - ref) * 5, impactCents: discDay(now.day),
          detail: { method: 'Soma dos descontos/ajustes ÷ vendas brutas. Aparece com 2 p.p. acima da média e pelo menos R$ 20.', samples: `Hoje: ${brl(tg)} em vendas` },
        });
      }
    }
  }

  // G) Estoque baixo (alerta operacional)
  {
    const low = (await tx.execute(sql`
      SELECT name, stock_qty AS qty, low_stock_at AS lim FROM products
      WHERE track_stock AND active AND stock_qty <= low_stock_at ORDER BY stock_qty, name LIMIT 20`)).rows as { name: string; qty: number; lim: number }[];
    const counted = Number(((await tx.execute(sql`SELECT COUNT(*)::int AS n FROM stock_movements WHERE type IN ('ENTRADA','AJUSTE')`)).rows[0] as { n: number }).n);
    if (low.length && counted > 0) {
      push({
        key: 'day.lowstock', bucket: low.map((l) => l.name).join('|'), type: 'ALERTA', kind: 'DADO', scope: 'DIA',
        title: low.length === 1 ? `${low[0].name}: estoque baixo` : `${low.length} produtos com estoque baixo`,
        text: low.slice(0, 5).map((l) => `${l.name} (${l.qty})`).join(', ') + (low.length > 5 ? '…' : '') + '.',
        metric: { label: 'Produtos no limite', current: low.length, unit: 'COUNT' },
        period: 'Agora', confidence: 'ALTA', pctForScore: 0.3, impactCents: 15000,
        detail: { method: 'Produtos com controle de estoque cuja quantidade está no limite configurado ou abaixo.', samples: low.map((l) => `${l.name}: ${l.qty} (limite ${l.lim})`).join('; ') },
      });
    }
  }

  // H) Fiado antigo
  {
    const rows = (await tx.execute(sql`
      SELECT a.number, a.customer_name AS name, a.pending_at,
        (COALESCE((SELECT SUM(oi.unit_price_cents*oi.quantity) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.account_id=a.id AND oi.status='ACTIVE'),0)
         - COALESCE((SELECT SUM(amount_cents) FROM discounts WHERE account_id=a.id),0)
         - COALESCE((SELECT SUM(amount_cents) FROM payments WHERE account_id=a.id AND reversed_at IS NULL),0))::int AS balance
      FROM accounts a WHERE a.status='PENDING' AND a.pending_at < now() - interval '7 days'`)).rows as { number: number; name: string; balance: number }[];
    const total = rows.reduce((s, r) => s + Number(r.balance), 0);
    if (rows.length && total >= 5000) {
      push({
        key: 'day.oldreceivables', bucket: `${rows.length}:${Math.round(total / 5000)}`, type: 'FINANCEIRO', kind: 'DADO', scope: 'DIA',
        title: `${brl(total)} pendentes há mais de 7 dias`,
        text: `${rows.length} conta(s) pendente(s) com mais de uma semana: ${rows.slice(0, 3).map((r) => `${r.name} (${brl(Number(r.balance))})`).join(', ')}${rows.length > 3 ? '…' : ''}.`,
        metric: { label: 'Fiado com mais de 7 dias', current: total, unit: 'BRL' },
        period: 'Agora', confidence: 'ALTA', pctForScore: 0.3, impactCents: total,
        detail: { method: 'Soma do saldo das contas pendentes marcadas há mais de 7 dias.', samples: `${rows.length} conta(s)` },
      });
    }
  }

  // ===== PERÍODO =====
  const yesterday = addDays(now.day, -1);
  const w7 = win(addDays(now.day, -7), yesterday, 'últimos 7 dias');
  const w7p = win(addDays(now.day, -14), addDays(now.day, -8), '7 dias anteriores');
  const wLong = level >= 4 ? 28 : 14;
  const wL = win(addDays(now.day, -wLong), yesterday, `últimos ${wLong} dias`);
  const wLp = win(addDays(now.day, -2 * wLong), addDays(now.day, -wLong - 1), `${wLong} dias anteriores`);
  const daysIn = (w: Win) => pastDays.filter((d) => inWin(d, w)).length;
  const sumSales = (w: Win) => D.orders.filter((o) => inWin(o.day, w)).reduce((s, o) => s + o.gross, 0);
  const accountsIn = (w: Win) => new Set(D.orders.filter((o) => inWin(o.day, w)).map((o) => o.accountId)).size;

  // I) Faturamento 7d × 7d anteriores
  if (level >= 2 && daysIn(w7) >= 4 && daysIn(w7p) >= 4) {
    const cur = sumSales(w7), ref = sumSales(w7p), diff = cur - ref, p = ref > 0 ? diff / ref : 0;
    if (ref > 0 && Math.abs(p) >= 0.1 && Math.abs(diff) >= 30000) {
      const series: { label: string; value: number; highlight?: boolean }[] = [];
      for (let i = 13; i >= 1; i--) { const d = addDays(now.day, -i); series.push({ label: fmtDate(d), value: salesByDay.get(d) ?? 0, highlight: i <= 7 }); }
      push({
        key: 'period.sales7', bucket: bucketOf(p), type: 'TENDENCIA', kind: 'INSIGHT', scope: 'PERIODO',
        title: p > 0 ? 'Faturamento da semana em alta' : 'Faturamento da semana em queda',
        text: `Nos últimos 7 dias as vendas somaram ${brl(cur)}, ${pct(Math.abs(p))} ${p > 0 ? 'acima' : 'abaixo'} dos 7 dias anteriores (${brl(ref)}).`,
        metric: { label: 'Vendas 7 dias', current: cur, reference: ref, diffAbs: diff, diffPct: p, unit: 'BRL' },
        period: fmtWin(w7), comparison: `7 dias anteriores (${fmtWin(w7p)})`, confidence: daysIn(w7) >= 6 && daysIn(w7p) >= 6 ? 'ALTA' : 'MEDIA', impactCents: diff,
        detail: { method: 'Soma das vendas brutas (itens ativos) de cada janela. Dias fechados e dias marcados como atípicos ficam de fora.', samples: `${daysIn(w7)} × ${daysIn(w7p)} dias com vendas`, series, seriesUnit: 'BRL' },
      });
    }
  }

  // J) Faturamento 28d × 28d anteriores (histórico robusto)
  if (level >= 4 && daysIn(wL) >= 16 && daysIn(wLp) >= 16) {
    const cur = sumSales(wL), ref = sumSales(wLp), diff = cur - ref, p = ref > 0 ? diff / ref : 0;
    if (ref > 0 && Math.abs(p) >= 0.08 && Math.abs(diff) >= 50000) {
      push({
        key: 'period.sales28', bucket: bucketOf(p), type: 'TENDENCIA', kind: 'INSIGHT', scope: 'PERIODO',
        title: p > 0 ? 'Mês em crescimento' : 'Mês em queda',
        text: `Nos últimos 28 dias as vendas foram ${brl(cur)}, ${pct(Math.abs(p))} ${p > 0 ? 'acima' : 'abaixo'} dos 28 dias anteriores.`,
        metric: { label: 'Vendas 28 dias', current: cur, reference: ref, diffAbs: diff, diffPct: p, unit: 'BRL' },
        period: fmtWin(wL), comparison: `28 dias anteriores (${fmtWin(wLp)})`, confidence: 'ALTA', impactCents: diff,
        detail: { method: 'Soma das vendas brutas de cada janela de 28 dias.', samples: `${daysIn(wL)} × ${daysIn(wLp)} dias com vendas` },
      });
    }
  }

  // K) Ticket médio (com atribuição a categoria só quando o dado mostra)
  {
    const [A, B] = level >= 3 ? [wL, wLp] : [w7, w7p];
    const na = accountsIn(A), nb = accountsIn(B);
    if (level >= 2 && na >= 30 && nb >= 30 && daysIn(A) >= 4 && daysIn(B) >= 4) {
      const ta = sumSales(A) / na, tb = sumSales(B) / nb, p = ta / tb - 1;
      if (Math.abs(p) >= 0.08) {
        const cats = [...new Set(D.items.map((i) => i.category))];
        const contrib = cats.map((c) => ({
          c, d: D.items.filter((i) => i.category === c && inWin(i.day, A)).reduce((s, i) => s + i.revenue, 0) / na
            - D.items.filter((i) => i.category === c && inWin(i.day, B)).reduce((s, i) => s + i.revenue, 0) / nb,
        })).sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
        const delta = ta - tb;
        const main = contrib[0] && Math.sign(contrib[0].d) === Math.sign(delta) && Math.abs(contrib[0].d) >= Math.abs(delta) * 0.5 ? contrib[0] : null;
        push({
          key: 'period.ticket', bucket: bucketOf(p), type: 'DESEMPENHO', kind: 'INSIGHT', scope: 'PERIODO',
          title: p > 0 ? 'Ticket médio em alta' : 'Ticket médio em queda',
          text: `O ticket médio por conta foi ${brl(Math.round(ta))} nos ${A.label}, ${pct(Math.abs(p), 1)} ${p > 0 ? 'acima' : 'abaixo'} dos ${B.label} (${brl(Math.round(tb))}). ` +
            (main ? `A maior parte da variação veio de ${main.c} (${main.d > 0 ? '+' : '−'}${brl(Math.abs(Math.round(main.d)))} por conta).` : 'Os dados não permitem atribuir a mudança a uma categoria específica.'),
          metric: { label: 'Ticket médio', current: Math.round(ta), reference: Math.round(tb), diffAbs: Math.round(delta), diffPct: p, unit: 'BRL' },
          period: fmtWin(A), comparison: `${B.label} (${fmtWin(B)})`, confidence: na >= 80 && nb >= 80 ? 'ALTA' : 'MEDIA', impactCents: delta * na,
          detail: { method: 'Vendas brutas ÷ número de contas com consumo. A contribuição por categoria é a variação do valor médio de cada categoria por conta.', samples: `${na} × ${nb} contas` },
        });
      }
    }
  }

  // L) Produtos em alta e em queda (consistência em 3 semanas)
  if (level >= 3) {
    const weeks = [0, 1, 2].map((k) => win(addDays(now.day, -7 * (k + 1)), addDays(now.day, -7 * k - 1), ''));
    const prior = win(addDays(now.day, -49), addDays(now.day, -22), '');
    // semanas-calendário realmente cobertas pelo histórico (dias fechados, ex. segunda, não distorcem a média semanal)
    const coverFrom = pastDays[0] && pastDays[0] > prior.from ? pastDays[0] : prior.from;
    const coveredDays = coverFrom <= prior.to ? Math.round((Date.parse(prior.to) - Date.parse(coverFrom)) / 86400_000) + 1 : 0;
    const priorWeeks = coveredDays >= 14 && daysIn(prior) >= 8 ? coveredDays / 7 : 0;
    if (priorWeeks > 0) {
      const names = [...new Set(D.items.filter((i) => i.productId != null).map((i) => i.name))];
      const cands: { name: string; p: number; cur: number; ref: number; rev: number; wk: number[] }[] = [];
      for (const name of names) {
        const wk = weeks.map((w) => D.items.filter((i) => i.name === name && inWin(i.day, w)).reduce((s, i) => s + i.qty, 0));
        const refWeekly = D.items.filter((i) => i.name === name && inWin(i.day, prior)).reduce((s, i) => s + i.qty, 0) / priorWeeks;
        if (refWeekly < 5) continue;
        const curWeekly = mean(wk);
        const p = curWeekly / refWeekly - 1;
        const consistent = p > 0 ? wk.every((x) => x > refWeekly) : wk.every((x) => x < refWeekly);
        if (Math.abs(p) >= 0.25 && consistent && Math.abs(curWeekly - refWeekly) >= 3) {
          const price = D.items.filter((i) => i.name === name).reduce((s, i) => s + i.revenue, 0) / Math.max(1, D.items.filter((i) => i.name === name).reduce((s, i) => s + i.qty, 0));
          cands.push({ name, p, cur: curWeekly, ref: refWeekly, rev: (curWeekly - refWeekly) * price * 3, wk });
        }
      }
      for (const c of cands.sort((a, b) => Math.abs(b.rev) - Math.abs(a.rev)).slice(0, 3)) {
        const up = c.p > 0;
        push({
          key: `period.product:${c.name}`, bucket: bucketOf(c.p, 0.1), type: up ? 'OPORTUNIDADE' : 'PRODUTO', kind: 'INSIGHT', scope: 'PERIODO',
          title: `${c.name} ${up ? 'em crescimento' : 'em queda'}`,
          text: `${c.name} vendeu em média ${c.cur.toFixed(1).replace('.', ',')} un./semana nas últimas 3 semanas, ${pct(Math.abs(c.p))} ${up ? 'acima' : 'abaixo'} da média semanal do período anterior (${c.ref.toFixed(1).replace('.', ',')}). ${up ? 'Vale garantir reposição.' : 'Os dados não indicam o motivo.'}`,
          metric: { label: 'Unidades por semana', current: Math.round(c.cur * 10) / 10, reference: Math.round(c.ref * 10) / 10, diffPct: c.p, unit: 'COUNT' },
          period: 'Últimas 3 semanas', comparison: `${Math.round(priorWeeks * 10) / 10 >= 3.9 ? '4' : String(Math.round(priorWeeks * 10) / 10).replace('.', ',')} semanas anteriores`, confidence: c.ref >= 10 && priorWeeks >= 3 ? 'ALTA' : 'MEDIA', impactCents: Math.abs(c.rev),
          detail: {
            method: 'Média semanal das últimas 3 semanas × média semanal das 4 semanas anteriores. Exige 5+ unidades/semana na base e as 3 semanas na mesma direção (evita "tendência" de uma venda isolada).',
            samples: `Semanas (mais recente primeiro): ${c.wk.join(', ')} un.`,
            series: [...c.wk].reverse().map((v, i) => ({ label: `Sem. ${i + 1}`, value: v, highlight: true })), seriesUnit: 'COUNT',
          },
        });
      }
    }
  }

  // M) Mix de categorias
  if (level >= 3) {
    const tot = (w: Win) => D.items.filter((i) => inWin(i.day, w)).reduce((s, i) => s + i.revenue, 0);
    const qtyIn = (w: Win) => D.items.filter((i) => inWin(i.day, w)).reduce((s, i) => s + i.qty, 0);
    const ta = tot(wL), tb = tot(wLp);
    if (ta > 0 && tb > 0 && qtyIn(wL) >= 100 && qtyIn(wLp) >= 100 && daysIn(wLp) >= wLong / 2) {
      const cats = [...new Set(D.items.map((i) => i.category))];
      const shifts = cats.map((c) => {
        const a = D.items.filter((i) => i.category === c && inWin(i.day, wL)).reduce((s, i) => s + i.revenue, 0) / ta;
        const b = D.items.filter((i) => i.category === c && inWin(i.day, wLp)).reduce((s, i) => s + i.revenue, 0) / tb;
        return { c, a, b, d: a - b };
      }).sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
      const s = shifts[0];
      if (s && Math.abs(s.d) >= 0.05) {
        push({
          key: `period.mix:${s.c}`, bucket: bucketOf(s.d, 0.02), type: 'TENDENCIA', kind: 'INSIGHT', scope: 'PERIODO',
          title: `Mudança no mix: ${s.c}`,
          text: `${s.c} representou ${pct(s.a)} do faturamento nos ${wL.label}, contra ${pct(s.b)} nos ${wLp.label} (${s.d > 0 ? '+' : '−'}${pp(Math.abs(s.d))}).`,
          metric: { label: `Participação de ${s.c}`, current: s.a, reference: s.b, diffAbs: s.d, unit: 'PCT' },
          period: fmtWin(wL), comparison: `${wLp.label} (${fmtWin(wLp)})`, confidence: 'MEDIA', pctForScore: s.d * 3, impactCents: Math.abs(s.d) * ta,
          detail: { method: 'Participação de cada categoria no faturamento de cada janela; mostra a maior mudança se for de 5 p.p. ou mais.', samples: shifts.slice(0, 5).map((x) => `${x.c}: ${pct(x.b)} → ${pct(x.a)}`).join('; ') },
        });
      }
    }
  }

  // N) Formas de pagamento
  if (level >= 3) {
    const byM = (w: Win) => { const m = new Map<string, number>(); for (const p of D.pays.filter((x) => inWin(x.day, w))) m.set(p.method, (m.get(p.method) ?? 0) + p.amount); return m; };
    const cnt = (w: Win) => D.pays.filter((x) => inWin(x.day, w)).length;
    if (cnt(wL) >= 50 && cnt(wLp) >= 50) {
      const a = byM(wL), b = byM(wLp);
      const ta = [...a.values()].reduce((s, x) => s + x, 0), tb = [...b.values()].reduce((s, x) => s + x, 0);
      const methods = [...new Set([...a.keys(), ...b.keys()])];
      const shifts = methods.map((m) => ({ m, a: (a.get(m) ?? 0) / ta, b: (b.get(m) ?? 0) / tb })).map((x) => ({ ...x, d: x.a - x.b })).sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
      const s = shifts[0];
      if (s && Math.abs(s.d) >= 0.08) {
        push({
          key: `period.payments:${s.m}`, bucket: bucketOf(s.d, 0.04), type: 'FINANCEIRO', kind: 'INSIGHT', scope: 'PERIODO',
          title: `Participação do ${s.m} ${s.d > 0 ? 'subiu' : 'caiu'}`,
          text: `A participação do ${s.m} nos recebimentos passou de ${pct(s.b)} para ${pct(s.a)} (${wLp.label} → ${wL.label}).`,
          metric: { label: `Participação do ${s.m}`, current: s.a, reference: s.b, diffAbs: s.d, unit: 'PCT' },
          period: fmtWin(wL), comparison: fmtWin(wLp), confidence: 'MEDIA', pctForScore: s.d * 2, impactCents: Math.abs(s.d) * ta / 3,
          detail: { method: 'Participação de cada forma no valor recebido em cada janela.', samples: shifts.map((x) => `${x.m}: ${pct(x.b)} → ${pct(x.a)}`).join('; ') },
        });
      }
    }
  }

  // O) Taxa de desconto e P) taxa de cancelamento
  if (level >= 3) {
    const g = (w: Win) => sumSales(w);
    const disc = (w: Win) => D.discs.filter((x) => inWin(x.day, w)).reduce((s, x) => s + x.amount, 0);
    const canc = (w: Win) => D.cancels.filter((x) => inWin(x.day, w)).reduce((s, x) => s + x.amount, 0);
    const ga = g(wL), gb = g(wLp);
    if (ga >= 100000 && gb >= 100000) {
      const ra = disc(wL) / ga, rb = disc(wLp) / gb;
      if (ra - rb >= 0.015 && ra >= 0.02) {
        const byUser = new Map<string, number>();
        for (const x of D.discs.filter((x) => inWin(x.day, wL))) byUser.set(x.user, (byUser.get(x.user) ?? 0) + x.amount);
        push({
          key: 'period.discounts', bucket: bucketOf(ra - rb, 0.01), type: 'ALERTA', kind: 'DADO', scope: 'PERIODO',
          title: 'Descontos cresceram',
          text: `Os descontos representaram ${pct(ra, 1)} das vendas brutas nos ${wL.label}, contra ${pct(rb, 1)} nos ${wLp.label}. Indicador administrativo para acompanhamento.`,
          metric: { label: 'Descontos / vendas', current: ra, reference: rb, diffAbs: ra - rb, unit: 'PCT' },
          period: fmtWin(wL), comparison: fmtWin(wLp), confidence: 'MEDIA', pctForScore: (ra - rb) * 8, impactCents: disc(wL) - rb * ga,
          detail: { method: 'Soma de descontos e ajustes ÷ vendas brutas da janela.', samples: [...byUser.entries()].map(([u, v]) => `${u}: ${brl(v)}`).join('; ') },
        });
      }
      const ca = canc(wL) / (ga + canc(wL)), cb = canc(wLp) / (gb + canc(wLp));
      if (ca - cb >= 0.015 && ca >= 0.02) {
        push({
          key: 'period.cancellations', bucket: bucketOf(ca - cb, 0.01), type: 'ALERTA', kind: 'DADO', scope: 'PERIODO',
          title: 'Cancelamentos aumentaram',
          text: `A taxa de cancelamento (em valor) passou de ${pct(cb, 1)} para ${pct(ca, 1)} (${wLp.label} → ${wL.label}). Os dados não indicam a causa.`,
          metric: { label: 'Cancelado / lançado', current: ca, reference: cb, diffAbs: ca - cb, unit: 'PCT' },
          period: fmtWin(wL), comparison: fmtWin(wLp), confidence: 'MEDIA', pctForScore: (ca - cb) * 8, impactCents: canc(wL),
          detail: { method: 'Valor cancelado (itens e pedidos) ÷ valor lançado na janela.', samples: `${brl(canc(wL))} cancelados em ${fmtWin(wL)}` },
        });
      }
    }
  }

  // Q) Concentração por horário
  if (level >= 2) {
    const base = D.orders.filter((o) => o.day < now.day && o.day >= addDays(now.day, -28));
    if (base.length >= 50) {
      const byHalf = new Array(48).fill(0);
      for (const o of base) byHalf[Math.floor(o.minute / 30)]++;
      let best = 0, bestStart = 0;
      for (let s = 0; s <= 42; s++) { const v = byHalf.slice(s, s + 6).reduce((a, b) => a + b, 0); if (v > best) { best = v; bestStart = s; } }
      const share = best / base.length;
      if (share >= 0.4) {
        push({
          key: 'period.peak', bucket: `${bestStart}:${Math.round(share * 10)}`, type: 'DESEMPENHO', kind: 'DADO', scope: 'PERIODO',
          title: 'Horário de maior movimento',
          text: `${pct(share)} dos pedidos dos últimos ${Math.min(28, dataDays)} dias ocorreram entre ${hhmm(bestStart * 30)} e ${hhmm(bestStart * 30 + 180)}. Vale considerar esse período ao organizar a cozinha e o atendimento.`,
          metric: { label: 'Pedidos no pico (3 h)', current: share, unit: 'PCT' },
          period: `últimos ${Math.min(28, dataDays)} dias`, confidence: base.length >= 150 ? 'ALTA' : 'MEDIA', pctForScore: share / 2, impactCents: 20000,
          detail: {
            method: 'Janela de 3 horas com mais pedidos (em blocos de 30 minutos).', samples: `${base.length} pedidos`,
            series: Array.from({ length: 24 }, (_, h) => ({ label: `${h}h`, value: byHalf[h * 2] + byHalf[h * 2 + 1], highlight: h * 2 >= bestStart && h * 2 < bestStart + 6 })).filter((x) => x.value > 0 || true).slice(8, 24),
            seriesUnit: 'COUNT',
          },
        });
      }
    }
  }

  // R) Dia da semana mais forte
  if (level >= 3) {
    const byWd = new Map<number, number[]>();
    for (const d of pastDays.slice(-56)) { const a = byWd.get(weekday(d)) ?? []; a.push(salesByDay.get(d) ?? 0); byWd.set(weekday(d), a); }
    const avg = [...byWd.entries()].filter(([, a]) => a.length >= 3).map(([wd, a]) => ({ wd, m: mean(a), n: a.length }));
    if (avg.length >= 4) {
      avg.sort((a, b) => b.m - a.m);
      // dias "fortes": o mais forte e os que ficam a menos de 10% dele (não elege um dia só quando há empate técnico)
      const group = avg.filter((x) => x.m >= avg[0].m * 0.9).slice(0, 3);
      const rest = avg.filter((x) => !group.includes(x));
      const gm = mean(group.map((x) => x.m)); const others = mean(rest.map((x) => x.m));
      const weekTotal = avg.reduce((s, x) => s + x.m, 0);
      const names = group.map((x) => WD_PLURAL[x.wd]);
      const joined = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
      if (rest.length >= 2 && others > 0 && gm >= others * 1.3) {
        push({
          key: `period.weekday:${group.map((x) => x.wd).sort().join('-')}`, bucket: `${Math.round((gm / others) * 10)}`, type: 'DESEMPENHO', kind: 'DADO', scope: 'PERIODO',
          title: `${joined[0].toUpperCase() + joined.slice(1)} concentram o movimento`,
          text: group.length === 1
            ? `Os ${joined} somam em média ${brl(Math.round(gm))}, ${pct(gm / weekTotal)} do faturamento semanal médio e ${pct(gm / others - 1)} acima da média dos outros dias abertos.`
            : `${joined[0].toUpperCase() + joined.slice(1)} vendem em média ${group.map((x) => `${brl(Math.round(x.m))} (${WEEKDAYS[x.wd]})`).join(' e ')} — juntos, ${pct(group.reduce((s, x) => s + x.m, 0) / weekTotal)} do faturamento semanal médio e ${pct(gm / others - 1)} acima da média dos outros dias abertos.`,
          metric: { label: group.length === 1 ? `Média de ${WEEKDAYS[group[0].wd]}` : 'Média dos dias fortes', current: Math.round(gm), reference: Math.round(others), diffAbs: Math.round(gm) - Math.round(others), diffPct: gm / others - 1, unit: 'BRL' },
          period: `últimas ${Math.min(8, Math.floor(dataDays / 7))} semanas`, comparison: 'média dos outros dias abertos', confidence: group.every((x) => x.n >= 5) ? 'ALTA' : 'MEDIA', impactCents: gm - others,
          detail: {
            method: 'Média de vendas de cada dia da semana (dias abertos), exigindo 3+ ocorrências por dia. Dias a menos de 10% do mais forte entram juntos como “dias fortes”.', samples: avg.map((x) => `${WEEKDAYS[x.wd]}: ${brl(Math.round(x.m))} (${x.n})`).join('; '),
            series: [1, 2, 3, 4, 5, 6, 0].filter((w) => avg.some((x) => x.wd === w)).map((w) => ({ label: WEEKDAYS[w].slice(0, 3), value: Math.round(avg.find((x) => x.wd === w)!.m), highlight: group.some((x) => x.wd === w) })), seriesUnit: 'BRL',
          },
        });
      }
    }
  }

  // S) Anomalia de ontem
  if (level >= 3 && salesByDay.has(yesterday)) {
    const wd = weekday(yesterday);
    const refs = pastDays.filter((d) => d < yesterday && weekday(d) === wd).slice(-6).map((d) => salesByDay.get(d) ?? 0);
    if (refs.length >= 4) {
      const y = salesByDay.get(yesterday)!; const m = mean(refs); const s = sd(refs);
      const z = s > 0 ? (y - m) / s : 0;
      if (Math.abs(z) >= 2 && Math.abs(y - m) >= 20000) {
        push({
          key: 'period.anomaly', bucket: `${yesterday}`, type: 'ANOMALIA', kind: 'INSIGHT', scope: 'PERIODO',
          title: `Ontem fora do padrão (${y > m ? 'acima' : 'abaixo'})`,
          text: `As vendas de ontem (${brl(y)}) ficaram ${pct(Math.abs(y / m - 1))} ${y > m ? 'acima' : 'abaixo'} da média das últimas ${refs.length} ${WD_PLURAL[wd]} (${brl(Math.round(m))}), bem além da oscilação normal. Se houve um evento atípico, marque o dia para não distorcer as médias.`,
          metric: { label: 'Vendas de ontem', current: y, reference: Math.round(m), diffAbs: Math.round(y - m), diffPct: y / m - 1, unit: 'BRL' },
          period: fmtDate(yesterday), comparison: `últimas ${refs.length} ${WD_PLURAL[wd]}`, confidence: refs.length >= 5 ? 'ALTA' : 'MEDIA', impactCents: y - m,
          detail: { method: 'Comparação com o mesmo dia da semana; considera anomalia quando o desvio é maior que 2 vezes a oscilação normal desses dias.', samples: refs.map((v) => brl(v)).join(', ') },
        });
      }
    }
  }

  // T) Tempo de cozinha: tendência
  if (level >= 3) {
    const valid = (o: OrderRow) => o.kitchenMin != null && o.kitchenMin > 0 && (!o.expected || o.kitchenMin <= o.expected * 3);
    const a = D.orders.filter((o) => inWin(o.day, w7) && valid(o)).map((o) => o.kitchenMin!);
    const b = D.orders.filter((o) => o.day >= addDays(now.day, -35) && o.day < w7.from && valid(o)).map((o) => o.kitchenMin!);
    if (a.length >= 30 && b.length >= 30) {
      const ma = median(a), mb = median(b), p = ma / mb - 1;
      if (Math.abs(p) >= 0.2 && Math.abs(ma - mb) >= 3) {
        push({
          key: 'period.kitchen', bucket: bucketOf(p, 0.1), type: 'OPERACIONAL', kind: 'INSIGHT', scope: 'PERIODO',
          title: p > 0 ? 'Tempo de preparo aumentou' : 'Tempo de preparo diminuiu',
          text: `O tempo mediano de cozinha foi ${Math.round(ma)} min nos últimos 7 dias, contra ${Math.round(mb)} min nas 4 semanas anteriores (${signPct(p)}).`,
          metric: { label: 'Tempo de cozinha (mediana)', current: Math.round(ma), reference: Math.round(mb), diffAbs: Math.round(ma - mb), diffPct: p, unit: 'MIN' },
          period: fmtWin(w7), comparison: '4 semanas anteriores', confidence: 'ALTA', impactCents: 30000,
          detail: { method: 'Mediana do tempo envio → pronto; tempos esquecidos (acima de 3× o padrão) ficam de fora.', samples: `${a.length} × ${b.length} pedidos` },
        });
      }
    }
  }

  // ---------- ranking, repetição e resultado ----------
  const todayStart = now.day;
  const logged = (await tx.execute(sql`
    SELECT key, bucket, to_char((created_at AT TIME ZONE ${TZ})::date,'YYYY-MM-DD') AS day FROM insight_log
    WHERE created_at > now() - interval '4 days'`)).rows as { key: string; bucket: string; day: string }[];
  for (const i of out) {
    const prev = logged.find((l) => l.key === i.key && l.bucket === i.bucket && l.day < todayStart);
    if (prev) { i.repeated = true; i.score = Math.round(i.score * 0.4 * 10) / 10; }
  }
  const all = [...out].sort((a, b) => b.score - a.score);
  const top = [...all.filter((i) => !i.repeated), ...all.filter((i) => i.repeated)].slice(0, 5);
  if (opts.log !== false) {
    for (const i of top) {
      if (!logged.some((l) => l.key === i.key && l.bucket === i.bucket && l.day === todayStart)) {
        await tx.insert(insightLog).values({ key: i.key, bucket: i.bucket, payload: { title: i.title, metric: i.metric } });
      }
    }
  }
  const firstDay = pastDays[0] ?? (todayOrders.length ? now.day : null);
  const message = !firstDay
    ? 'Assim que houver dados suficientes, seus primeiros insights aparecerão aqui.'
    : level === 1
      ? `Há dados de ${dataDays} dia(s) completo(s). Ainda não há histórico suficiente para identificar padrões confiáveis; por enquanto aparecem só informações do dia.`
      : level === 2
        ? `Histórico inicial: ${dataDays} dias. Comparações simples liberadas; tendências e padrões por dia da semana a partir de 28 dias.`
        : level === 3
          ? `Histórico consolidado: ${dataDays} dias. Tendências, dia da semana e anomalias liberados.`
          : `Histórico robusto: ${dataDays} dias.`;
  const result: InsightsResult = { level, dataDays, firstDay, message, top, all, generatedAt: new Date().toISOString() };
  if (!opts.now) cache = { key: cacheKey, at: Date.now(), value: result };
  return result;
}
