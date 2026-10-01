import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Navigate } from 'react-router-dom';
import { api, qs } from '../../api';
import { useAuth } from '../../auth';
import { addDaysISO, brl, fmtDay, pct, todayISO } from '../../format';
import { Badge, Spinner } from '../../components/ui';

type Ref = {
  id: number; titulo: string; origem: string; inicio: string; fim: string; dias: number; observacao: string | null;
  totalCents: number; vendas: number; taxasCents: number; porForma: { forma: string; vendas: number; cents: number }[];
  diariaCents: number; mensalCents: number; ticketCents: number; vendasPorDia: number; taxaEfetiva: number;
};
type Resp = {
  referencias: Ref[];
  atual: {
    from: string; to: string; diasUso: number; inicioUso: string | null; recebidoCents: number; semDinheiroCents: number;
    vendasSemDinheiro: number; contas: number; taxasCents: number; diariaCents: number; diariaSemDinheiroCents: number; ticketCents: number;
  };
};

/** Variação em % com seta; neutro quando não há base. */
function Var({ agora, antes }: { agora: number; antes: number }) {
  if (!antes || !agora) return <span className="faint">—</span>;
  const v = agora / antes - 1;
  const cor = Math.abs(v) < 0.02 ? 'var(--muted)' : v > 0 ? 'var(--ok)' : 'var(--danger)';
  return <span style={{ color: cor, fontWeight: 700 }}>{v > 0 ? '▲' : v < 0 ? '▼' : '='} {pct(Math.abs(v), 1)}</span>;
}

/**
 * Base de comparação (só ONE UP): vendas de antes do sistema (relatório da maquininha) × período atual.
 * O Dono não vê esta tela: a leitura dos números é serviço da ONE UP.
 */
export default function BaseComparacao() {
  const { user } = useAuth();
  const [range, setRange] = useState({ from: addDaysISO(todayISO(), -29), to: todayISO() });
  const { data, isLoading } = useQuery({
    queryKey: ['oneup-referencias', range], enabled: !!user?.oneup,
    queryFn: () => api.get<Resp>(`/api/oneup/referencias${qs(range)}`),
  });
  if (!user?.oneup) return <Navigate to="/admin" replace />;

  return (
    <div className="col gap-lg">
      <div className="row between wrap">
        <div>
          <h1>Base de comparação <Badge tone="info">ONE UP</Badge></h1>
          <div className="muted small">Antes do sistema (relatório da maquininha) × com o sistema. Só o seu acesso ONE UP vê esta tela.</div>
        </div>
        <div className="row wrap">
          <div className="seg">
            <button onClick={() => setRange({ from: addDaysISO(todayISO(), -6), to: todayISO() })}>7 dias</button>
            <button onClick={() => setRange({ from: addDaysISO(todayISO(), -29), to: todayISO() })}>30 dias</button>
            <button onClick={() => setRange({ from: addDaysISO(todayISO(), -89), to: todayISO() })}>90 dias</button>
          </div>
          <input type="date" className="input" style={{ width: 160 }} value={range.from} max={range.to} onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))} />
          <input type="date" className="input" style={{ width: 160 }} value={range.to} min={range.from} max={todayISO()} onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))} />
        </div>
      </div>

      {isLoading || !data ? <Spinner /> : !data.referencias.length ? (
        <div className="card muted">Nenhuma base cadastrada para esta empresa. Use a ferramenta da plataforma: <code>plataforma.js provisionar</code>.</div>
      ) : data.referencias.map((r) => {
        const a = data.atual;
        const semUso = a.diasUso === 0;
        return (
          <div key={r.id} className="col gap-lg">
            <div className="grid-2">
              <div className="card dre">
                <div className="panel-title">{r.titulo}</div>
                <div className="small muted" style={{ marginTop: -6, marginBottom: 8 }}>{fmtDay(r.inicio)} a {fmtDay(r.fim)} · {r.dias} dias</div>
                <div className="kv"><span>Total vendido</span><span className="v">{brl(r.totalCents)}</span></div>
                <div className="kv"><span>Vendas</span><span className="v num">{r.vendas}</span></div>
                <div className="kv"><span>Ticket médio</span><span className="v">{brl(r.ticketCents)}</span></div>
                <div className="kv"><span>Taxas pagas</span><span className="v">{brl(r.taxasCents)} <span className="small faint">({pct(r.taxaEfetiva, 2)})</span></span></div>
                <div className="kv total"><span>Média por dia</span><span className="v">{brl(r.diariaCents)}</span></div>
                <div className="kv"><span>Equivale a 30 dias</span><span className="v">{brl(r.mensalCents)}</span></div>
                <div className="sep" />
                {r.porForma.map((f) => (
                  <div key={f.forma} className="kv"><span>{f.forma} <span className="faint small">({f.vendas})</span></span><span className="v">{brl(f.cents)} <span className="small faint">{pct(f.cents / (r.totalCents || 1), 0)}</span></span></div>
                ))}
                {r.observacao && <div className="small faint mt">{r.observacao}</div>}
              </div>

              <div className="card dre">
                <div className="panel-title">Com o sistema</div>
                <div className="small muted" style={{ marginTop: -6, marginBottom: 8 }}>
                  {semUso ? 'Nenhum recebimento neste período ainda.' : `${fmtDay(a.inicioUso!)} a ${fmtDay(a.to)} · ${a.diasUso} dia(s) com o sistema em uso`}
                </div>
                <div className="kv"><span>Recebido (todas as formas)</span><span className="v">{brl(a.recebidoCents)}</span></div>
                <div className="kv"><span>Recebido na maquininha <span className="small faint">(cartão + Pix)</span></span><span className="v">{brl(a.semDinheiroCents)}</span></div>
                <div className="kv"><span>Contas recebidas</span><span className="v num">{a.contas}</span></div>
                <div className="kv"><span>Ticket médio por conta</span><span className="v">{brl(a.ticketCents)}</span></div>
                <div className="kv"><span>Taxas estimadas</span><span className="v">{brl(a.taxasCents)}</span></div>
                <div className="kv total"><span>Média por dia na maquininha</span><span className="v">{brl(a.diariaSemDinheiroCents)} <Var agora={a.diariaSemDinheiroCents} antes={r.diariaCents} /></span></div>
                <div className="kv"><span>Média por dia (com dinheiro)</span><span className="v">{brl(a.diariaCents)}</span></div>
              </div>
            </div>
            <div className="info-box small">
              <b>Como ler:</b> a maquininha não registra vendas em dinheiro, então a comparação justa é <b>"média por dia na maquininha"</b> (cartão + Pix do sistema)
              contra a média de antes. O ticket da maquininha é por transação; o do sistema é por conta (uma conta pode ter mais de um pagamento).
              Poucos dias de uso ainda oscilam muito — tire conclusões a partir de 2 a 3 semanas.
            </div>
          </div>
        );
      })}
    </div>
  );
}
