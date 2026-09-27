import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../../api';
import { addDaysISO, dateTime, fmtDay, time, todayISO } from '../../format';
import { Modal, Spinner, useAction } from '../../components/ui';

type Timing = {
  from: string; to: string; samples: number;
  medians: { queue: number | null; prep: number | null; kitchen: number | null; counter: number | null; total: number | null };
  suspects: { id: number; number: number; accountNumber: number; customerName: string | null; expected: number; kitchen: number; confirmedAt: string; startedAt: string | null; readyAt: string | null; deliveredAt: string | null }[];
  stuck: { id: number; number: number; status: string; accountNumber: number; customerName: string | null; expected: number; age: number }[];
  perProduct: { id: number; name: string; prepMinutes: number; medianMin: number | null; samples: number; suggestedMinutes: number | null }[];
};

const m = (v: number | null) => v == null ? '—' : `${String(v).replace('.', ',')} min`;
const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`;
};

export default function TimingPage() {
  const [range, setRange] = useState({ from: addDaysISO(todayISO(), -6), to: todayISO() });
  const { data, isLoading } = useQuery({ queryKey: ['timing', range], queryFn: () => api.get<Timing>(`/api/timing${qs(range)}`) });
  const [fix, setFix] = useState<Timing['suspects'][number] | null>(null);
  const [edit, setEdit] = useState<Timing['perProduct'][number] | null>(null);
  const { busy, run } = useAction();
  const qc = useQueryClient();

  return (
    <div className="col gap-lg">
      <div className="row between wrap">
        <div>
          <h1>Tempo de preparo</h1>
          <div className="muted small">{fmtDay(range.from)} a {fmtDay(range.to)} · medianas (tempos esquecidos ficam de fora até serem corrigidos)</div>
        </div>
        <div className="row wrap">
          <div className="seg">
            <button onClick={() => setRange({ from: todayISO(), to: todayISO() })}>Hoje</button>
            <button onClick={() => setRange({ from: addDaysISO(todayISO(), -6), to: todayISO() })}>7 dias</button>
            <button onClick={() => setRange({ from: addDaysISO(todayISO(), -27), to: todayISO() })}>4 semanas</button>
          </div>
        </div>
      </div>
      {isLoading || !data ? <Spinner /> : <>
        <div className="tiles">
          <div className="tile"><div className="label">Fila (enviado → iniciou)</div><div className="value num">{m(data.medians.queue)}</div></div>
          <div className="tile"><div className="label">Preparo (iniciou → pronto)</div><div className="value num">{m(data.medians.prep)}</div></div>
          <div className="tile hero"><div className="label">Cozinha total</div><div className="value num">{m(data.medians.kitchen)}</div><div className="sub">{data.samples} pedidos válidos</div></div>
          <div className="tile"><div className="label">Balcão (pronto → entregue)</div><div className="value num">{m(data.medians.counter)}</div></div>
          <div className="tile"><div className="label">Total do cliente</div><div className="value num">{m(data.medians.total)}</div></div>
        </div>

        {data.stuck.length > 0 && (
          <div className="card">
            <div className="panel-title">Parados na cozinha agora (mais de 3× o tempo padrão)</div>
            {data.stuck.map((s) => <div key={s.id} className="kv"><span>Pedido #{s.number} · conta #{s.accountNumber}{s.customerName ? ` · ${s.customerName}` : ''} · {s.status === 'CONFIRMED' ? 'não iniciado' : 'em preparo'}</span><span className="v" style={{ color: 'var(--danger)' }}>{s.age} min</span></div>)}
            <div className="small faint mt">Provavelmente alguém esqueceu de marcar. Peça para a cozinha atualizar o status.</div>
          </div>
        )}

        <div className="card">
          <div className="panel-title">Tempos suspeitos ({data.suspects.length})</div>
          <div className="small muted" style={{ marginBottom: 8 }}>Pedidos que passaram de 3× o tempo esperado — geralmente “pronto” marcado tarde. Ficam fora das médias até você corrigir ou confirmar.</div>
          {!data.suspects.length && <div className="empty small">Nenhum. 👍</div>}
          {data.suspects.map((s) => (
            <div key={s.id} className="kv">
              <span>Pedido #{s.number} · conta #{s.accountNumber}{s.customerName ? ` · ${s.customerName}` : ''} <span className="small muted">· enviado {time(s.confirmedAt)} · pronto {time(s.readyAt)}</span></span>
              <span className="row"><span className="v" style={{ color: 'var(--warn)' }}>{s.kitchen} min <span className="faint small">(padrão {s.expected})</span></span><button className="btn sm" onClick={() => setFix(s)}>Corrigir</button></span>
            </div>
          ))}
        </div>

        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: 12 }}>
            <div className="panel-title" style={{ margin: 0 }}>Por produto (últimas 4 semanas)</div>
            <div className="small muted">Tempo padrão usado na previsão para o cliente e nas cores da cozinha. Sugestão aparece com 10+ pedidos e diferença de 3+ min.</div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Produto</th><th className="right">Padrão</th><th className="right">Mediana real</th><th className="right">Pedidos</th><th></th></tr></thead>
              <tbody>
                {data.perProduct.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td className="right num">{p.prepMinutes} min</td>
                    <td className="right num">{m(p.medianMin)}</td>
                    <td className="right num">{p.samples}</td>
                    <td className="right">
                      {p.suggestedMinutes != null && <button className="btn sm go" disabled={busy} onClick={() => run(async () => { await api.post(`/api/products/${p.id}/prep`, { minutes: p.suggestedMinutes }); qc.invalidateQueries({ queryKey: ['timing'] }); }, `${p.name}: padrão ${p.suggestedMinutes} min.`)}>Usar {p.suggestedMinutes} min</button>}
                      <button className="btn sm ghost" onClick={() => setEdit(p)}>Editar</button>
                    </td>
                  </tr>
                ))}
                {!data.perProduct.length && <tr><td colSpan={5} className="empty">Ainda sem pedidos de cozinha suficientes.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </>}
      {fix && <FixModal s={fix} onClose={() => setFix(null)} />}
      {edit && <PrepModal p={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function FixModal({ s, onClose }: { s: Timing['suspects'][number]; onClose: () => void }) {
  const [field, setField] = useState<'readyAt' | 'startedAt' | 'deliveredAt'>('readyAt');
  const cur = field === 'readyAt' ? s.readyAt : field === 'startedAt' ? s.startedAt : s.deliveredAt;
  const [value, setValue] = useState(toLocalInput(s.readyAt));
  const [reason, setReason] = useState('');
  const { busy, run } = useAction();
  const qc = useQueryClient();
  const iso = value ? new Date(`${value}:00-03:00`).toISOString() : null;
  return (
    <Modal title={`Corrigir horário · pedido #${s.number}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary" disabled={busy || !iso || reason.trim().length < 3} onClick={async () => {
        if (await run(() => api.post(`/api/orders/${s.id}/times`, { field, value: iso, reason: reason.trim() }), 'Horário corrigido (o original fica guardado).')) { qc.invalidateQueries({ queryKey: ['timing'] }); onClose(); }
      }}>Salvar correção</button>
    </>}>
      <div className="col gap-lg">
        <div className="small muted">Enviado à cozinha: <b>{dateTime(s.confirmedAt)}</b> · iniciou: {dateTime(s.startedAt) || '—'} · pronto: {dateTime(s.readyAt) || '—'} · entregue: {dateTime(s.deliveredAt) || '—'}</div>
        <div className="seg">
          <button className={field === 'startedAt' ? 'on' : ''} onClick={() => { setField('startedAt'); setValue(toLocalInput(s.startedAt)); }}>Início</button>
          <button className={field === 'readyAt' ? 'on' : ''} onClick={() => { setField('readyAt'); setValue(toLocalInput(s.readyAt)); }}>Pronto</button>
          <button className={field === 'deliveredAt' ? 'on' : ''} onClick={() => { setField('deliveredAt'); setValue(toLocalInput(s.deliveredAt)); }}>Entregue</button>
        </div>
        <label className="field"><span>Horário correto (atual: {cur ? dateTime(cur) : '—'})</span><input type="datetime-local" className="input" value={value} onChange={(e) => setValue(e.target.value)} /></label>
        <label className="field"><span>Motivo (obrigatório)</span><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: cozinha esqueceu de marcar pronto" maxLength={300} /></label>
      </div>
    </Modal>
  );
}

function PrepModal({ p, onClose }: { p: Timing['perProduct'][number]; onClose: () => void }) {
  const [min, setMin] = useState(String(p.prepMinutes));
  const { busy, run } = useAction();
  const qc = useQueryClient();
  const v = Number(min);
  return (
    <Modal title={`Tempo padrão · ${p.name}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary" disabled={busy || !(v >= 1 && v <= 240)} onClick={async () => {
        if (await run(() => api.post(`/api/products/${p.id}/prep`, { minutes: v }), 'Tempo padrão salvo.')) { qc.invalidateQueries({ queryKey: ['timing'] }); qc.invalidateQueries({ queryKey: ['menu'] }); onClose(); }
      }}>Salvar</button>
    </>}>
      <label className="field"><span>Minutos (1 a 240)</span><input className="input money" inputMode="numeric" autoFocus value={min} onChange={(e) => setMin(e.target.value.replace(/\D/g, '').slice(0, 3))} /></label>
    </Modal>
  );
}
