import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { time } from '../../format';
import type { StockDecision } from '../../types';
import { useToast } from '../../components/ui';
import { useSettings } from '../../components/layout';
import { useStockGuard } from '../../components/stock';
import OrderComposer, { linesToItems } from './OrderComposer';
import { useBoard } from './CashierLayout';
import { OpenDay } from './Board';
import { CustomerField } from './CustomerField';

type Created = { id: number; number: number; orderNumber: number | null; goesToKitchen: boolean; expectedReadyAt: string | null };

export default function NewAccount() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useBoard();
  const { data: settings } = useSettings();
  const [customerName, setName] = useState('');
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [tableLabel, setTable] = useState('');
  const [phone, setPhone] = useState('');
  const [more, setMore] = useState(false);
  const { guard, modal, busy } = useStockGuard();

  if (data && !data.register) return <OpenDay />;
  const closed = settings && !settings.restaurant.isOpen;

  const create = async (items: ReturnType<typeof linesToItems>, orderNote = '', consumptionType = 'LOCAL') => {
    const key = api.newKey();
    let attempt = 0;
    const r = await guard<Created>((stockDecisions?: StockDecision[]) =>
      api.post<Created>('/api/accounts', {
        customerName, customerId, note, tableLabel, phone, items, orderNote, consumptionType, stockDecisions,
      }, `${key}-${attempt++}`));
    if (!r) return false;
    qc.invalidateQueries({ queryKey: ['board'] }); qc.invalidateQueries({ queryKey: ['menu'] });
    toast(`Conta #${r.number} aberta${r.orderNumber ? ` · pedido #${r.orderNumber} ${r.goesToKitchen ? `na cozinha${r.expectedReadyAt ? ` (previsão ${time(r.expectedReadyAt)})` : ''}` : 'lançado'}` : ''}`, 'ok');
    nav('/caixa');
    return true;
  };

  return (
    <div className="col gap-lg">
      <div className="row between wrap">
        <div className="row">
          <Link to="/caixa" className="btn ghost">← Voltar</Link>
          <h1>Nova conta</h1>
        </div>
      </div>
      {closed && <div className="problem-box">Estabelecimento <b>FECHADO</b>: novos pedidos estão pausados. Reabra pelo botão ABERTO/FECHADO no topo.</div>}
      <OrderComposer
        busy={busy}
        submitLabel="Enviar pedido"
        onSubmit={(lines, orderNote, consumption) => create(linesToItems(lines), orderNote, consumption)}
        header={
          <div className="col" style={{ gap: 8 }}>
            <div className="new-acc-fields">
              <CustomerField value={customerName} onChange={(v) => { setName(v); setCustomerId(null); }} autoFocus
                onPick={(c) => { setCustomerId(c.id); if (c.phone) setPhone(c.phone); }} />
              <label className="field" style={{ width: 110 }}>
                <span>Mesa</span>
                <input className="input" value={tableLabel} onChange={(e) => setTable(e.target.value)} placeholder="Ex.: 7" maxLength={20} />
              </label>
              <label className="field grow">
                <span>Observação (onde está / como identificar)</span>
                <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: camisa azul, perto da piscina" maxLength={200} />
              </label>
            </div>
            <div className="row wrap" style={{ gap: 8 }}>
              {more
                ? <label className="field" style={{ width: 220 }}><span>Telefone</span><input className="input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(61) 9…" maxLength={30} /></label>
                : <button className="btn sm ghost" onClick={() => setMore(true)}>+ telefone</button>}
              <button className="btn sm ghost" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => create([])}>Abrir conta sem itens</button>
            </div>
          </div>
        }
      />
      {modal}
    </div>
  );
}
