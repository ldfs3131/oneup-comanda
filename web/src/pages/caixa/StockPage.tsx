import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { MOVEMENT_LABEL, dateTime, norm } from '../../format';
import { Badge, Modal, Spinner, useAction } from '../../components/ui';

type Row = { id: number; name: string; stockQty: number; lowStockAt: number | null; active: boolean; available: boolean; categoryName: string; lastCountAt: string | null; movements: number };
type Mov = { id: number; type: string; quantity: number; before: number; after: number; missing: number | null; reason: string | null; createdAt: string; userName: string | null };
type Div = { id: number; productName: string; missing: number; before: number; reason: string; createdAt: string; userName: string | null };

const level = (r: Row) => r.stockQty <= 0 ? 'danger' : r.stockQty <= (r.lowStockAt ?? 3) ? 'warn' : 'ok';

export default function StockPage() {
  const { data, isLoading } = useQuery({ queryKey: ['stock'], queryFn: () => api.get<Row[]>('/api/stock'), refetchInterval: 30_000 });
  const { data: divs = [] } = useQuery({ queryKey: ['stockDiv'], queryFn: () => api.get<Div[]>('/api/stock/divergences') });
  const [q, setQ] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [op, setOp] = useState<{ row: Row; type: 'ENTRADA' | 'AJUSTE' } | null>(null);
  const [hist, setHist] = useState<Row | null>(null);
  const [count, setCount] = useState(false);
  const [tab, setTab] = useState<'stock' | 'div'>('stock');

  const rows = useMemo(() => (data ?? []).filter((r) => (showInactive || r.active) && (!q || norm(r.name).includes(norm(q)))), [data, q, showInactive]);
  const groups = useMemo(() => {
    const m = new Map<string, Row[]>();
    rows.forEach((r) => m.set(r.categoryName, [...(m.get(r.categoryName) ?? []), r]));
    return [...m.entries()];
  }, [rows]);

  if (isLoading || !data) return <Spinner />;
  const never = data.filter((r) => r.active && !r.lastCountAt).length;
  const low = data.filter((r) => r.active && level(r) !== 'ok').length;

  return (
    <div className="col gap-lg">
      <div className="row between wrap">
        <div>
          <h1>Estoque</h1>
          <div className="muted small">Bebidas e produtos contados por unidade. Vendas baixam sozinhas; entradas e contagens você lança aqui.</div>
        </div>
        <div className="page-head-tools">
          <input className="input" style={{ width: 240, maxWidth: '100%' }} placeholder="Buscar produto" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn primary" onClick={() => setCount(true)}>📋 Contagem geral</button>
        </div>
      </div>
      {never > 0 && <div className="info-box">⚠ {never} produto(s) nunca foram contados. Faça a <b>contagem geral</b> antes de abrir para o estoque ficar certo.</div>}
      <div className="row wrap between">
        <div className="seg">
          <button className={tab === 'stock' ? 'on' : ''} onClick={() => setTab('stock')}>Produtos {low > 0 && <span className="badge warn">{low} baixo</span>}</button>
          <button className={tab === 'div' ? 'on' : ''} onClick={() => setTab('div')}>Divergências {divs.length > 0 && <span className="badge danger">{divs.length}</span>}</button>
        </div>
        {tab === 'stock' && <label className="check small"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />Mostrar inativos</label>}
      </div>

      {tab === 'stock' && groups.map(([cat, list]) => (
        <div key={cat} className="card">
          <div className="panel-title">{cat}</div>
          {list.map((r) => (
            <div key={r.id} className="stock-row">
              <div className="grow">
                <div style={{ fontWeight: 700 }} className={r.active ? '' : 'faint'}>{r.name}{!r.active && <span className="small"> (inativo)</span>}</div>
                <div className="small faint">{r.lastCountAt ? `última contagem/entrada ${dateTime(r.lastCountAt)}` : 'nunca contado'}{r.lowStockAt != null ? ` · alerta em ${r.lowStockAt}` : ''}</div>
              </div>
              <span className={`stock-qty ${level(r)}`}>{r.stockQty}</span>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn sm go" onClick={() => setOp({ row: r, type: 'ENTRADA' })}>+ Entrada</button>
                <button className="btn sm" onClick={() => setOp({ row: r, type: 'AJUSTE' })}>Ajustar</button>
                <button className="btn sm ghost" onClick={() => setHist(r)}>Histórico</button>
              </div>
            </div>
          ))}
        </div>
      ))}
      {tab === 'stock' && !groups.length && <div className="card empty">Nenhum produto com controle de estoque{q ? ` para “${q}”` : ''}.</div>}

      {tab === 'div' && (
        <div className="card">
          <div className="panel-title">Vendas liberadas sem estoque registrado</div>
          <div className="small muted" style={{ marginBottom: 8 }}>Cada linha é uma venda feita com “Liberar venda”. Use para achar erros de contagem ou entradas não lançadas.</div>
          {!divs.length && <div className="empty small">Nenhuma divergência.</div>}
          {divs.map((d) => (
            <div key={d.id} className="kv"><span><b>{d.productName}</b> <span className="small muted">· faltou {d.missing} · {dateTime(d.createdAt)} · {d.userName} · {d.reason}</span></span><Badge tone="danger">−{d.missing}</Badge></div>
          ))}
        </div>
      )}

      {op && <StockOpModal row={op.row} type={op.type} onClose={() => setOp(null)} />}
      {hist && <HistoryModal row={hist} onClose={() => setHist(null)} />}
      {count && <CountModal rows={data.filter((r) => r.active)} onClose={() => setCount(false)} />}
    </div>
  );
}

function StockOpModal({ row, type, onClose }: { row: Row; type: 'ENTRADA' | 'AJUSTE'; onClose: () => void }) {
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState(type === 'ENTRADA' ? 'Reposição' : '');
  const { busy, run } = useAction();
  const qc = useQueryClient();
  const n = qty === '' ? null : Number(qty);
  const ok = n != null && (type === 'ENTRADA' ? n >= 1 : n >= 0) && reason.trim().length >= 3;
  const after = n == null ? null : type === 'ENTRADA' ? row.stockQty + n : n;
  return (
    <Modal title={`${type === 'ENTRADA' ? 'Entrada' : 'Ajuste por contagem'} · ${row.name}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary" disabled={!ok || busy} onClick={async () => {
        if (await run(() => api.post(`/api/stock/${row.id}`, type === 'ENTRADA' ? { type, quantity: n, reason: reason.trim() } : { type, newQty: n, reason: reason.trim() }), 'Estoque atualizado.')) {
          qc.invalidateQueries({ queryKey: ['stock'] }); qc.invalidateQueries({ queryKey: ['menu'] }); onClose();
        }
      }}>Salvar</button>
    </>}>
      <div className="col gap-lg">
        <div className="kv"><span>Estoque atual</span><span className="v">{row.stockQty}</span></div>
        <label className="field"><span>{type === 'ENTRADA' ? 'Quantas unidades chegaram?' : 'Quantas unidades existem agora (contadas)?'}</span>
          <input className="input money" inputMode="numeric" autoFocus value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, '').slice(0, 6))} /></label>
        {after != null && <div className="kv total"><span>Fica</span><span className="v">{after}</span></div>}
        <label className="field"><span>Motivo (obrigatório)</span><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder={type === 'ENTRADA' ? 'Ex.: compra no atacado' : 'Ex.: contagem do fim do dia'} /></label>
      </div>
    </Modal>
  );
}

function HistoryModal({ row, onClose }: { row: Row; onClose: () => void }) {
  const { data, isLoading } = useQuery({ queryKey: ['stockMov', row.id], queryFn: () => api.get<Mov[]>(`/api/stock/${row.id}/movements`) });
  return (
    <Modal wide title={`Histórico · ${row.name}`} onClose={onClose}>
      {isLoading && <Spinner />}
      {data && !data.length && <div className="empty">Sem movimentações.</div>}
      {data && data.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Quando</th><th>Tipo</th><th className="right">Qtd.</th><th className="right">Antes → depois</th><th>Quem / motivo</th></tr></thead>
            <tbody>
              {data.map((m) => (
                <tr key={m.id}>
                  <td className="small">{dateTime(m.createdAt)}</td>
                  <td>{MOVEMENT_LABEL[m.type] ?? m.type}</td>
                  <td className="right num" style={{ color: m.quantity < 0 ? 'var(--danger)' : 'var(--ok)' }}>{m.quantity > 0 ? '+' : ''}{m.quantity}{m.missing ? ` (faltou ${m.missing})` : ''}</td>
                  <td className="right num">{m.before} → {m.after}</td>
                  <td className="small">{m.userName ?? '—'}{m.reason ? ` · ${m.reason}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

function CountModal({ rows, onClose }: { rows: Row[]; onClose: () => void }) {
  const [vals, setVals] = useState<Record<number, string>>({});
  const [reason, setReason] = useState(rows.some((r) => !r.lastCountAt) ? 'Contagem inicial' : 'Contagem geral');
  const { busy, run } = useAction();
  const qc = useQueryClient();
  const filled = Object.entries(vals).filter(([, v]) => v !== '');
  const changed = filled.filter(([id, v]) => rows.find((r) => r.id === Number(id))?.stockQty !== Number(v)).length;
  return (
    <Modal wide title="Contagem geral de estoque" onClose={onClose} footer={<>
      <span className="small muted" style={{ marginRight: 'auto' }}>{filled.length} contado(s) · {changed} com diferença</span>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary" disabled={!filled.length || reason.trim().length < 3 || busy} onClick={async () => {
        if (await run(() => api.post('/api/stock/count', { items: filled.map(([id, v]) => ({ productId: Number(id), qty: Number(v) })), reason: reason.trim() }), 'Contagem registrada.')) {
          qc.invalidateQueries({ queryKey: ['stock'] }); qc.invalidateQueries({ queryKey: ['menu'] }); onClose();
        }
      }}>Salvar contagem</button>
    </>}>
      <div className="col gap-lg">
        <div className="small muted">Digite só o que você contou. Campos vazios não mudam. Cada diferença vira um ajuste com seu nome no histórico.</div>
        <label className="field"><span>Motivo</span><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></label>
        <div className="count-grid">
          {rows.map((r) => (
            <label key={r.id} className="count-cell">
              <span className="grow ellipsis">{r.name}<span className="small faint"> · sistema: {r.stockQty}</span></span>
              <input className="input" inputMode="numeric" style={{ width: 90 }} value={vals[r.id] ?? ''} placeholder="—"
                onChange={(e) => setVals((v) => ({ ...v, [r.id]: e.target.value.replace(/\D/g, '').slice(0, 6) }))} />
            </label>
          ))}
        </div>
      </div>
    </Modal>
  );
}
