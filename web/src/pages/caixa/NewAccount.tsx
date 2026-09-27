import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { useAction } from '../../components/ui';
import OrderComposer, { linesToItems } from './OrderComposer';
import { useBoard } from './CashierLayout';
import { OpenRegister } from './Board';

export default function NewAccount() {
  const nav = useNavigate();
  const { data } = useBoard();
  const [customerName, setName] = useState('');
  const [note, setNote] = useState('');
  const { busy, run } = useAction();

  if (data && !data.register) return <OpenRegister />;

  const create = async (items: ReturnType<typeof linesToItems>, orderNote = '') => {
    let res: { id: number; number: number; orderNumber: number | null } | null = null;
    const ok = await run(async () => {
      res = await api.post('/api/accounts', { customerName, note, items, orderNote });
    });
    if (ok && res) {
      const r = res as { id: number; number: number; orderNumber: number | null };
      nav('/caixa', { state: { flash: `Conta #${r.number} aberta${r.orderNumber ? ` · pedido #${r.orderNumber} enviado` : ''}` } });
    }
    return ok;
  };

  return (
    <div className="col gap-lg">
      <div className="row between wrap">
        <div className="row">
          <Link to="/caixa" className="btn ghost">← Voltar</Link>
          <h1>Nova conta</h1>
        </div>
      </div>
      <OrderComposer
        busy={busy}
        submitLabel="Enviar pedido"
        onSubmit={(lines, orderNote) => create(linesToItems(lines), orderNote)}
        header={
          <div className="new-acc-fields">
            <label className="field grow">
              <span>Cliente (opcional)</span>
              <input className="input" value={customerName} onChange={(e) => setName(e.target.value)} placeholder="Ex.: João" maxLength={80} autoFocus />
            </label>
            <label className="field grow">
              <span>Observação (opcional)</span>
              <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: camisa azul, perto da piscina" maxLength={200} />
            </label>
            <button className="btn sm ghost" style={{ alignSelf: 'flex-end' }} disabled={busy} onClick={() => create([])}>Abrir sem itens</button>
          </div>
        }
      />
    </div>
  );
}
