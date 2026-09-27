import { useState } from 'react';
import { api } from '../../api';
import { brl, norm } from '../../format';
import { Spinner, Toggle, useAction } from '../../components/ui';
import { useMenu } from './OrderComposer';

/** Tela rápida para o caixa marcar o que acabou / voltou. */
export default function Availability() {
  const { data, isLoading } = useMenu();
  const { run } = useAction();
  const [q, setQ] = useState('');
  if (isLoading || !data) return <Spinner />;
  const s = norm(q);
  return (
    <div className="col gap-lg page narrow" style={{ padding: 0 }}>
      <div className="row between wrap">
        <div>
          <h1>O que acabou?</h1>
          <div className="muted small">Desligue o que acabou. O produto some do pedido até você ligar de novo.</div>
        </div>
        <input className="input" style={{ maxWidth: 260 }} placeholder="Buscar produto" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {data.map((c) => {
        const prods = c.products.filter((p) => !s || norm(p.name).includes(s));
        if (!prods.length) return null;
        return (
          <div key={c.id} className="card">
            <div className="panel-title">{c.name}</div>
            {prods.map((p) => (
              <div key={p.id}>
                <div className="avail-row">
                  <div className="grow">
                    <div style={{ fontWeight: 700 }} className={p.available ? '' : 'strike'}>{p.name}</div>
                    <div className="small muted num">{brl(p.priceCents)}</div>
                  </div>
                  <span className={`badge ${p.available ? 'ok' : 'danger'}`}>{p.available ? 'Tem' : 'Acabou'}</span>
                  <Toggle on={p.available} label={`Disponibilidade de ${p.name}`} onChange={(v) => run(() => api.patch(`/api/products/${p.id}/availability`, { available: v }), v ? `${p.name} disponível.` : `${p.name} marcado como esgotado.`)} />
                </div>
                {p.groups.filter((g) => g.options.length > 1).map((g) => (
                  <div key={g.id} className="avail-opts">
                    <span className="small muted">{g.name}:</span>
                    {g.options.map((o) => (
                      <button key={o.id} className={`btn sm${o.available ? '' : ' danger'}`} onClick={() => run(() => api.patch(`/api/options/${o.id}/availability`, { available: !o.available }))}>
                        {o.available ? '' : '✕ '}{o.name}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
