import { useState } from 'react';
import { brl, pct } from '../format';
import type { Insight, InsightMetric } from '../types';
import { Badge, Modal } from './ui';

const TYPE_UI: Record<string, { icon: string; label: string; tone: string }> = {
  OPORTUNIDADE: { icon: '🚀', label: 'Oportunidade', tone: 'ok' },
  TENDENCIA: { icon: '📈', label: 'Tendência', tone: 'info' },
  ANOMALIA: { icon: '⚡', label: 'Fora do padrão', tone: 'warn' },
  ALERTA: { icon: '⚠', label: 'Alerta', tone: 'danger' },
  DESEMPENHO: { icon: '🎯', label: 'Desempenho', tone: 'brand' },
  PRODUTO: { icon: '🍢', label: 'Produto', tone: 'brand' },
  OPERACIONAL: { icon: '🛠', label: 'Operação', tone: 'info' },
  FINANCEIRO: { icon: '💰', label: 'Financeiro', tone: 'ok' },
};
const KIND_LABEL: Record<string, string> = { DADO: 'Dado', ESTIMATIVA: 'Estimativa', INSIGHT: 'Insight', RECOMENDACAO: 'Recomendação' };

export function fmtMetric(v: number | undefined, unit: InsightMetric['unit']) {
  if (v == null) return '—';
  if (unit === 'BRL') return brl(Math.round(v));
  if (unit === 'PCT') return pct(v, 1);
  if (unit === 'MIN') return `${Math.round(v)} min`;
  return String(Math.round(v * 10) / 10).replace('.', ',');
}

export function InsightCard({ i, compact }: { i: Insight; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const t = TYPE_UI[i.type] ?? { icon: '•', label: i.type, tone: 'muted' };
  const up = (i.metric.diffPct ?? i.metric.diffAbs ?? 0) >= 0;
  return (
    <>
      <div className={`insight-card t-${i.type.toLowerCase()}${i.repeated ? ' repeated' : ''}`}>
        <div className="row between" style={{ gap: 8 }}>
          <span className="insight-type">{t.icon} {t.label}</span>
          <span className="row" style={{ gap: 6 }}>
            {i.kind === 'ESTIMATIVA' && <Badge tone="warn">estimativa</Badge>}
            {i.repeated && <Badge>já visto</Badge>}
          </span>
        </div>
        <div className="insight-title">{i.title}</div>
        {!compact && <div className="insight-text">{i.text}</div>}
        <div className="insight-metric">
          <span className="num insight-value">{i.metric.range ? `${fmtMetric(i.metric.range[0], i.metric.unit)} – ${fmtMetric(i.metric.range[1], i.metric.unit)}` : fmtMetric(i.metric.current, i.metric.unit)}</span>
          {i.metric.diffPct != null && isFinite(i.metric.diffPct) && <span className={`insight-diff ${up ? 'up' : 'down'}`}>{up ? '▲' : '▼'} {pct(Math.abs(i.metric.diffPct))}</span>}
          {i.metric.reference != null && <span className="small muted">vs {fmtMetric(i.metric.reference, i.metric.unit)}</span>}
        </div>
        {i.action && <div className="insight-action">👉 {i.action}</div>}
        <div className="row between small" style={{ marginTop: 'auto' }}>
          <span className="faint">{i.period}{i.comparison ? ` · vs ${i.comparison}` : ''}</span>
          <button className="linkish" onClick={() => setOpen(true)}>Por quê?</button>
        </div>
      </div>
      {open && <InsightDetail i={i} onClose={() => setOpen(false)} />}
    </>
  );
}

export function InsightDetail({ i, onClose }: { i: Insight; onClose: () => void }) {
  const series = i.detail.series ?? [];
  const max = Math.max(1, ...series.map((s) => s.value));
  return (
    <Modal wide title={i.title} onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Entendi</button>}>
      <div className="col gap-lg">
        <p style={{ margin: 0 }}>{i.text}</p>
        <div className="row wrap" style={{ gap: 8 }}>
          <Badge tone="brand">{KIND_LABEL[i.kind]}</Badge>
          <Badge tone={i.confidence === 'ALTA' ? 'ok' : 'warn'}>Confiança {i.confidence === 'ALTA' ? 'alta' : 'média'}</Badge>
          <Badge>{i.period}</Badge>
        </div>
        <div className="grid-3">
          <div className="tile"><div className="label">{i.metric.label}</div><div className="value num">{i.metric.range ? `${fmtMetric(i.metric.range[0], i.metric.unit)}–${fmtMetric(i.metric.range[1], i.metric.unit)}` : fmtMetric(i.metric.current, i.metric.unit)}</div></div>
          {i.metric.reference != null && <div className="tile"><div className="label">Base de comparação</div><div className="value num">{fmtMetric(i.metric.reference, i.metric.unit)}</div><div className="sub">{i.comparison}</div></div>}
          {(i.metric.diffAbs != null || i.metric.diffPct != null) && <div className="tile"><div className="label">Diferença</div><div className="value num">{i.metric.diffAbs != null ? fmtMetric(i.metric.diffAbs, i.metric.unit === 'PCT' ? 'PCT' : i.metric.unit) : ''} {i.metric.diffPct != null ? `(${pct(i.metric.diffPct)})` : ''}</div></div>}
        </div>
        {series.length > 0 && (
          <div className="card tight">
            <div className="panel-title">Série usada no cálculo</div>
            <div className="bars">
              {series.map((s, k) => (
                <div key={k} className={`bar-col${s.highlight ? ' hl' : ''}`} title={`${s.label}: ${fmtMetric(s.value, i.detail.seriesUnit ?? i.metric.unit)}`}>
                  <div className="bar" style={{ height: `${Math.max(2, (s.value / max) * 100)}%` }} />
                  <span className="bar-label">{s.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="card tight">
          <div className="panel-title">Como foi calculado</div>
          <div className="small">{i.detail.method}</div>
          <div className="small muted mt">Amostra: {i.detail.samples}</div>
          <div className="small faint mt">Os números vêm direto das vendas registradas. O sistema mostra comparações, não afirma causas.</div>
        </div>
      </div>
    </Modal>
  );
}
