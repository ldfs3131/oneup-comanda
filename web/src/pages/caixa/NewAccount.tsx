import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, chaveDoEnvio, type ChaveEnvio } from '../../api';
import { brl, time } from '../../format';
import type { StockDecision } from '../../types';
import { useToast } from '../../components/ui';
import { useSettings } from '../../components/layout';
import { useStockGuard } from '../../components/stock';
import OrderComposer, { linesToItems, type CartLine } from './OrderComposer';
import { useBoard } from './CashierLayout';
import { OpenDay } from './Board';
import { CustomerField } from './CustomerField';

type Created = { id: number; number: number; orderNumber: number | null; goesToKitchen: boolean; expectedReadyAt: string | null };

/** "Mesa 12", "mesa 012" e "12" são a mesma mesa. */
const normMesa = (t: string | null | undefined) =>
  (t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\bmesa\b/g, '').replace(/[^a-z0-9]/g, '').replace(/^0+(?=\d)/, '');

export default function NewAccount() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useBoard();
  const { data: settings } = useSettings();
  const cfg = settings?.config ?? {};
  const [customerName, setName] = useState('');
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [tableLabel, setTable] = useState('');
  const [phone, setPhone] = useState('');
  const [more, setMore] = useState(false);
  const { guard, modal, busy } = useStockGuard();
  const envio: ChaveEnvio = useRef(null);
  const linhas = useRef<CartLine[]>([]);
  const [outraMesmoAssim, setOutraMesmoAssim] = useState('');

  if (data && !data.register) return <OpenDay />;
  const closed = settings && !settings.restaurant.isOpen;

  // Toda conta precisa ser identificável: pelo menos um entre nome, telefone, mesa ou observação (2+ letras/números)
  const real = (t: string, min: number) => t.replace(/[^\p{L}\p{N}]/gu, '').length >= min;
  const identificado = !!customerId || real(tableLabel, 1) || real(phone, 1) || real(customerName, 2) || real(note, 2);
  // Mesa que já tem conta aberta (dados do painel do caixa): oferece adicionar nela em vez de abrir outra
  const mesaDigitada = normMesa(tableLabel);
  const jaAberta = mesaDigitada && outraMesmoAssim !== mesaDigitada
    ? (data?.accounts ?? []).filter((a) => ['OPEN', 'PARTIALLY_PAID', 'PAID'].includes(a.status) && normMesa(a.tableLabel) === mesaDigitada)
    : [];
  const adicionarNela = (id: number) => nav(`/caixa/conta/${id}`, { state: linhas.current.length ? { adicionar: linhas.current } : null });
  const create = async (items: ReturnType<typeof linesToItems>, orderNote = '', consumptionType = 'LOCAL') => {
    if (!identificado) { toast('Preencha pelo menos um: nome, telefone, mesa ou observação.', 'danger'); return false; }
    if (jaAberta.length) { toast(`${cfg.rotulo_mesa ?? 'Mesa'} ${tableLabel.trim()} já tem conta aberta: toque em “Adicionar nela” ou “Abrir outra mesmo assim”.`, 'danger'); return false; }
    const r = await guard<Created>((stockDecisions?: StockDecision[]) => {
      const corpo = { customerName, customerId, note, tableLabel, phone, items, orderNote, consumptionType, stockDecisions };
      return api.post<Created>('/api/accounts', corpo, chaveDoEnvio(envio, corpo));
    });
    if (!r) return false;
    envio.current = null;
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
        onLinesChange={(l) => { linhas.current = l; }}
        onSubmit={(lines, orderNote, consumption) => create(linesToItems(lines), orderNote, consumption)}
        header={
          <div className="col" style={{ gap: 8 }}>
            <div className="new-acc-fields">
              <CustomerField value={customerName} label={cfg.exigir_nome ? 'Cliente *' : 'Cliente'} onChange={(v) => { setName(v); setCustomerId(null); }} autoFocus
                onPick={(c) => { setCustomerId(c.id); if (c.phone) setPhone(c.phone); }} />
              <label className="field" style={{ width: 120 }}>
                <span>{cfg.rotulo_mesa ?? 'Mesa'}{cfg.exigir_mesa ? ' *' : ''}</span>
                <input className="input" value={tableLabel} onChange={(e) => setTable(e.target.value)} placeholder="Ex.: 7" maxLength={20} />
              </label>
              <label className="field grow">
                <span>Observação (onde está / como identificar)</span>
                <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: camisa azul, perto da piscina" maxLength={200} />
              </label>
            </div>
            {jaAberta.map((a) => (
              <div key={a.id} className="cx-mesa-aberta" role="alert">
                <span className="grow">
                  <b>{cfg.rotulo_mesa ?? 'Mesa'} {tableLabel.trim()}</b> já tem a <b>conta #{a.number}</b> ({brl(a.total)}{a.customerName ? ` · ${a.customerName}` : ''})
                </span>
                <button className="btn primary" onClick={() => adicionarNela(a.id)}>Adicionar nela</button>
                <button className="btn" onClick={() => setOutraMesmoAssim(mesaDigitada)}>Abrir outra mesmo assim</button>
              </div>
            ))}
            {!identificado && <div className="small muted">Para abrir, preencha <b>pelo menos um</b>: nome, telefone, {String(cfg.rotulo_mesa ?? 'mesa').toLowerCase()} ou observação.</div>}
            <div className="row wrap" style={{ gap: 8 }}>
              {more || cfg.exigir_telefone
                ? <label className="field" style={{ width: 220 }}><span>Telefone{cfg.exigir_telefone ? ' *' : ''}</span><input className="input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(61) 9…" maxLength={30} /></label>
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
