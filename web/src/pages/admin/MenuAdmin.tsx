import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { brl, centsToInput } from '../../format';
import type { Category, Product } from '../../types';
import { Badge, Modal, MoneyInput, Spinner, Toggle, useAction } from '../../components/ui';
import { ImportarPlanilha } from '../../components/importar';

type GroupDraft = { id?: number; name: string; required: boolean; multiple: boolean; options: { id?: number; name: string; priceDeltaCents: number | null; available: boolean; stockProductId: number | null }[] };

export default function MenuAdmin() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['menu', 'all'], queryFn: () => api.get<Category[]>('/api/menu?all=1') });
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [newCatFor, setNewCatFor] = useState<number | null>(null);
  const [catModal, setCatModal] = useState<Category | 'new' | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [importar, setImportar] = useState(false);
  const { run } = useAction();
  const refresh = () => { qc.invalidateQueries({ queryKey: ['menu'] }); };
  const act = async (fn: () => Promise<unknown>, msg?: string) => { if (await run(fn, msg)) refresh(); };

  if (isLoading || !data) return <Spinner />;

  return (
    <div className="col gap-lg">
      <div className="row between wrap">
        <div>
          <h1>Cardápio</h1>
          <div className="muted small">Alterar preço não muda vendas já feitas. Produtos nunca são apagados: desative-os.</div>
        </div>
        <div className="row wrap">
          <label className="check small"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />Mostrar desativados</label>
          <button className="btn" onClick={() => setImportar(true)}>⇪ Importar planilha</button>
          <button className="btn" onClick={() => setCatModal('new')}>＋ Categoria</button>
          <button className="btn primary" onClick={() => { setNewCatFor(data[0]?.id ?? null); setEditing('new'); }}>＋ Produto</button>
        </div>
      </div>

      {data.filter((c) => showInactive || c.active).map((c, ci, arr) => (
        <div key={c.id} className={`card${c.active ? '' : ' inactive'}`}>
          <div className="row between wrap" style={{ marginBottom: 8 }}>
            <div className="row">
              <h2>{c.name}</h2>
              {!c.sendsToKitchen && <Badge tone="info">não vai à cozinha</Badge>}
              {!c.active && <Badge>desativada</Badge>}
            </div>
            <div className="row">
              <button className="btn sm ghost" disabled={ci === 0} onClick={() => act(() => api.patch(`/api/categories/${c.id}`, { move: 'up' }))}>↑</button>
              <button className="btn sm ghost" disabled={ci === arr.length - 1} onClick={() => act(() => api.patch(`/api/categories/${c.id}`, { move: 'down' }))}>↓</button>
              <button className="btn sm" onClick={() => setCatModal(c)}>Editar</button>
              {!c.products.length && <button className="btn sm danger" onClick={() => act(() => api.del(`/api/categories/${c.id}`), 'Categoria excluída.')}>Excluir</button>}
              <button className="btn sm" onClick={() => { setNewCatFor(c.id); setEditing('new'); }}>＋ Produto</button>
            </div>
          </div>
          {!c.products.length && <div className="muted small">Nenhum produto. {c.name === 'Bebidas' && 'Cadastre as bebidas e o chope com os preços corretos.'}</div>}
          {c.products.filter((p) => showInactive || p.active).map((p, pi, parr) => (
            <div key={p.id} className={`menu-row${p.active ? '' : ' inactive'}`}>
              {p.imageUrl ? <img className="menu-thumb" src={p.imageUrl} alt="" /> : <div className="menu-thumb empty-thumb">🍽</div>}
              <div className="grow">
                <div className="row wrap" style={{ gap: 6 }}>
                  <b className={p.available ? '' : 'strike'}>{p.name}</b>
                  {!p.active && <Badge>desativado</Badge>}
                  {p.needsReview && <Badge tone="warn">revisar</Badge>}
                  {!p.sendsToKitchen && <Badge tone="info">balcão</Badge>}
                  {p.groups.length > 0 && <Badge>{p.groups.map((g) => g.name).join(', ')}</Badge>}
                  {p.trackStock && <Badge tone={p.stockQty <= 0 ? 'danger' : p.stockQty <= (p.lowStockAt ?? 3) ? 'warn' : 'ok'}>estoque {p.stockQty}</Badge>}
                  {p.active && p.costCents == null && <Badge tone="warn">sem custo</Badge>}
                  {p.sendsToKitchen && p.prepMinutes != null && <span className="small faint">⏱ {p.prepMinutes} min</span>}
                </div>
                {p.description && <div className="small muted ellipsis">{p.description}</div>}
              </div>
              <div className="num right" style={{ minWidth: 100 }}>
                <div style={{ fontWeight: 800 }}>{brl(p.priceCents)}</div>
                {p.costCents != null && <div className="small faint">custo {brl(p.costCents)} · {p.priceCents ? Math.round(((p.priceCents - p.costCents) / p.priceCents) * 100) : 0}%</div>}
              </div>
              <div className="col center hide-mobile" style={{ gap: 2, alignItems: 'center' }}>
                <Toggle on={p.available} label="Disponível" onChange={(v) => act(() => api.patch(`/api/products/${p.id}/availability`, { available: v }))} />
                <span className="small faint">{p.available ? 'tem' : 'acabou'}</span>
              </div>
              <div className="row" style={{ gap: 2 }}>
                <button className="btn sm ghost icon" disabled={pi === 0} onClick={() => act(() => api.post(`/api/products/${p.id}/move`, { direction: 'up' }))}>↑</button>
                <button className="btn sm ghost icon" disabled={pi === parr.length - 1} onClick={() => act(() => api.post(`/api/products/${p.id}/move`, { direction: 'down' }))}>↓</button>
                <button className="btn sm" onClick={() => setEditing(p)}>Editar</button>
              </div>
            </div>
          ))}
        </div>
      ))}

      {importar && <ImportarPlanilha onClose={() => setImportar(false)} />}
      {editing && <ProductModal product={editing === 'new' ? null : editing} categories={data} defaultCategoryId={newCatFor}
        onClose={() => setEditing(null)} onSaved={refresh} />}
      {catModal && <CategoryModal category={catModal === 'new' ? null : catModal} onClose={() => setCatModal(null)} onSaved={refresh} />}
    </div>
  );
}

function CategoryModal({ category, onClose, onSaved }: { category: Category | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(category?.name ?? '');
  const [kitchen, setKitchen] = useState(category?.sendsToKitchen ?? true);
  const [active, setActive] = useState(category?.active ?? true);
  const { busy, run } = useAction();
  return (
    <Modal title={category ? `Categoria · ${category.name}` : 'Nova categoria'} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary" disabled={busy || name.trim().length < 2} onClick={async () => {
        const ok = await run(() => category
          ? api.patch(`/api/categories/${category.id}`, { name: name.trim(), sendsToKitchen: kitchen, active })
          : api.post('/api/categories', { name: name.trim(), sendsToKitchen: kitchen }), 'Categoria salva.');
        if (ok) { onSaved(); onClose(); }
      }}>Salvar</button>
    </>}>
      <div className="col gap-lg">
        <label className="field"><span>Nome</span><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={kitchen} onChange={(e) => setKitchen(e.target.checked)} />Produtos novos desta categoria vão para a cozinha</label>
        {category && <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />Categoria ativa</label>}
      </div>
    </Modal>
  );
}

function ProductModal({ product, categories, defaultCategoryId, onClose, onSaved }: {
  product: Product | null; categories: Category[]; defaultCategoryId: number | null; onClose: () => void; onSaved: () => void;
}) {
  const initialCat = product?.categoryId ?? defaultCategoryId ?? categories[0]?.id;
  const [name, setName] = useState(product?.name ?? '');
  const [categoryId, setCategoryId] = useState<number>(initialCat);
  const [price, setPrice] = useState<number | null>(product?.priceCents ?? null);
  const [description, setDescription] = useState(product?.description ?? '');
  const [kitchen, setKitchen] = useState(product?.sendsToKitchen ?? categories.find((c) => c.id === initialCat)?.sendsToKitchen ?? true);
  const [available, setAvailable] = useState(product?.available ?? true);
  const [active, setActive] = useState(product?.active ?? true);
  const [needsReview, setNeedsReview] = useState(product?.needsReview ?? false);
  const [cost, setCost] = useState<number | null>(product?.costCents ?? null);
  const [applyPast, setApplyPast] = useState(false);
  const [trackStock, setTrackStock] = useState(product?.trackStock ?? false);
  const [lowStockAt, setLowStockAt] = useState(String(product?.lowStockAt ?? 3));
  const [prep, setPrep] = useState(String(product?.prepMinutes ?? 15));
  const stockProducts = categories.flatMap((c) => c.products).filter((x) => x.trackStock && x.id !== product?.id);
  const [groups, setGroups] = useState<GroupDraft[]>(product?.groups.map((g) => ({
    id: g.id, name: g.name, required: g.required, multiple: g.multiple,
    options: g.options.map((o) => ({ id: o.id, name: o.name, priceDeltaCents: o.priceDeltaCents, available: o.available, stockProductId: o.stockProductId ?? null })),
  })) ?? []);
  const [file, setFile] = useState<File | null>(null);
  const { busy, run } = useAction();

  const prepN = Number(prep), lowN = Number(lowStockAt);
  const valid = name.trim().length >= 2 && price != null && (!active || price > 0) && prepN >= 1 && prepN <= 240 && lowN >= 0 && groups.every((g) => g.name.trim() && g.options.length && g.options.every((o) => o.name.trim() && o.priceDeltaCents != null));
  const upd = (i: number, g: Partial<GroupDraft>) => setGroups((gs) => gs.map((x, j) => (j === i ? { ...x, ...g } : x)));

  const save = async () => {
    const body = {
      categoryId, name: name.trim(), description: description.trim(), priceCents: price, sendsToKitchen: kitchen,
      available, active, needsReview, reviewNote: product?.reviewNote ?? null,
      costCents: cost, applyCostToPast: applyPast, trackStock, lowStockAt: lowN, prepMinutes: prepN,
      groups: groups.map((g) => ({ id: g.id, name: g.name.trim(), required: g.required, multiple: g.multiple, options: g.options.map((o) => ({ id: o.id, name: o.name.trim(), priceDeltaCents: o.priceDeltaCents ?? 0, available: o.available, stockProductId: o.stockProductId })) })),
    };
    const ok = await run(async () => {
      const saved = product ? (await api.put(`/api/products/${product.id}`, body), { id: product.id }) : await api.post<{ id: number }>('/api/products', body);
      if (file) {
        const fd = new FormData(); fd.append('file', file);
        await api.upload(`/api/products/${saved.id}/image`, fd);
      }
    }, 'Produto salvo.');
    if (ok) { onSaved(); onClose(); }
  };

  return (
    <Modal wide title={product ? `Editar · ${product.name}` : 'Novo produto'} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary lg" disabled={!valid || busy} onClick={save}>Salvar</button>
    </>}>
      <div className="col gap-lg">
        <div className="grid-2">
          <label className="field"><span>Nome</span><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field"><span>Categoria</span>
            <select className="input" value={categoryId} onChange={(e) => {
              const id = Number(e.target.value); setCategoryId(id);
              if (!product) setKitchen(categories.find((c) => c.id === id)?.sendsToKitchen ?? true);
            }}>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="field"><span>Preço</span><MoneyInput value={price} onChange={setPrice} /></label>
          <label className="field"><span>Foto (JPG/PNG, até 5 MB)</span>
            <div className="row">
              {(file || product?.imageUrl) && <img className="menu-thumb" src={file ? URL.createObjectURL(file) : product!.imageUrl!} alt="" />}
              <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </div>
          </label>
        </div>
        <label className="field"><span>Descrição</span><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} placeholder="Opcional" /></label>
        <div className="grid-3">
          <label className="field"><span>Custo unitário (para o financeiro)</span><MoneyInput value={cost} onChange={setCost} placeholder="não informado" /></label>
          <label className="field"><span>Tempo padrão de preparo (min)</span><input className="input" inputMode="numeric" value={prep} onChange={(e) => setPrep(e.target.value.replace(/\D/g, '').slice(0, 3))} /></label>
          <div className="field"><span>Margem</span><div className="input" style={{ display: 'flex', alignItems: 'center' }}>{price && cost != null ? `${brl(price - cost)} (${Math.round(((price - cost) / price) * 100)}%)` : '—'}</div></div>
        </div>
        {cost != null && cost !== (product?.costCents ?? null) && (
          <label className="check small"><input type="checkbox" checked={applyPast} onChange={(e) => setApplyPast(e.target.checked)} />Usar este custo também nas vendas antigas que estão sem custo (vendas com custo já registrado não mudam)</label>
        )}
        <div className="card tight row wrap" style={{ background: 'var(--surface-2)', gap: 16 }}>
          <label className="check"><input type="checkbox" checked={trackStock} onChange={(e) => setTrackStock(e.target.checked)} />Controlar estoque (por unidade)</label>
          {trackStock && <label className="row small">Avisar quando tiver <input className="input" style={{ width: 80 }} inputMode="numeric" value={lowStockAt} onChange={(e) => setLowStockAt(e.target.value.replace(/\D/g, '').slice(0, 5))} /> ou menos</label>}
          {trackStock && product && <span className="small muted">Atual: {product.stockQty} — compras, ajustes e contagens em Estoque.</span>}
        </div>
        <div className="row wrap" style={{ gap: 20 }}>
          <label className="check"><input type="checkbox" checked={kitchen} onChange={(e) => setKitchen(e.target.checked)} />Vai para a cozinha</label>
          <label className="check"><input type="checkbox" checked={available} onChange={(e) => setAvailable(e.target.checked)} />Disponível (tem)</label>
          <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />Ativo no cardápio</label>
          <label className="check"><input type="checkbox" checked={needsReview} onChange={(e) => setNeedsReview(e.target.checked)} />Marcar para revisar</label>
        </div>

        <div className="divider" />
        <div className="row between">
          <div>
            <b>Opções do produto</b>
            <div className="small muted">Ex.: “Acompanhamento: com farofa +R$ 5,00” ou “Espeto (obrigatório): escolha o sabor”.</div>
          </div>
          <button className="btn sm" onClick={() => setGroups([...groups, { name: '', required: false, multiple: false, options: [{ name: '', priceDeltaCents: 0, available: true, stockProductId: null }] }])}>＋ Grupo de opções</button>
        </div>
        {groups.map((g, gi) => (
          <div key={gi} className="card tight col" style={{ background: 'var(--surface-2)' }}>
            <div className="row wrap">
              <input className="input grow" placeholder="Nome do grupo (ex.: Acompanhamento)" value={g.name} onChange={(e) => upd(gi, { name: e.target.value })} />
              <label className="check small"><input type="checkbox" checked={g.required} onChange={(e) => upd(gi, { required: e.target.checked })} />Obrigatório</label>
              <label className="check small"><input type="checkbox" checked={g.multiple} onChange={(e) => upd(gi, { multiple: e.target.checked })} />Várias escolhas</label>
              <button className="btn sm danger" onClick={() => setGroups(groups.filter((_, j) => j !== gi))}>Remover grupo</button>
            </div>
            {g.options.map((o, oi) => (
              <div key={oi} className="row">
                <input className="input grow" placeholder="Opção" value={o.name} onChange={(e) => upd(gi, { options: g.options.map((x, k) => (k === oi ? { ...x, name: e.target.value } : x)) })} />
                <div style={{ width: 160 }}><MoneyInput value={o.priceDeltaCents} placeholder="+ 0,00" onChange={(v) => upd(gi, { options: g.options.map((x, k) => (k === oi ? { ...x, priceDeltaCents: v } : x)) })} /></div>
                <select className="input" style={{ width: 170 }} title="Baixa 1 unidade deste produto do estoque" value={o.stockProductId ?? ''} onChange={(e) => upd(gi, { options: g.options.map((x, k) => (k === oi ? { ...x, stockProductId: Number(e.target.value) || null } : x)) })}>
                  <option value="">sem baixa de estoque</option>
                  {stockProducts.map((sp) => <option key={sp.id} value={sp.id}>baixa: {sp.name}</option>)}
                </select>
                <button className="btn sm ghost icon" title="Remover opção" disabled={g.options.length === 1} onClick={() => upd(gi, { options: g.options.filter((_, k) => k !== oi) })}>✕</button>
              </div>
            ))}
            <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => upd(gi, { options: [...g.options, { name: '', priceDeltaCents: 0, available: true, stockProductId: null }] })}>＋ Opção</button>
          </div>
        ))}
        {product && price != null && price !== product.priceCents && (
          <div className="problem-box" style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }}>
            Preço muda de {brl(product.priceCents)} para R$ {centsToInput(price)}. Vendas anteriores continuam com o preço antigo.
          </div>
        )}
      </div>
    </Modal>
  );
}
