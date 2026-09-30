import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useSettings } from '../../components/layout';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { dateTime, fmtDay, todayISO } from '../../format';
import type { InsightsResult } from '../../types';
import { Spinner, useAction } from '../../components/ui';
import { InsightCard } from '../../components/insights';

const LEVELS = [
  { n: 1, days: 0, label: 'Início', desc: 'Só informações do dia' },
  { n: 2, days: 7, label: '7 dias', desc: 'Comparações simples' },
  { n: 3, days: 28, label: '28 dias', desc: 'Tendências, dia da semana, anomalias' },
  { n: 4, days: 56, label: '56 dias', desc: 'Histórico robusto (mês × mês)' },
];

export default function InsightsPage() {
  const { data: settings } = useSettings();
  // Só decide depois de saber se está ligado: nada da página aparece (nem por um instante) quando desligado
  if (!settings) return <Spinner />;
  if (!settings.insightsEnabled) return <Navigate to="/admin" replace />;
  return <InsightsPageInner />;
}

function InsightsPageInner() {
  const { data, isLoading } = useQuery({ queryKey: ['insights'], queryFn: () => api.get<InsightsResult>('/api/insights'), refetchInterval: 5 * 60_000 });
  const { data: excluded = [] } = useQuery({ queryKey: ['excluded'], queryFn: () => api.get<{ day: string; reason: string }[]>('/api/excluded-days') });
  const [day, setDay] = useState('');
  const [reason, setReason] = useState('');
  const { busy, run } = useAction();
  const qc = useQueryClient();
  const refresh = () => { qc.invalidateQueries({ queryKey: ['excluded'] }); qc.invalidateQueries({ queryKey: ['insights'] }); };

  if (isLoading || !data) return <Spinner />;
  const next = LEVELS.find((l) => l.days > data.dataDays);
  const others = data.all.filter((i) => !data.top.some((t) => t.key === i.key));

  return (
    <div className="col gap-lg">
      <div className="row between wrap">
        <div>
          <h1>💡 Insights</h1>
          <div className="muted small">Leituras automáticas das vendas reais. Números calculados pelo sistema — nada é inventado. Atualizado {dateTime(data.generatedAt)}.</div>
        </div>
      </div>

      <div className="card">
        <div className="maturity">
          {LEVELS.map((l) => (
            <div key={l.n} className={`mat-step${data.level >= l.n ? ' done' : ''}${data.level === l.n ? ' current' : ''}`}>
              <span className="mat-dot">{l.n}</span>
              <span className="mat-label">{l.label}</span>
              <span className="mat-desc">{l.desc}</span>
            </div>
          ))}
        </div>
        <div className="small muted mt">{data.message}{next ? ` Faltam ${next.days - data.dataDays} dia(s) com vendas para o próximo nível.` : ''}</div>
      </div>

      {data.top.length === 0 ? (
        <div className="card empty">{data.dataDays === 0 && !data.firstDay ? 'Assim que houver dados suficientes, seus primeiros insights aparecerão aqui.' : 'Nada fora do padrão para destacar agora. Isso é bom sinal: as vendas estão dentro do esperado.'}</div>
      ) : <>
        <div className="panel-title">Principais agora</div>
        <div className="insight-grid">{data.top.map((i) => <InsightCard key={i.key} i={i} />)}</div>
      </>}
      {others.length > 0 && <>
        <div className="panel-title">Outras leituras</div>
        <div className="insight-grid">{others.map((i) => <InsightCard key={i.key} i={i} />)}</div>
      </>}

      <div className="card col gap-lg">
        <div>
          <b>Dias atípicos</b>
          <div className="small muted">Evento fechado, chuva forte, falta de energia… Marque o dia para ele não distorcer médias e comparações. As vendas continuam no financeiro.</div>
        </div>
        <div className="row wrap">
          <input type="date" className="input" style={{ width: 170 }} max={todayISO()} value={day} onChange={(e) => setDay(e.target.value)} />
          <input className="input grow" style={{ minWidth: 200 }} placeholder="Motivo (ex.: evento fechado)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
          <button className="btn primary" disabled={busy || !day || reason.trim().length < 3} onClick={async () => {
            if (await run(() => api.post('/api/excluded-days', { day, reason: reason.trim() }), 'Dia marcado como atípico.')) { setDay(''); setReason(''); refresh(); }
          }}>Marcar</button>
        </div>
        {excluded.map((e) => (
          <div key={e.day} className="kv"><span><b>{fmtDay(e.day)}</b> <span className="small muted">· {e.reason}</span></span>
            <button className="btn sm ghost" disabled={busy} onClick={async () => { if (await run(() => api.del(`/api/excluded-days/${e.day}`), 'Dia voltou às comparações.')) refresh(); }}>Incluir de novo</button></div>
        ))}
      </div>
    </div>
  );
}
