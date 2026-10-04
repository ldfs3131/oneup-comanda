import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { brl, dateTime } from '../../format';
import type { AccountDetail } from '../../types';
import { Modal } from '../../components/ui';
import { useSettings } from '../../components/layout';
import { useMesaLabel } from '../../components/brand';

type Linha = { qtd: number; nome: string; detalhe: string; cents: number };

/** Itens da conta somados (mesmo produto, mesmas opções e observação viram uma linha). Pedido do QR ainda não confirmado fica fora. */
function linhasDaConta(acc: AccountDetail): Linha[] {
  const mapa = new Map<string, Linha>();
  for (const o of acc.orders) {
    if (o.status === 'CANCELLED' || o.status === 'AWAITING_CONFIRMATION') continue;
    for (const i of o.items) {
      if (i.status !== 'ACTIVE') continue;
      const detalhe = [i.optionsSnapshot.map((x) => x.name).join(', '), i.note ? `"${i.note}"` : ''].filter(Boolean).join(' · ');
      const k = `${i.productName}|${detalhe}|${i.unitPriceCents}`;
      const l = mapa.get(k);
      if (l) { l.qtd += i.quantity; l.cents += i.unitPriceCents * i.quantity; }
      else mapa.set(k, { qtd: i.quantity, nome: i.productName, detalhe, cents: i.unitPriceCents * i.quantity });
    }
  }
  return [...mapa.values()];
}

/** Texto da pré-conta (WhatsApp). Sem dados internos: só o que o cliente vê no cupom. */
export function textoPreConta(acc: AccountDetail, restaurante: string, mesa: string) {
  const t = acc.totals;
  const linhas = linhasDaConta(acc).map((l) => `${l.qtd}× ${l.nome}${l.detalhe ? ` (${l.detalhe})` : ''} — ${brl(l.cents)}`);
  return [
    `*${restaurante}*`,
    `Pré-conta · Conta #${acc.number}${acc.tableLabel ? ` · ${mesa} ${acc.tableLabel}` : ''}${acc.customerName ? ` · ${acc.customerName}` : ''}`,
    '',
    ...linhas,
    '',
    `Subtotal: ${brl(t.subtotal)}`,
    ...(t.discounts > 0 ? [`Descontos: −${brl(t.discounts)}`] : []),
    `*Total: ${brl(t.total)}*`,
    ...(t.paid > 0 ? [`Pago: ${brl(t.paid)}`] : []),
    `*Falta pagar: ${brl(t.balance)}*`,
    '',
    'Não é documento fiscal.',
  ].join('\n');
}

/** Telefone para o wa.me: só números, com 55 quando vier no formato brasileiro (DDD + número). */
export function foneWhatsApp(phone: string | null | undefined) {
  const d = (phone ?? '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) return `55${d}`;
  if (d.length >= 12 && d.length <= 13) return d;
  return '';
}

function Cupom({ acc, restaurante, mesa }: { acc: AccountDetail; restaurante: string; mesa: string }) {
  const t = acc.totals;
  const linhas = linhasDaConta(acc);
  return (
    <div className="cx-cupom">
      <div className="cx-cupom-centro"><b className="cx-cupom-nome">{restaurante}</b></div>
      <div className="cx-cupom-centro">PRÉ-CONTA</div>
      <div className="cx-cupom-sep" />
      <div>Conta #{acc.number}{acc.tableLabel ? ` · ${mesa} ${acc.tableLabel}` : ''}</div>
      {acc.customerName && <div>Cliente: {acc.customerName}</div>}
      <div>{dateTime(new Date())}</div>
      <div className="cx-cupom-sep" />
      {!linhas.length && <div>Nenhum item.</div>}
      {linhas.map((l, i) => (
        <div key={i} className="cx-cupom-item">
          <div className="cx-cupom-linha"><span>{l.qtd}× {l.nome}</span><span className="num">{brl(l.cents)}</span></div>
          {l.detalhe && <div className="cx-cupom-det">{l.detalhe}</div>}
        </div>
      ))}
      <div className="cx-cupom-sep" />
      <div className="cx-cupom-linha"><span>Subtotal</span><span className="num">{brl(t.subtotal)}</span></div>
      {acc.discounts.map((d) => (
        <div key={d.id} className="cx-cupom-linha"><span>{d.kind === 'DISCOUNT' ? 'Desconto' : 'Ajuste'}</span><span className="num">−{brl(d.amountCents)}</span></div>
      ))}
      <div className="cx-cupom-linha cx-cupom-forte"><span>TOTAL</span><span className="num">{brl(t.total)}</span></div>
      {t.paid > 0 && <div className="cx-cupom-linha"><span>Pago</span><span className="num">{brl(t.paid)}</span></div>}
      <div className="cx-cupom-linha cx-cupom-forte"><span>FALTA PAGAR</span><span className="num">{brl(t.balance)}</span></div>
      <div className="cx-cupom-sep" />
      <div className="cx-cupom-centro cx-cupom-det">Não é documento fiscal</div>
    </div>
  );
}

/** "Pré-conta": a conta no formato cupom, para imprimir (bobina de 80 mm) ou mandar no WhatsApp. */
export function PreContaModal({ account, onClose }: { account: AccountDetail; onClose: () => void }) {
  const { data: settings } = useSettings();
  const mesa = useMesaLabel();
  const restaurante = settings?.restaurant.name ?? 'Restaurante';
  const fone = foneWhatsApp(account.phone);
  const whatsapp = () => {
    const url = `https://wa.me/${fone}?text=${encodeURIComponent(textoPreConta(account, restaurante, mesa))}`;
    window.open(url, '_blank', 'noopener');
  };
  // na impressão só o cupom aparece (o resto da tela fica escondido pelo CSS de impressão)
  useEffect(() => { document.body.classList.add('cx-tem-cupom'); return () => document.body.classList.remove('cx-tem-cupom'); }, []);
  return (
    <>
      <Modal title={`Pré-conta · Conta #${account.number}`} onClose={onClose} footer={<>
        <button className="btn" onClick={onClose}>Voltar</button>
        <button className="btn" onClick={whatsapp}>Enviar no WhatsApp{fone ? '' : '…'}</button>
        <button className="btn primary" onClick={() => window.print()}>🖨 Imprimir</button>
      </>}>
        <div className="cx-cupom-tela"><Cupom acc={account} restaurante={restaurante} mesa={mesa} /></div>
        {!fone && <div className="small muted mt">Conta sem telefone: o WhatsApp abre para você escolher o contato.</div>}
      </Modal>
      {createPortal(<div className="cx-cupom-impressao" aria-hidden="true"><Cupom acc={account} restaurante={restaurante} mesa={mesa} /></div>, document.body)}
    </>
  );
}
