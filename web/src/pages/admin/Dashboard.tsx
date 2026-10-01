import { useSettings } from '../../components/layout';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../../api';
import { addDaysISO, brl, dateTime, fmtDay, pct, todayISO } from '../../format';
import type { InsightsResult } from '../../types';
import { Spinner } from '../../components/ui';
import { InsightCard } from '../../components/insights';

type Dash = {
  from: string; to: string; revenueCents: number; grossSalesCents: number; itemsSold: number; ordersCount: number; accountsCount: number; averageTicketCents: number;
  accountsOpenNow: number; accountsClosedInRange: number; accountsPendingNow: number; pendingCents: number;
  ordersNew: number; ordersPreparing: number; ordersReady: number; ordersAwaiting: number;
  discountsCents: number; discountsCount: number; discountsByUser: { name: string; cents: number; count: number }[];
  cancellationsCents: number; cancellationsCount: number; lossCents: number;
  payments: { code: string; name: string; cents: number; count: number }[]; receivedCents: number;
  topProducts: { name: string; qty: number; cents: number }[];
  byCategory: { name: string; cents: number; qty: number }[];
  byHour: { hour: number; orders: number }[];
  kitchenMedianMin: number | null; kitchenSamples: number;
  lowStock: { id: number; name: string; qty: number; lim: number }[];
  backup: { at: string | null; ok: boolean | null; info: string | null; stale: boolean; configured: boolean } | null;
  mei: { yearRevenueCents: number; limitCents: number } | null;
};

type Preset = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'custom';
function presetRange(p: Preset, custom: { from: string; to: string }) {
  const t = todayISO();
  switch (p) {
    case 'today': return { from: t, to: t };
    case 'yesterday': return { from: addDaysISO(t, -1), to: addDaysISO(t, -1) };
    case '7d': return { from: addDaysISO(t, -6), to: t };
    case '30d': return { from: addDaysISO(t, -29), to: t };
    case 'month': return { from: t.slice(0, 8) + '01', to: t };
    default: return custom;
  }
}
const PRESETS: { k: Preset; label: string }[] = [
  { k: 'today', label: 'Hoje' }, { k: 'yesterday', label: 'Ontem' }, { k: '7d', label: '7 dias' }, { k: '30d', label: '30 dias' }, { k: 'month', label: 'Mês' }, { k: 'custom', label: 'Período' },
];

export default function Dashboard() {
  const [preset, setPreset] = useState<Preset>(() => { try { return (sessionStorage.getItem('ha:dashPreset') as Preset) || 'today'; } catch { return 'today'; } });
  const [custom, setCustom] = useState({ from: addDaysISO(todayISO(), -6), to: todayISO() });
  const r = presetRange(preset, custom);
  const { data: d, isLoading } = useQuery({ queryKey: ['dashboard', r.from, r.to], queryFn: () => api.get<Dash>(`/api/dashboard${qs(r)}`), refetchInterval: 60_000 });
  const { data: settings } = useSettings();
  const { data: ins } = useQuery({ queryKey: ['insights'], queryFn: () => api.get<InsightsResult>('/api/insights'), refetchInterval: 5 * 60_000, enabled: settings?.insightsEnabled === true });
  const pick = (p: Preset) => { setPreset(p); try { sessionStorage.setItem('ha:dashPreset', p); } catch { /* ok */ } };
  const single = r.from === r.to;
  const maxHour = Math.max(1, ...(d?.byHour ?? []).map((h) => h.orders));
  const catTotal = (d?.byCategory ?? []).reduce((s, c) => s + c.cents, 0);

  return (
    <div className="col gap-lg">
      <div className="row between wrap">
        <div>
          <h1>Dashboard</h1>
          <div className="muted small">{single ? fmtDay(r.from) : `${fmtDay(r.from)} a ${fmtDay(r.to)}`}</div>
        </div>
        <div className="row wrap">
          <div className="seg">{PRESETS.map((p) => <button key={p.k} className={preset === p.k ? 'on' : ''} onClick={() => pick(p.k)}>{p.label}</button>)}</div>
          {preset === 'custom' && <>
            <input type="date" className="input" style={{ width: 160 }} value={custom.from} max={custom.to} onChange={(e) => e.target.value && setCustom((c) => ({ ...c, from: e.target.value }))} />
            <input type="date" className="input" style={{ width: 160 }} value={custom.to} min={custom.from} max={todayISO()} onChange={(e) => e.target.value && setCustom((c) => ({ ...c, to: e.target.value }))} />
          </>}
        </div>
      </div>

      {d?.backup?.stale && (
        <div className="problem-box">
          💾 {!d.backup.configured ? 'Backup sem pasta configurada (BACKUP_DIRS no .env).' : d.backup.ok === false ? `O último backup falhou (${dateTime(d.backup.at)}).` : d.backup.at ? `Último backup há mais de 2 dias (${dateTime(d.backup.at)}).` : 'Nenhum backup feito ainda.'}
          <Link className="btn sm" to="/admin/configuracoes">Fazer backup</Link>
        </div>
      )}

      {settings?.insightsEnabled && ins && (
        <div className="card">
          <div className="row between wrap" style={{ marginBottom: 10 }}>
            <div className="panel-title" style={{ margin: 0 }}>💡 Insights {ins.level > 1 && <span className="faint">· nível {ins.level}</span>}</div>
            <Link to="/admin/insights" className="small">Ver todos →</Link>
          </div>
          {ins.top.length ? (
            <div className="insight-grid">{ins.top.slice(0, 3).map((i) => <InsightCard key={i.key} i={i} compact />)}</div>
          ) : <div className="muted small">{ins.message}</div>}
        </div>
      )}

      {isLoading || !d ? <Spinner /> : <>
        <div className="tiles">
          <div className="tile hero"><div className="label">Faturamento</div><div className="value num">{brl(d.revenueCents)}</div><div className="sub">vendas {brl(d.grossSalesCents)} − descontos {brl(d.discountsCents)}</div></div>
          <div className="tile"><div className="label">Contas</div><div className="value num">{d.accountsCount}</div></div>
          <div className="tile"><div className="label">Pedidos</div><div className="value num">{d.ordersCount}</div><div className="sub">{d.itemsSold} itens</div></div>
          <div className="tile"><div className="label">Ticket médio</div><div className="value num">{brl(d.averageTicketCents)}</div><div className="sub">por conta</div></div>
          <div className="tile"><div className="label">Recebido</div><div className="value num">{brl(d.receivedCents)}</div></div>
          <div className="tile"><div className="label">Tempo de cozinha</div><div className="value num">{d.kitchenMedianMin != null ? `${d.kitchenMedianMin} min` : '—'}</div><div className="sub">mediana · {d.kitchenSamples} pedidos</div></div>
        </div>

        <div className="tiles">
          <Link to="/caixa" className="tile" style={{ textDecoration: 'none', color: 'inherit' }}><div className="label">Contas abertas agora</div><div className="value num">{d.accountsOpenNow}</div></Link>
          <Link to="/admin/receber" className="tile" style={{ textDecoration: 'none', color: 'inherit' }}><div className="label">Pendentes (a receber)</div><div className="value num" style={{ color: d.accountsPendingNow ? 'var(--danger)' : undefined }}>{d.accountsPendingNow}</div><div className="sub">{brl(d.pendingCents)}</div></Link>
          <div className="tile"><div className="label">Cozinha agora</div><div className="value num">{d.ordersNew + d.ordersPreparing}</div><div className="sub">{d.ordersNew} novos · {d.ordersPreparing} em preparo · {d.ordersReady} prontos</div></div>
          <div className="tile"><div className="label">Contas encerradas</div><div className="value num">{d.accountsClosedInRange}</div><div className="sub">no período</div></div>
          {d.ordersAwaiting > 0 && <div className="tile"><div className="label">Aguardando confirmação (QR)</div><div className="value num">{d.ordersAwaiting}</div></div>}
        </div>

        <div className="grid-2">
          <div className="card">
            <div className="panel-title">Pedidos por hora {single ? '' : '(soma do período)'}</div>
            {!d.byHour.length ? <div className="muted small">Sem pedidos.</div> : (
              <div className="bars hours">
                {Array.from({ length: 24 }, (_, h) => h).filter((h) => h >= Math.min(...d.byHour.map((x) => x.hour)) && h <= Math.max(...d.byHour.map((x) => x.hour))).map((h) => {
                  const v = d.byHour.find((x) => x.hour === h)?.orders ?? 0;
                  return (
                    <div key={h} className={`bar-col${v === maxHour ? ' hl' : ''}`} title={`${h}h: ${v} pedidos`}>
                      <span className="bar-val">{v || ''}</span>
                      <div className="bar" style={{ height: `${Math.max(2, (v / maxHour) * 100)}%` }} />
                      <span className="bar-label">{h}h</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="card">
            <div className="panel-title">Vendas por categoria</div>
            {!d.byCategory.length && <div className="muted small">Sem vendas.</div>}
            {d.byCategory.map((c) => (
              <div key={c.name} className="hbar-row">
                <span className="hbar-name">{c.name}</span>
                <div className="hbar"><div style={{ width: `${catTotal ? (c.cents / catTotal) * 100 : 0}%` }} /></div>
                <span className="num small hbar-val">{brl(c.cents)} <span className="faint">{pct(catTotal ? c.cents / catTotal : 0)}</span></span>
              </div>
            ))}
          </div>
        </div>

        <div className="grid-3">
          <div className="card">
            <div className="panel-title">Pagamentos recebidos</div>
            {d.payments.map((p) => <div key={p.code} className="kv"><span>{p.name} <span className="faint small">({p.count})</span></span><span className="v">{brl(p.cents)}</span></div>)}
            <div className="kv total"><span>Total</span><span className="v">{brl(d.receivedCents)}</span></div>
          </div>
          <div className="card">
            <div className="panel-title">Descontos e cancelamentos</div>
            <div className="kv"><span>Descontos/ajustes ({d.discountsCount})</span><span className="v">{brl(d.discountsCents)}</span></div>
            {d.discountsByUser.map((u) => <div key={u.name} className="kv small"><span className="muted">· {u.name}</span><span className="v">{brl(u.cents)} ({u.count})</span></div>)}
            <div className="kv"><span>Cancelamentos ({d.cancellationsCount})</span><span className="v">{brl(d.cancellationsCents)}</span></div>
            <div className="kv small"><span className="muted">· perdas (já preparado/entregue)</span><span className="v">{brl(d.lossCents)}</span></div>
            <Link to="/admin/cancelamentos" className="small">Ver cancelamentos →</Link>
          </div>
          <div className="card">
            <div className="panel-title">Mais vendidos</div>
            {!d.topProducts.length && <div className="muted small">Sem vendas.</div>}
            {d.topProducts.map((p) => <div key={p.name} className="kv"><span className="ellipsis">{p.name}</span><span className="v">{p.qty}× <span className="faint small">{brl(p.cents)}</span></span></div>)}
          </div>
        </div>

        {d.lowStock.length > 0 && (
          <div className="card">
            <div className="row between"><div className="panel-title">Estoque baixo</div><Link to="/caixa/estoque" className="small">Abrir estoque →</Link></div>
            <div className="row wrap" style={{ gap: 8 }}>
              {d.lowStock.map((l) => <span key={l.id} className={`badge ${l.qty <= 0 ? 'danger' : 'warn'}`}>{l.name}: {l.qty}</span>)}
            </div>
          </div>
        )}

        {d.mei && (
          <div className="card">
            <div className="panel-title">Faturamento no ano (acompanhamento do MEI)</div>
            <div className="row between wrap">
              <div className="big num" style={{ fontWeight: 800 }}>{brl(d.mei.yearRevenueCents)}</div>
              <div className="small muted">{pct(d.mei.yearRevenueCents / d.mei.limitCents)} do limite de referência de {brl(d.mei.limitCents)}</div>
            </div>
            <div className="meter"><div style={{ width: `${Math.min(100, (d.mei.yearRevenueCents / d.mei.limitCents) * 100)}%` }} /></div>
            <div className="small faint mt">Valor lançado no sistema. Confirme o limite vigente e as regras com o contador.</div>
          </div>
        )}
      </>}
    </div>
  );
}
