import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { brl, dateOnly, fmtDay, minutesSince, timeAgo } from '../../format';
import type { AccountListItem } from '../../types';
import { Badge, Modal, Spinner, useAction } from '../../components/ui';

export function useBase() {
  return useLocation().pathname.startsWith('/admin') ? '/admin' : '/caixa';
}

const ETIQUETA: Record<string, { label: string; tone: string }> = {
  venceu: { label: 'Venceu', tone: 'danger' },
  hoje: { label: 'Vence hoje', tone: 'warn' },
  sem_data: { label: 'Sem data', tone: 'muted' },
  em_dia: { label: 'Em dia', tone: 'ok' },
};

type Cobranca = { ligada: boolean; mensagem: string | null; restaurante: string };

/** WhatsApp do cliente: telefone da conta ou número escrito no campo "casa ou telefone". */
function zapDe(a: AccountListItem) {
  const fonte = a.phone || a.contact || '';
  let d = fonte.replace(/\D/g, '');
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  return d.length === 10 || d.length === 11 ? '55' + d : null;
}

export default function Receivables() {
  const nav = useNavigate();
  const base = useBase();
  const { data, isLoading } = useQuery({ queryKey: ['receivable'], queryFn: () => api.get<AccountListItem[]>('/api/accounts/receivable') });
  const { data: cob } = useQuery({ queryKey: ['cobranca'], queryFn: () => api.get<Cobranca>('/api/accounts/receivable/cobranca'), staleTime: 60_000 });
  const [cobrar, setCobrar] = useState<AccountListItem | null>(null);
  if (isLoading || !data) return <Spinner />;
  const total = data.reduce((s, a) => s + a.balance, 0);
  const vencido = data.filter((a) => a.situacao === 'venceu').reduce((s, a) => s + a.balance, 0);
  return (
    <div className="col gap-lg">
      <div className="row between wrap">
        <h1>A receber</h1>
        <div className="row wrap">
          {vencido > 0 && <div className="tile" style={{ minWidth: 180 }}>
            <div className="label">Vencido</div>
            <div className="value" style={{ color: 'var(--danger)' }}>{brl(vencido)}</div>
          </div>}
          <div className="tile" style={{ minWidth: 220 }}>
            <div className="label">Total a receber · {data.length} conta(s)</div>
            <div className="value">{brl(total)}</div>
          </div>
        </div>
      </div>
      {!data.length ? <div className="card empty">Nenhuma conta a receber. 🎉</div> : (
        <div className="card table-wrap" style={{ padding: 0 }}>
          <table className="table">
            <thead><tr><th>Situação</th><th>Cliente</th><th>Contato</th><th>Desde</th><th className="right">Saldo</th><th /></tr></thead>
            <tbody>
              {data.map((a) => {
                const e = ETIQUETA[a.situacao ?? 'sem_data'];
                return (
                  <tr key={a.id} className="click" onClick={() => nav(`${base}/conta/${a.id}`)}>
                    <td><Badge tone={e.tone}>{e.label}</Badge>{a.promisedDate && <div className="small faint">combinado {fmtDay(a.promisedDate)}</div>}</td>
                    <td><b>{a.customerName}</b> <span className="faint small">#{a.number}</span>{a.note && <div className="small muted">{a.note}</div>}
                      {a.ultimaCobrancaEm && <div className="small faint">cobrado {timeAgo(a.ultimaCobrancaEm)} por {a.ultimaCobrancaPor}</div>}</td>
                    <td>{a.contact}</td>
                    <td className="small">{dateOnly(a.pendingAt ?? a.openedAt)}<div className="faint">{Math.floor(minutesSince(a.pendingAt ?? a.openedAt) / 1440)} dia(s)</div></td>
                    <td className="right num" style={{ fontWeight: 800 }}>{brl(a.balance)}</td>
                    <td className="right" onClick={(ev) => ev.stopPropagation()}>
                      <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                        {cob?.ligada && <button className="btn sm" disabled={!zapDe(a)} title={zapDe(a) ? 'Abrir o WhatsApp com a mensagem' : 'Sem WhatsApp válido nesta conta'} onClick={() => setCobrar(a)}>{zapDe(a) ? '💬 Cobrar' : 'sem WhatsApp'}</button>}
                        <button className="btn sm primary" onClick={() => nav(`${base}/conta/${a.id}`)}>Receber</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="small muted">Toque em <b>Receber</b> para dar baixa. O recebimento entra no caixa do dia em que for pago.</div>
      {cobrar && cob?.mensagem && <CobrarModal conta={cobrar} cob={cob} onClose={() => setCobrar(null)} />}
    </div>
  );
}

/** Abre o WhatsApp com a mensagem pronta (editável). O sistema nunca envia sozinho: só registra a última cobrança. */
function CobrarModal({ conta, cob, onClose }: { conta: AccountListItem; cob: Cobranca; onClose: () => void }) {
  const preencher = (t: string) => t.replace(/\{nome\}/g, (conta.customerName ?? '').split(' ')[0])
    .replace(/\{valor\}/g, brl(conta.balance)).replace(/\{restaurante\}/g, cob.restaurante)
    .replace(/\{data\}/g, conta.promisedDate ? ` (combinado para ${fmtDay(conta.promisedDate)})` : '');
  const [texto, setTexto] = useState(preencher(cob.mensagem ?? ''));
  const { busy, run } = useAction();
  const qc = useQueryClient();
  const zap = zapDe(conta)!;
  return (
    <Modal title={`Cobrar ${conta.customerName}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary" disabled={busy || texto.trim().length < 5} onClick={async () => {
        const janela = window.open(`https://wa.me/${zap}?text=${encodeURIComponent(texto.trim())}`, '_blank', 'noopener');
        if (await run(() => api.post(`/api/accounts/${conta.id}/cobranca`))) { qc.invalidateQueries({ queryKey: ['receivable'] }); onClose(); }
        void janela;
      }}>Abrir no WhatsApp</button>
    </>}>
      <div className="col gap-lg">
        <div className="small muted">Confira e edite a mensagem. Ela abre no WhatsApp para você enviar — o sistema não envia sozinho.</div>
        <textarea className="input" rows={5} value={texto} onChange={(e) => setTexto(e.target.value)} maxLength={600} />
        <div className="small faint">Saldo {brl(conta.balance)} · WhatsApp +{zap}</div>
      </div>
    </Modal>
  );
}
