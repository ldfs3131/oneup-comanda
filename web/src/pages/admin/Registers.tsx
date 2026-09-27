import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { brl, dateTime } from '../../format';
import type { RegisterSummary } from '../../types';
import { Badge, Modal, Spinner } from '../../components/ui';
import { RegisterSummaryView } from '../caixa/RegisterPage';

type Row = {
  id: number; status: 'OPEN' | 'CLOSED'; openedAt: string; closedAt: string | null; openingCashCents: number;
  expectedCashCents: number | null; countedCashCents: number | null; differenceCents: number | null; openedByName: string;
};

export default function Registers() {
  const { data, isLoading } = useQuery({ queryKey: ['registers'], queryFn: () => api.get<Row[]>('/api/registers') });
  const [open, setOpen] = useState<number | null>(null);
  if (isLoading || !data) return <Spinner />;
  return (
    <div className="col gap-lg">
      <h1>Caixas</h1>
      {!data.length ? <div className="card empty">Nenhum caixa aberto ainda.</div> : (
        <div className="card table-wrap" style={{ padding: 0 }}>
          <table className="table">
            <thead><tr><th>#</th><th>Abertura</th><th>Fechamento</th><th className="right">Abertura R$</th><th className="right">Esperado</th><th className="right">Contado</th><th className="right">Diferença</th></tr></thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id} className="click" onClick={() => setOpen(r.id)}>
                  <td className="num">{r.id}</td>
                  <td className="small">{dateTime(r.openedAt)}<div className="faint">{r.openedByName}</div></td>
                  <td className="small">{r.status === 'OPEN' ? <Badge tone="ok">Aberto</Badge> : dateTime(r.closedAt)}</td>
                  <td className="right num">{brl(r.openingCashCents)}</td>
                  <td className="right num">{r.expectedCashCents != null ? brl(r.expectedCashCents) : '—'}</td>
                  <td className="right num">{r.countedCashCents != null ? brl(r.countedCashCents) : '—'}</td>
                  <td className="right num" style={{ fontWeight: 700, color: r.differenceCents ? 'var(--danger)' : 'var(--ok)' }}>
                    {r.differenceCents != null ? `${r.differenceCents > 0 ? '+' : ''}${brl(r.differenceCents)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <RegisterModal id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function RegisterModal({ id, onClose }: { id: number; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ['registers', id], queryFn: () => api.get<{ register: { closingNote: string | null }; summary: RegisterSummary }>(`/api/registers/${id}`) });
  return (
    <Modal wide title={`Caixa #${id}`} onClose={onClose}>
      {!data ? <Spinner /> : <>
        {data.register.closingNote && <div className="problem-box" style={{ marginBottom: 12 }}>Observação do fechamento: {data.register.closingNote}</div>}
        <RegisterSummaryView s={data.summary} />
      </>}
    </Modal>
  );
}
