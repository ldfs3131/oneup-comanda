import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { dateOnly, time, todayISO } from '../../format';
import { Spinner } from '../../components/ui';

type Log = { id: number; createdAt: string; action: string; message: string; userName: string | null };

const ICON: Record<string, string> = {
  account: '🧾', order: '🍳', item: '✕', payment: '💰', discount: '🏷', kitchen: '👨‍🍳', register: '💵', menu: '🍢',
  user: '👤', auth: '🔑', settings: '⚙', backup: '💾', qr: '📱', setup: '🛠', demo: '🧪',
};

export default function Audit() {
  const [date, setDate] = useState(todayISO());
  const [search, setSearch] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['audit', date, search],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ ...(date && { date }), ...(search.trim() && { search: search.trim() }), ...(pageParam ? { before: String(pageParam) } : {}) });
      return api.get<Log[]>(`/api/audit?${p}`);
    },
    getNextPageParam: (last) => (last.length === 200 ? last[last.length - 1].id : undefined),
  });
  const logs = q.data?.pages.flat() ?? [];
  let lastDay = '';

  return (
    <div className="col gap-lg">
      <h1>Histórico</h1>
      <div className="row wrap">
        <input type="date" className="input" style={{ width: 170 }} value={date} onChange={(e) => setDate(e.target.value)} />
        <button className={`btn${date ? '' : ' primary'}`} onClick={() => setDate('')}>Todos os dias</button>
        <input className="input" style={{ maxWidth: 300 }} placeholder="Buscar (ex.: #128, desconto, João)" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {q.isLoading ? <Spinner /> : !logs.length ? <div className="card empty">Nada registrado{date ? ' neste dia' : ''}.</div> : (
        <div className="card" style={{ padding: '4px 16px' }}>
          {logs.map((l) => {
            const day = dateOnly(l.createdAt);
            const header = !date && day !== lastDay ? day : null;
            lastDay = day;
            return (
              <div key={l.id}>
                {header && <div className="panel-title" style={{ marginTop: 14 }}>{header}</div>}
                <div className="log-row">
                  <span className="log-time num">{time(l.createdAt)}</span>
                  <span className="log-ico">{ICON[l.action.split('.')[0]] ?? '•'}</span>
                  <span className="grow">{l.message}</span>
                </div>
              </div>
            );
          })}
          {q.hasNextPage && <button className="btn block" style={{ margin: '12px 0' }} disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Carregar mais</button>}
        </div>
      )}
    </div>
  );
}
