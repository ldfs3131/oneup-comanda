import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { Link } from 'react-router-dom';
import { MOVEMENT_LABEL, brl, dateTime, norm } from '../../format';
import { Badge, Modal, MoneyInput, Spinner, useAction } from '../../components/ui';
import { useAuth } from '../../auth';

type Row = { id: number; name: string; stockQty: number; lowStockAt: number | null; active: boolean; available: boolean; categoryName: string; lastCountAt: string | null; movements: number; costCents?: number | null; situacao?: 'ok' | 'acabando' | 'acabou' };
type Alerta = { id: number; name: string; categoryName: string; situacao: 'acabando' | 'acabou' };
type Sugestao = { suficiente: boolean; diasDeDados: number; diasMinimos?: number; janela?: number; diasCobertura: number; itens: { id: number; name: string; estoque: number; vendidos: number; mediaDia: number; precisa: number; comprar: number; conta: string }[] };
type HistLinha = { id: number; productName: string; type: string; quantity: number; before: number; after: number; reason: string | null; unitCostCents: number | null; fornecedor: string | null; createdAt: string; userName: string | null };
type Mov = { id: number; type: string; quantity: number; before: number; after: number; missing: number | null; reason: string | null; createdAt: string; userName: string | null };

const level = (r: Row) => r.stockQty <= 0 ? 'danger' : r.stockQty <= (r.lowStockAt ?? 3) ? 'warn' : 'ok';

export default function StockPage() {
  const { user } = useAuth();
  return user?.role === 'ADMIN' ? <EstoqueDono /> : <AlertasCaixa />;
}

/** Caixa: só o aviso do que acabou ou está acabando (sem quantidade nem valor). */
function AlertasCaixa() {
  const { data, isLoading } = useQuery({ queryKey: ['stock'], queryFn: () => api.get<Alerta[]>('/api/stock'), refetchInterval: 30_000 });
  if (isLoading || !data) return <Spinner />;
  const acabou = data.filter((a) => a.situacao === 'acabou');
  const acabando = data.filter((a) => a.situacao === 'acabando');
  return (
    <div className="col gap-lg">
      <div><h1>Estoque</h1><div className="muted small">Avisos para você saber o que oferecer. Entradas e contagens são com o Dono.</div></div>
      {!data.length && <div className="card empty">Tudo certo no estoque. 👍</div>}
      {acabou.length > 0 && <div className="card"><div className="panel-title">Acabou ({acabou.length})</div>
        {acabou.map((a) => <div key={a.id} className="kv"><span><b>{a.name}</b> <span className="small faint">· {a.categoryName}</span></span><Badge tone="danger">acabou</Badge></div>)}</div>}
      {acabando.length > 0 && <div className="card"><div className="panel-title">Acabando ({acabando.length})</div>
        {acabando.map((a) => <div key={a.id} className="kv"><span><b>{a.name}</b> <span className="small faint">· {a.categoryName}</span></span><Badge tone="warn">acabando</Badge></div>)}</div>}
      <div className="small muted">A venda nunca trava por estoque: se vender algo que o sistema acha que acabou, o Dono confere depois.</div>
    </div>
  );
}

function EstoqueDono() {
  const { data, isLoading } = useQuery({ queryKey: ['stock'], queryFn: () => api.get<Row[]>('/api/stock'), refetchInterval: 30_000 });
  const [q, setQ] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [op, setOp] = useState<{ row: Row; type: 'ENTRADA' | 'AJUSTE' } | null>(null);
  const [hist, setHist] = useState<Row | null>(null);
  const [minimo, setMinimo] = useState<Row | null>(null);
  const [count, setCount] = useState(false);
  const [tab, setTab] = useState<'stock' | 'comprar' | 'hist'>('stock');

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
          <div className="muted small">Produtos contados por unidade. Vendas baixam sozinhas; compras, ajustes e contagens você lança aqui.</div>
        </div>
        <div className="page-head-tools">
          <input className="input" style={{ width: 240, maxWidth: '100%' }} placeholder="Buscar produto" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn primary" onClick={() => setCount(true)}>📋 Contagem geral</button>
        </div>
      </div>
      {never > 0 && <div className="info-box">⚠ {never} produto(s) nunca foram contados. Faça a <b>contagem geral</b> antes de abrir para o estoque ficar certo.</div>}
      <div className="row wrap between">
        <div className="seg">
          <button className={tab === 'stock' ? 'on' : ''} onClick={() => setTab('stock')}>Estoque atual {low > 0 && <span className="badge warn">{low}</span>}</button>
          <button className={tab === 'comprar' ? 'on' : ''} onClick={() => setTab('comprar')}>O que comprar</button>
          <button className={tab === 'hist' ? 'on' : ''} onClick={() => setTab('hist')}>Histórico</button>
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
                <div className="small faint">{r.lastCountAt ? `última contagem/entrada ${dateTime(r.lastCountAt)}` : 'nunca contado'} · mínimo {r.lowStockAt ?? 3}</div>
              </div>
              <span className={`stock-qty ${level(r)}`} title={level(r) === 'danger' ? 'Acabou' : level(r) === 'warn' ? 'Acabando' : 'OK'}>{r.stockQty}</span>
              <div className="row wrap" style={{ gap: 6 }}>
                <button className="btn sm go" onClick={() => setOp({ row: r, type: 'ENTRADA' })}>+ Compra</button>
                <button className="btn sm" onClick={() => setOp({ row: r, type: 'AJUSTE' })}>Ajustar</button>
                <button className="btn sm ghost" onClick={() => setMinimo(r)}>Mínimo</button>
                <button className="btn sm ghost" onClick={() => setHist(r)}>Histórico</button>
              </div>
            </div>
          ))}
        </div>
      ))}
      {tab === 'stock' && !groups.length && <div className="card empty">Nenhum produto com controle de estoque{q ? ` para “${q}”` : ''}.</div>}

      {tab === 'stock' && <div className="small muted">Venda com estoque divergente (vendeu sem estoque no sistema) aparece em <Link to="/admin/pendencias">Pendências</Link> para você conferir.</div>}
      {tab === 'comprar' && <SugestaoCompra />}
      {tab === 'hist' && <HistoricoGeral />}

      {op && <StockOpModal row={op.row} type={op.type} onClose={() => setOp(null)} />}
      {hist && <HistoryModal row={hist} onClose={() => setHist(null)} />}
      {minimo && <MinimoModal row={minimo} onClose={() => setMinimo(null)} />}
      {count && <CountModal rows={data.filter((r) => r.active)} onClose={() => setCount(false)} />}
    </div>
  );
}

const MOTIVOS = [['contagem', 'Contagem'], ['quebra', 'Quebra'], ['consumo_interno', 'Consumo interno'], ['outro', 'Outro']] as const;

function StockOpModal({ row, type, onClose }: { row: Row; type: 'ENTRADA' | 'AJUSTE'; onClose: () => void }) {
  const [qty, setQty] = useState('');
  const [custo, setCusto] = useState<number | null>(null);
  const [fornecedor, setFornecedor] = useState('');
  const [motivo, setMotivo] = useState<(typeof MOTIVOS)[number][0] | null>(null);
  const [obs, setObs] = useState('');
  const [perguntar, setPerguntar] = useState<{ atual: number | null; novo: number } | null>(null);
  const { busy, run } = useAction();
  const qc = useQueryClient();
  const n = qty === '' ? null : Number(qty);
  const ok = n != null && (type === 'ENTRADA' ? n >= 1 : n >= 0) && (type === 'ENTRADA' || (!!motivo && (motivo !== 'outro' || obs.trim().length >= 3)));
  const after = n == null ? null : type === 'ENTRADA' ? Math.max(0, row.stockQty) + n : n;
  const atualizar = () => { qc.invalidateQueries({ queryKey: ['stock'] }); qc.invalidateQueries({ queryKey: ['menu'] }); qc.invalidateQueries({ queryKey: ['pendencias'] }); };
  if (perguntar) return (
    <Modal title="Atualizar o custo do produto?" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Não, manter {perguntar.atual == null ? 'sem custo' : brl(perguntar.atual)}</button>
      <button className="btn primary" disabled={busy} onClick={async () => {
        if (await run(() => api.post(`/api/products/${row.id}/custo`, { costCents: perguntar.novo }), 'Custo atualizado.')) { atualizar(); onClose(); }
      }}>Sim, usar {brl(perguntar.novo)}</button>
    </>}>
      <div className="col gap-lg">
        <div>Esta compra saiu a <b>{brl(perguntar.novo)}</b> cada. O custo cadastrado de <b>{row.name}</b> é <b>{perguntar.atual == null ? 'nenhum' : brl(perguntar.atual)}</b>.</div>
        <div className="small muted">O novo custo vale para as próximas vendas. Vendas já feitas não mudam. O sistema nunca muda o custo sozinho.</div>
      </div>
    </Modal>
  );
  return (
    <Modal title={`${type === 'ENTRADA' ? 'Entrada de compra' : 'Ajustar estoque'} · ${row.name}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary" disabled={!ok || busy} onClick={async () => {
        let r: { custoDiferente: { atual: number | null; novo: number } | null } | undefined;
        const corpo = type === 'ENTRADA'
          ? { type, quantity: n, unitCostCents: custo, fornecedor: fornecedor.trim() || null }
          : { type, newQty: n, motivo, reason: obs.trim() || undefined };
        if (await run(async () => { r = await api.post(`/api/stock/${row.id}`, corpo); }, 'Estoque atualizado.')) {
          atualizar();
          if (r?.custoDiferente) setPerguntar(r.custoDiferente); else onClose();
        }
      }}>Salvar</button>
    </>}>
      <div className="col gap-lg">
        <div className="kv"><span>Estoque atual</span><span className="v">{row.stockQty}</span></div>
        <label className="field"><span>{type === 'ENTRADA' ? 'Quantas unidades chegaram?' : 'Quantas unidades existem agora?'}</span>
          <input className="input money" inputMode="numeric" autoFocus value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, '').slice(0, 6))} /></label>
        {after != null && <div className="kv total"><span>Fica</span><span className="v">{after}</span></div>}
        {type === 'ENTRADA' ? <>
          <div className="grid-2">
            <label className="field"><span>Custo de cada unidade (opcional)</span><MoneyInput value={custo} onChange={setCusto} /></label>
            <label className="field"><span>Fornecedor (opcional)</span><input className="input" value={fornecedor} onChange={(e) => setFornecedor(e.target.value)} maxLength={80} placeholder="Ex.: Atacadão" /></label>
          </div>
          {row.costCents != null && <div className="small faint">Custo cadastrado hoje: {brl(row.costCents)}</div>}
        </> : <>
          <div className="field"><span>Motivo *</span>
            <div className="seg wrap">{MOTIVOS.map(([v, l]) => <button key={v} className={motivo === v ? 'on' : ''} onClick={() => setMotivo(v)}>{l}</button>)}</div></div>
          <label className="field"><span>{motivo === 'outro' ? 'Explique o motivo *' : 'Observação (opcional)'}</span><input className="input" value={obs} onChange={(e) => setObs(e.target.value)} maxLength={200} placeholder="Ex.: 2 garrafas quebraram na entrega" /></label>
        </>}
      </div>
    </Modal>
  );
}

function MinimoModal({ row, onClose }: { row: Row; onClose: () => void }) {
  const [v, setV] = useState(String(row.lowStockAt ?? 3));
  const { busy, run } = useAction();
  const qc = useQueryClient();
  return (
    <Modal title={`Estoque mínimo · ${row.name}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary" disabled={busy || v === ''} onClick={async () => {
        if (await run(() => api.post(`/api/stock/${row.id}/minimo`, { lowStockAt: Number(v) }), 'Mínimo atualizado.')) { qc.invalidateQueries({ queryKey: ['stock'] }); onClose(); }
      }}>Salvar</button>
    </>}>
      <label className="field"><span>Avisar “acabando” quando tiver até</span>
        <input className="input money" inputMode="numeric" autoFocus value={v} onChange={(e) => setV(e.target.value.replace(/\D/g, '').slice(0, 6))} /></label>
    </Modal>
  );
}

/** Sugestão do que comprar: sempre com a conta aberta (média × dias − estoque), nunca opinião. */
function SugestaoCompra() {
  const { data, isLoading } = useQuery({ queryKey: ['stockSug'], queryFn: () => api.get<Sugestao>('/api/stock/sugestao') });
  if (isLoading || !data) return <Spinner />;
  if (!data.suficiente) return (
    <div className="card empty">Ainda sem dados suficientes: a sugestão aparece com pelo menos {data.diasMinimos ?? 14} dias de vendas (hoje: {data.diasDeDados}).</div>
  );
  const comprar = data.itens.filter((i) => i.comprar > 0);
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="small muted" style={{ padding: 12 }}>Conta: média de vendas por dia (últimos {data.janela} dias) × {data.diasCobertura} dias de estoque − o que você tem. Os {data.diasCobertura} dias mudam em Configurações → Estoque.</div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Produto</th><th className="right">Comprar</th><th>Conta</th></tr></thead>
          <tbody>
            {data.itens.map((i) => (
              <tr key={i.id} className={i.comprar ? '' : 'faint'}>
                <td><b>{i.name}</b></td>
                <td className="right num" style={{ fontWeight: 800 }}>{i.comprar || '—'}</td>
                <td className="small">{i.conta}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!comprar.length && <div className="empty small">Nada para comprar agora.</div>}
    </div>
  );
}

function HistoricoGeral() {
  const { data, isLoading } = useQuery({ queryKey: ['stockHist'], queryFn: () => api.get<HistLinha[]>('/api/stock/historico') });
  if (isLoading || !data) return <Spinner />;
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Quando</th><th>Produto</th><th>Tipo</th><th className="right">Qtd.</th><th className="right hide-mobile">Antes → depois</th><th>Quem / motivo</th></tr></thead>
          <tbody>
            {data.map((m) => (
              <tr key={m.id}>
                <td className="small">{dateTime(m.createdAt)}</td>
                <td>{m.productName}</td>
                <td>{MOVEMENT_LABEL[m.type] ?? m.type}</td>
                <td className="right num" style={{ color: m.quantity < 0 ? 'var(--danger)' : 'var(--ok)' }}>{m.quantity > 0 ? '+' : ''}{m.quantity}</td>
                <td className="right num hide-mobile">{m.before} → {m.after}</td>
                <td className="small">{m.userName ?? 'Sistema'}{m.reason ? ` · ${m.reason}` : ''}{m.unitCostCents != null ? ` · ${brl(m.unitCostCents)} cada` : ''}</td>
              </tr>
            ))}
            {!data.length && <tr><td colSpan={6} className="empty">Sem movimentações.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="small faint" style={{ padding: 12 }}>O histórico só acrescenta: nenhuma movimentação é apagada ou alterada.</div>
    </div>
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
