import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { brl, dateTime } from '../../format';
import type { Category } from '../../types';
import { Badge, Modal, MoneyInput, Spinner, useAction } from '../../components/ui';

type Avulso = { chave: string; nome: string; vezes: number; unidades: number; precoSugeridoCents: number; cozinha: boolean; ultima: string };
type Divergencia = { id: number; productName: string; missing: number; reason: string | null; createdAt: string; userName: string | null };
type SemCusto = { id: number; name: string; priceCents: number; categoryName: string; vendidos30: number };
export type Pend = { avulsos: Avulso[]; divergencias: Divergencia[]; semCusto: SemCusto[]; total: number };

export function usePendencias() {
  return useQuery({ queryKey: ['pendencias'], queryFn: () => api.get<Pend>('/api/pendencias'), refetchInterval: 120_000 });
}

/** Pendências: três listas que se resolvem e somem. Nada aqui trava a operação. */
export default function Pendencias() {
  const { data, isLoading } = usePendencias();
  const [virar, setVirar] = useState<Avulso | null>(null);
  const { busy, run } = useAction();
  const qc = useQueryClient();
  const resolver = (tipo: 'avulso' | 'divergencia', chave: string, acao: string, msg: string) =>
    run(async () => { await api.post('/api/pendencias/resolver', { tipo, chave, acao }); qc.invalidateQueries({ queryKey: ['pendencias'] }); }, msg);
  if (isLoading || !data) return <Spinner />;
  return (
    <div className="col gap-lg">
      <div>
        <h1>Pendências</h1>
        <div className="muted small">Coisas para conferir quando tiver um tempo. Cada item some quando é resolvido.</div>
      </div>
      {data.total === 0 && <div className="card empty">Nenhuma pendência. Tudo em dia. ✔</div>}

      {data.semCusto.length > 0 && (
        <div className="card">
          <div className="panel-title">Produtos sem custo ({data.semCusto.length})</div>
          <div className="small muted" style={{ marginBottom: 8 }}>Sem custo, o lucro do Financeiro pode aparecer maior que o real. Preencha o quanto cada um custa para você.</div>
          {data.semCusto.map((p) => <SemCustoLinha key={p.id} p={p} />)}
        </div>
      )}

      {data.avulsos.length > 0 && (
        <div className="card">
          <div className="panel-title">Avulsos repetidos ({data.avulsos.length})</div>
          <div className="small muted" style={{ marginBottom: 8 }}>Vendidos pelo “＋ Outro” mais de uma vez com o mesmo nome. Vire produto para aparecer no cardápio e no estoque.</div>
          {data.avulsos.map((a) => (
            <div key={a.chave} className="kv wrap">
              <span><b>{a.nome}</b> <span className="small faint">· {a.vezes} vendas · {a.unidades} un. · preço mais usado {brl(a.precoSugeridoCents)}</span></span>
              <span className="row" style={{ gap: 6 }}>
                <button className="btn sm primary" disabled={busy} onClick={() => setVirar(a)}>Virar produto</button>
                <button className="btn sm ghost" disabled={busy} onClick={() => resolver('avulso', a.nome, 'ignorado', 'Ignorado.')}>Ignorar</button>
              </span>
            </div>
          ))}
        </div>
      )}

      {data.divergencias.length > 0 && (
        <div className="card">
          <div className="panel-title">Vendas com estoque divergente ({data.divergencias.length})</div>
          <div className="small muted" style={{ marginBottom: 8 }}>Vendeu, mas o sistema achava que não tinha. Normalmente é entrada de compra não lançada ou contagem errada. Confira e, se precisar, ajuste em <Link to="/admin/estoque">Estoque</Link>.</div>
          {data.divergencias.map((d) => (
            <div key={d.id} className="kv wrap">
              <span><b>{d.productName}</b> <span className="small faint">· faltaram {d.missing} · {dateTime(d.createdAt)} · {d.userName ?? '—'}{d.reason ? ` · ${d.reason}` : ''}</span></span>
              <span className="row" style={{ gap: 6 }}><Badge tone="danger">−{d.missing}</Badge>
                <button className="btn sm" disabled={busy} onClick={() => resolver('divergencia', String(d.id), 'conferido', 'Conferido.')}>Conferido</button></span>
            </div>
          ))}
        </div>
      )}
      {virar && <VirarProduto a={virar} onClose={() => setVirar(null)} onDone={() => resolver('avulso', virar.nome, 'virou_produto', 'Produto criado.')} />}
    </div>
  );
}

function SemCustoLinha({ p }: { p: SemCusto }) {
  const [custo, setCusto] = useState<number | null>(null);
  const [passado, setPassado] = useState(true);
  const { busy, run } = useAction();
  const qc = useQueryClient();
  return (
    <div className="kv wrap" style={{ gap: 8 }}>
      <span><b>{p.name}</b> <span className="small faint">· {p.categoryName} · preço {brl(p.priceCents)}{p.vendidos30 ? ` · ${p.vendidos30} vendidos em 30 dias` : ''}</span></span>
      <span className="row wrap" style={{ gap: 6 }}>
        <span style={{ width: 120 }}><MoneyInput value={custo} onChange={setCusto} placeholder="custo" /></span>
        {p.vendidos30 > 0 && <label className="check small" title="Usa este custo nas vendas que ficaram sem custo"><input type="checkbox" checked={passado} onChange={(e) => setPassado(e.target.checked)} />vendas anteriores</label>}
        <button className="btn sm primary" disabled={busy || custo == null} onClick={() => run(async () => {
          await api.post(`/api/products/${p.id}/custo`, { costCents: custo, applyCostToPast: passado && p.vendidos30 > 0 });
          qc.invalidateQueries({ queryKey: ['pendencias'] }); qc.invalidateQueries({ queryKey: ['finance'] });
        }, 'Custo salvo.')}>Salvar</button>
      </span>
    </div>
  );
}

function VirarProduto({ a, onClose, onDone }: { a: Avulso; onClose: () => void; onDone: () => Promise<boolean> }) {
  const { data: cats = [] } = useQuery({ queryKey: ['menu', 'all'], queryFn: () => api.get<Category[]>('/api/menu?all=1') });
  const [nome, setNome] = useState(a.nome);
  const [preco, setPreco] = useState<number | null>(a.precoSugeridoCents);
  const [custo, setCusto] = useState<number | null>(null);
  const [cat, setCat] = useState<number | null>(null);
  const [cozinha, setCozinha] = useState(a.cozinha);
  const { busy, run } = useAction();
  const qc = useQueryClient();
  const ok = nome.trim().length >= 2 && preco != null && !!cat;
  return (
    <Modal title="Virar produto" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary" disabled={!ok || busy} onClick={async () => {
        if (await run(() => api.post('/api/products', { categoryId: cat, name: nome.trim(), priceCents: preco, costCents: custo, sendsToKitchen: cozinha, groups: [] }))) {
          qc.invalidateQueries({ queryKey: ['menu'] }); await onDone(); onClose();
        }
      }}>Criar produto</button>
    </>}>
      <div className="col gap-lg">
        <label className="field"><span>Nome</span><input className="input" value={nome} onChange={(e) => setNome(e.target.value)} maxLength={80} /></label>
        <label className="field"><span>Categoria</span>
          <select className="input" value={cat ?? ''} onChange={(e) => setCat(Number(e.target.value) || null)}>
            <option value="">Escolha…</option>
            {cats.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></label>
        <div className="grid-2">
          <label className="field"><span>Preço</span><MoneyInput value={preco} onChange={setPreco} /></label>
          <label className="field"><span>Custo (opcional)</span><MoneyInput value={custo} onChange={setCusto} /></label>
        </div>
        <label className="check"><input type="checkbox" checked={cozinha} onChange={(e) => setCozinha(e.target.checked)} />Vai para a cozinha</label>
      </div>
    </Modal>
  );
}
