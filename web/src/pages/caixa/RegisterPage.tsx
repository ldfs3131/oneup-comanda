import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, chaveDoEnvio, type ChaveEnvio } from '../../api';
import { brl, dateTime, signed } from '../../format';
import type { RegisterSummary } from '../../types';
import { Modal, MoneyInput, Spinner, useAction, useToast } from '../../components/ui';
import { useMesaLabel } from '../../components/brand';
import { OpenDay } from './Board';

type Current = { register: null; isOpen: boolean } | {
  register: { id: number; openedAt: string; openedByName: string; openingCashCents: number }; isOpen: boolean; blind: boolean; summary: RegisterSummary;
  /** o caixa já fez a 1ª contagem (passou da tolerância): falta a recontagem */
  recontagem?: boolean;
};
type CloseResult =
  | { cego?: false; recontar?: undefined; expectedCashCents: number; countedCashCents: number; differenceCents: number; receivedCents: number; openAccounts: number; primeiraContagemCents?: number | null; primeiraDiferencaCents?: number | null }
  // Caixa (fechamento às cegas): nunca recebe esperado, diferença nem totais — só se precisa conferir
  | { cego: true; recontar?: undefined; countedCashCents: number; openAccounts: number; conferir: boolean; recontado?: boolean }
  // 1ª contagem do caixa passou da tolerância: o dia NÃO fechou, "conte de novo" (sem valores)
  | { cego: true; recontar: true };
type Fechado = Exclude<CloseResult, { recontar: true }>;

export function useRegister() {
  return useQuery({ queryKey: ['register'], queryFn: () => api.get<Current>('/api/register/current'), refetchInterval: 30_000 });
}

export default function RegisterPage() {
  const { data, isLoading } = useRegister();
  const [move, setMove] = useState<null | 'SANGRIA' | 'SUPRIMENTO'>(null);
  const [expense, setExpense] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closed, setClosed] = useState<Fechado | null>(null);

  if (closed) return (
    <div className="page narrow" style={{ maxWidth: 520 }}>
      <div className="card col gap-lg">
        <h1>{closed.cego ? 'Contagem registrada ✔' : 'Dia encerrado ✔'}</h1>
        <div className="muted small">O dia foi encerrado, o estabelecimento ficou <b>FECHADO</b>. Tudo fica salvo no servidor e entra na cópia de segurança diária.</div>
        {closed.cego ? <>
          <div className="kv"><span>{closed.recontado ? 'Dinheiro que você contou (2ª contagem)' : 'Dinheiro que você contou'}</span><span className="v">{brl(closed.countedCashCents)}</span></div>
          {closed.conferir
            ? <div className="problem-box">⚠ Confira com o responsável antes de ir embora.</div>
            : <div className="info-box small">Tudo certo. O responsável confere os números do dia.</div>}
        </> : <div>
          <div className="kv"><span>Total recebido no dia</span><span className="v">{brl(closed.receivedCents)}</span></div>
          <div className="kv"><span>Dinheiro esperado na gaveta</span><span className="v">{brl(closed.expectedCashCents)}</span></div>
          {closed.primeiraContagemCents != null && <div className="kv"><span>1ª contagem do caixa</span><span className="v">{brl(closed.primeiraContagemCents)}</span></div>}
          <div className="kv"><span>Dinheiro contado</span><span className="v">{brl(closed.countedCashCents)}</span></div>
          <div className="kv total"><span>Diferença</span><span className="v" style={{ color: closed.differenceCents === 0 ? 'var(--ok)' : 'var(--danger)' }}>{closed.differenceCents === 0 ? 'Sem diferença' : signed(closed.differenceCents)}</span></div>
        </div>}
        {closed.openAccounts > 0 && <div className="info-box small">{closed.openAccounts} conta(s) com saldo continuam abertas e aparecem no próximo dia.</div>}
        <button className="btn primary block" onClick={() => setClosed(null)}>OK</button>
      </div>
    </div>
  );
  if (isLoading || !data) return <Spinner />;
  if (!data.register) return <OpenDay />;
  const { register: reg, summary: s, blind } = data;

  return (
    <div className="col gap-lg">
      <div className="row between wrap">
        <div>
          <h1>Dia aberto</h1>
          <div className="muted small">Aberto {dateTime(reg.openedAt)} por {reg.openedByName} com {brl(reg.openingCashCents)} na gaveta</div>
        </div>
        <div className="row wrap">
          <button className="btn" onClick={() => setExpense(true)}>🧾 Despesa paga com a gaveta</button>
          <button className="btn" onClick={() => setMove('SANGRIA')}>− Sangria</button>
          <button className="btn" onClick={() => setMove('SUPRIMENTO')}>＋ Suprimento</button>
          <button className="btn primary lg" onClick={() => setClosing(true)}>{data.recontagem ? '🌙 Encerrar o dia · conte de novo' : '🌙 Encerrar o dia'}</button>
        </div>
      </div>
      <RegisterSummaryView s={s} blind={blind} />
      {move && <MovementModal type={move} onClose={() => setMove(null)} />}
      {expense && <DrawerExpenseModal onClose={() => setExpense(false)} />}
      {data.recontagem && !closing && <div className="problem-box">⚠ Falta a <b>recontagem</b> da gaveta: toque em “Encerrar o dia” e conte o dinheiro de novo.</div>}
      {closing && <CloseModal s={s} blind={blind} recontagem={!!data.recontagem} onClose={() => setClosing(false)} onClosed={(r) => { setClosing(false); setClosed(r as Fechado); }} />}
    </div>
  );
}

export function RegisterSummaryView({ s, blind }: { s: RegisterSummary; blind?: boolean }) {
  if (blind || s.salesCents == null) return <ResumoCego s={s} />;
  return (
    <div className="grid-3">
      <div className="card">
        <div className="panel-title">Vendas</div>
        <div className="kv total"><span>Vendido (itens lançados)</span><span className="v">{brl(s.salesCents)}</span></div>
        <div className="kv"><span>Pedidos</span><span className="v">{s.ordersCount}</span></div>
        <div className="kv"><span>Contas</span><span className="v">{s.accountsCount}</span></div>
        <div className="kv"><span>Descontos/ajustes ({s.discountsCount})</span><span className="v">−{brl(s.discountsCents)}</span></div>
        {s.discountsByUser.map((d) => <div key={d.name} className="kv small"><span className="muted">· {d.name}</span><span className="v">{brl(d.cents)} ({d.count})</span></div>)}
        <div className="kv"><span>Cancelamentos ({s.cancellationsCount})</span><span className="v">{brl(s.cancellationsCents)}</span></div>
        {s.lossCents > 0 && <div className="kv small"><span className="muted">· dos quais perdas</span><span className="v">{brl(s.lossCents)}</span></div>}
      </div>
      <div className="card">
        <div className="panel-title">Recebido</div>
        {!s.byMethod.length && <div className="muted small">Nenhum pagamento ainda.</div>}
        {s.byMethod.map((m) => <div key={m.code} className="kv"><span>{m.name} <span className="faint small">({m.count})</span></span><span className="v">{brl(m.cents)}</span></div>)}
        <div className="kv total"><span>Total recebido</span><span className="v">{brl(s.receivedCents)}</span></div>
        <div className="kv small"><span className="muted">Pagamentos parciais (contas em aberto)</span><span className="v">{brl(s.partialPaymentsCents)}</span></div>
        <div className="kv small"><span className="muted">Recebido de pendências anteriores</span><span className="v">{brl(s.fromPreviousPendingCents)}</span></div>
      </div>
      <div className="card">
        <div className="panel-title">Dinheiro na gaveta</div>
        <div className="kv"><span>Abertura</span><span className="v">{brl(s.openingCashCents)}</span></div>
        <div className="kv"><span>+ Suprimentos</span><span className="v">{brl(s.suprimentosCents)}</span></div>
        <div className="kv"><span>− Sangrias e despesas</span><span className="v">{brl(s.sangriasCents)}</span></div>
        {blind || s.expectedCashCents == null ? (
          <div className="info-box small mt">🔒 Fechamento às cegas: o valor esperado em dinheiro só aparece depois que você contar a gaveta no “Encerrar o dia”.</div>
        ) : <>
          <div className="kv"><span>+ Recebido em dinheiro</span><span className="v">{brl(s.cashReceivedCents)}</span></div>
          <div className="kv total"><span>Esperado</span><span className="v">{brl(s.expectedCashCents)}</span></div>
        </>}
        {s.countedCashCents != null && <>
          {s.primeiraContagemCents != null && <>
            <div className="kv"><span>1ª contagem</span><span className="v">{brl(s.primeiraContagemCents)}</span></div>
            {s.primeiraDiferencaCents != null && <div className="kv small"><span className="muted">· diferença na 1ª contagem</span><span className="v">{signed(s.primeiraDiferencaCents)}</span></div>}
          </>}
          <div className="kv"><span>{s.primeiraContagemCents != null ? 'Contado (2ª contagem)' : 'Contado'}</span><span className="v">{brl(s.countedCashCents)}</span></div>
          <div className="kv"><span>Diferença</span><span className="v" style={{ color: s.differenceCents === 0 ? 'var(--ok)' : 'var(--danger)' }}>{signed(s.differenceCents ?? 0)}</span></div>
        </>}
      </div>
      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <div className="panel-title">Pendências criadas hoje ({s.pendingCreated.length}) · {brl(s.pendingCreatedCents)}</div>
        {!s.pendingCreated.length && <div className="muted small">Nenhuma.</div>}
        {s.pendingCreated.map((p) => <div key={p.id} className="kv"><span>#{p.number} · {p.customerName} · {p.contact}</span><span className="v">{brl(p.balance)}</span></div>)}
        {s.movements.length > 0 && <>
          <div className="divider" />
          <div className="panel-title">Sangrias, despesas e suprimentos</div>
          {s.movements.map((m, i) => <div key={i} className="kv small"><span>{m.type === 'SANGRIA' ? '− Saída' : '＋ Suprimento'} · {dateTime(m.createdAt)} · {m.userName} · {m.reason}</span><span className="v">{brl(m.amountCents)}</span></div>)}
        </>}
      </div>
    </div>
  );
}

/** O que o Caixa vê do dia: movimento e gaveta, sem valores de venda, PIX, cartão ou esperado (fechamento às cegas). */
function ResumoCego({ s }: { s: RegisterSummary }) {
  return (
    <div className="grid-3">
      <div className="card">
        <div className="panel-title">Movimento do dia</div>
        <div className="kv"><span>Pedidos</span><span className="v">{s.ordersCount}</span></div>
        <div className="kv"><span>Contas</span><span className="v">{s.accountsCount}</span></div>
        <div className="kv"><span>Descontos/ajustes</span><span className="v">{s.discountsCount}</span></div>
        <div className="kv"><span>Cancelamentos</span><span className="v">{s.cancellationsCount}</span></div>
        <div className="kv"><span>Contas com saldo agora</span><span className="v">{s.openAccountsNow}</span></div>
      </div>
      <div className="card">
        <div className="panel-title">Dinheiro na gaveta</div>
        <div className="kv"><span>Abertura</span><span className="v">{brl(s.openingCashCents)}</span></div>
        <div className="kv"><span>+ Suprimentos</span><span className="v">{brl(s.suprimentosCents)}</span></div>
        <div className="kv"><span>− Sangrias e despesas</span><span className="v">{brl(s.sangriasCents)}</span></div>
      </div>
      <div className="card">
        <div className="panel-title">Fechamento às cegas 🔒</div>
        <div className="small muted">No fim do dia, toque em <b>Encerrar o dia</b>, conte o dinheiro da gaveta e digite o valor. O responsável confere os números depois.</div>
      </div>
      {(s.pendingCreated.length > 0 || s.movements.length > 0) && <div className="card" style={{ gridColumn: '1 / -1' }}>
        <div className="panel-title">Contas deixadas a receber hoje ({s.pendingCreated.length})</div>
        {!s.pendingCreated.length && <div className="muted small">Nenhuma.</div>}
        {s.pendingCreated.map((p) => <div key={p.id} className="kv"><span>#{p.number} · {p.customerName} · {p.contact}</span><span className="v">{brl(p.balance)}</span></div>)}
        {s.movements.length > 0 && <>
          <div className="divider" />
          <div className="panel-title">Sangrias, despesas e suprimentos</div>
          {s.movements.map((m, i) => <div key={i} className="kv small"><span>{m.type === 'SANGRIA' ? '− Saída' : '＋ Suprimento'} · {dateTime(m.createdAt)} · {m.userName} · {m.reason}</span><span className="v">{brl(m.amountCents)}</span></div>)}
        </>}
      </div>}
    </div>
  );
}

function MovementModal({ type, onClose }: { type: 'SANGRIA' | 'SUPRIMENTO'; onClose: () => void }) {
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const envioMov: ChaveEnvio = useRef(null);
  const { busy, run } = useAction();
  const qc = useQueryClient();
  const label = type === 'SANGRIA' ? 'Sangria (retirar dinheiro da gaveta)' : 'Suprimento (colocar dinheiro na gaveta)';
  return (
    <Modal title={label} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary" disabled={busy || !amount || reason.trim().length < 3} onClick={async () => {
        const corpo = { type, amountCents: amount, reason: reason.trim() };
        if (await run(() => api.post('/api/register/movements', corpo, chaveDoEnvio(envioMov, corpo)), 'Registrado.')) {
          qc.invalidateQueries({ queryKey: ['register'] }); onClose();
        }
      }}>Registrar</button>
    </>}>
      <div className="col gap-lg">
        {type === 'SANGRIA' && <div className="small muted">Pagou uma conta com o dinheiro da gaveta? Use <b>“Despesa paga com a gaveta”</b> — ela já faz a sangria e entra no financeiro.</div>}
        <label className="field"><span>Valor</span><MoneyInput value={amount} onChange={setAmount} autoFocus /></label>
        <label className="field"><span>Motivo</span><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={type === 'SANGRIA' ? 'Ex.: dinheiro levado para o cofre' : 'Ex.: reforço de troco'} /></label>
      </div>
    </Modal>
  );
}

function DrawerExpenseModal({ onClose }: { onClose: () => void }) {
  const { data: cats = [] } = useQuery({ queryKey: ['expenseCats'], queryFn: () => api.get<{ id: number; name: string; active: boolean }[]>('/api/expense-categories') });
  const [cat, setCat] = useState<number | null>(null);
  const [desc, setDesc] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const envioDesp: ChaveEnvio = useRef(null);
  const { busy, run } = useAction();
  const qc = useQueryClient();
  const ok = !!cat && desc.trim().length >= 2 && !!amount;
  return (
    <Modal title="Despesa paga com o dinheiro da gaveta" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary" disabled={!ok || busy} onClick={async () => {
        const corpo = { description: desc.trim(), categoryId: cat, amountCents: amount, paidFromRegister: true };
        if (await run(() => api.post('/api/expenses', corpo, chaveDoEnvio(envioDesp, corpo)), 'Despesa lançada (saiu da gaveta).')) {
          qc.invalidateQueries({ queryKey: ['register'] }); onClose();
        }
      }}>Lançar {amount ? brl(amount) : ''}</button>
    </>}>
      <div className="col gap-lg">
        <div className="small muted">O valor sai da gaveta automaticamente (sangria) e aparece no financeiro do administrador.</div>
        <label className="field"><span>Categoria</span>
          <select className="input" value={cat ?? ''} onChange={(e) => setCat(Number(e.target.value) || null)}>
            <option value="">Escolha…</option>
            {cats.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="field"><span>Descrição</span><input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Ex.: gelo, gás, entregador" maxLength={120} /></label>
        <label className="field"><span>Valor</span><MoneyInput value={amount} onChange={setAmount} /></label>
      </div>
    </Modal>
  );
}

type ContaPend = { id: number; number: number; customerName: string | null; tableLabel: string | null; note: string | null; balance: number };
type PedidoPend = {
  id: number; number: number; status: string; problemNote: string | null; createdAt: string; accountId: number; accountNumber: number;
  customerName: string | null; tableLabel: string | null; itemsText: string | null;
};
type Pendencias = { comSaldo: ContaPend[]; pagas: ContaPend[]; vazias: ContaPend[]; naCozinha: PedidoPend[]; aguardando: PedidoPend[]; problemas: PedidoPend[] };

const STATUS_COZINHA: Record<string, string> = { CONFIRMED: 'na fila', IN_PREPARATION: 'preparando', READY: 'pronto, falta entregar', AWAITING_CONFIRMATION: 'QR esperando confirmar' };

/** Encerrar o dia: 1) o que ainda está pendurado; 2) contagem às cegas da gaveta (com UMA recontagem para o caixa). */
function CloseModal({ s, blind, recontagem, onClose, onClosed }: {
  s: RegisterSummary; blind: boolean; recontagem: boolean; onClose: () => void; onClosed: (r: CloseResult) => void;
}) {
  const mesa = useMesaLabel();
  const [etapa, setEtapa] = useState<'pendencias' | 'contagem'>(recontagem ? 'contagem' : 'pendencias');
  const [recontar, setRecontar] = useState(recontagem);
  const [counted, setCounted] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState(false);
  const { busy, run } = useAction();
  const qc = useQueryClient();
  const envioFech: ChaveEnvio = useRef(null);
  const { data: pend, refetch } = useQuery({ queryKey: ['day-pendencias'], queryFn: () => api.get<Pendencias>('/api/day/pendencias'), enabled: etapa === 'pendencias' });
  const diff = !blind && counted != null && s.expectedCashCents != null ? counted - s.expectedCashCents : null;
  const comSaldo = pend?.comSaldo.length ?? s.openAccountsNow;

  const toast = useToast();
  const emLote = async (rota: string, msg: (r: any) => string) => {
    let r: any;
    if (await run(async () => { r = await api.post<any>(rota, {}, true); })) {
      toast(msg(r), 'ok');
      await refetch(); qc.invalidateQueries({ queryKey: ['board'] }); qc.invalidateQueries({ queryKey: ['register'] });
    }
  };

  const fechar = async () => {
    let r: CloseResult | undefined;
    const corpo = { countedCashCents: counted, note: note.trim() || null };
    const ok = await run(async () => { r = await api.post<CloseResult>('/api/day/close', corpo, chaveDoEnvio(envioFech, { ...corpo, recontar })); });
    if (!ok || !r) return;
    envioFech.current = null;
    if ('recontar' in r && r.recontar) {
      // 1ª contagem passou da tolerância: o dia NÃO fechou; conta de novo (sem mostrar valores)
      setRecontar(true); setCounted(null); setConfirm(false);
      qc.invalidateQueries({ queryKey: ['register'] });
      return;
    }
    qc.invalidateQueries(); onClosed(r);
  };

  const linhaConta = (a: ContaPend, extra?: string) => (
    <Link key={a.id} className="cx-pend-linha" to={`/caixa/conta/${a.id}`} onClick={onClose}>
      <b className="num">#{a.number}</b>
      <span className="grow ellipsis">{[a.tableLabel ? `${mesa} ${a.tableLabel}` : null, a.customerName, a.note].filter(Boolean).join(' · ') || 'Sem identificação'}</span>
      <span className="num">{extra ?? brl(a.balance)}</span>
      <span aria-hidden="true">›</span>
    </Link>
  );
  const linhaPedido = (o: PedidoPend, txt: string) => (
    <Link key={`${o.id}-${txt}`} className="cx-pend-linha" to={`/caixa/conta/${o.accountId}`} onClick={onClose}>
      <b className="num">#{o.number}</b>
      <span className="grow">
        <span className="ellipsis cx-pend-txt">{o.tableLabel ? `${mesa} ${o.tableLabel}` : o.customerName ?? `Conta #${o.accountNumber}`}{o.itemsText ? ` — ${o.itemsText}` : ''}</span>
        <span className="small muted">{txt}</span>
      </span>
      <span aria-hidden="true">›</span>
    </Link>
  );

  if (etapa === 'pendencias') {
    const p = pend;
    const nada = p && !p.comSaldo.length && !p.pagas.length && !p.vazias.length && !p.naCozinha.length && !p.aguardando.length && !p.problemas.length;
    return (
      <Modal wide title="Encerrar o dia · antes de contar" onClose={onClose} footer={<>
        <button className="btn" onClick={onClose}>Voltar</button>
        <button className="btn primary lg" onClick={() => setEtapa('contagem')}>Continuar para a contagem</button>
      </>}>
        {!p ? <Spinner /> : nada ? (
          <div className="info-box">✔ Tudo certo: nenhuma conta aberta, nada na cozinha e nenhum problema. Pode contar a gaveta.</div>
        ) : (
          <div className="col gap-lg">
            <div className="cx-pend-resumo" aria-label="Resumo do que está aberto">
              {p.comSaldo.length > 0 && <span className="badge warn">{p.comSaldo.length} com saldo</span>}
              {p.pagas.length > 0 && <span className="badge ok">{p.pagas.length} paga(s) sem encerrar</span>}
              {p.vazias.length > 0 && <span className="badge">{p.vazias.length} vazia(s)</span>}
              {p.naCozinha.length + p.aguardando.length > 0 && <span className="badge info">{p.naCozinha.length + p.aguardando.length} sem entrega</span>}
              {p.problemas.length > 0 && <span className="badge danger">{p.problemas.length} problema(s)</span>}
            </div>
            <div className="small muted">Confira o que ainda está aberto. Toque numa linha para abrir a conta. O que ficar aberto continua no próximo dia.</div>
            {p.comSaldo.length > 0 && (
              <section className="cx-pend">
                <h3>Contas com saldo ({p.comSaldo.length})</h3>
                <div className="small muted">Ainda devem. Receba, ou marque como pendente (cliente saiu sem pagar).</div>
                {p.comSaldo.map((a) => linhaConta(a))}
              </section>
            )}
            {p.pagas.length > 0 && (
              <section className="cx-pend">
                <div className="row between wrap"><h3>Pagas, ainda não encerradas ({p.pagas.length})</h3>
                  <button className="btn go" disabled={busy} onClick={() => emLote('/api/day/encerrar-pagas', (r) => `${r.encerradas} conta(s) paga(s) encerrada(s).`)}>Encerrar todas as pagas</button></div>
                {p.pagas.map((a) => linhaConta(a, 'paga'))}
              </section>
            )}
            {p.vazias.length > 0 && (
              <section className="cx-pend">
                <div className="row between wrap"><h3>Contas vazias ({p.vazias.length})</h3>
                  <button className="btn danger" disabled={busy} onClick={() => emLote('/api/day/cancelar-vazias', (r) => `${r.canceladas} conta(s) vazia(s) cancelada(s).`)}>Cancelar vazias</button></div>
                <div className="small muted">Sem nenhum item e sem pagamento. Motivo registrado: “Conta vazia no fechamento”.</div>
                {p.vazias.map((a) => linhaConta(a, 'vazia'))}
              </section>
            )}
            {(p.naCozinha.length > 0 || p.aguardando.length > 0) && (
              <section className="cx-pend">
                <h3>Pedidos sem entrega ({p.naCozinha.length + p.aguardando.length})</h3>
                {p.aguardando.map((o) => linhaPedido(o, STATUS_COZINHA[o.status] ?? o.status))}
                {p.naCozinha.map((o) => linhaPedido(o, STATUS_COZINHA[o.status] ?? o.status))}
              </section>
            )}
            {p.problemas.length > 0 && (
              <section className="cx-pend problema">
                <h3>⚠ Problemas da cozinha em aberto ({p.problemas.length})</h3>
                {p.problemas.map((o) => linhaPedido(o, `“${o.problemNote}”`))}
              </section>
            )}
          </div>
        )}
      </Modal>
    );
  }

  return (
    <Modal title={recontar ? 'Encerrar o dia · conte de novo' : 'Encerrar o dia · contagem'} onClose={onClose} footer={<>
      <button className="btn" onClick={() => (recontar ? onClose() : setEtapa('pendencias'))}>Voltar</button>
      {!confirm
        ? <button className="btn primary lg" disabled={counted == null} onClick={() => setConfirm(true)}>Continuar</button>
        : <button className="btn primary lg" disabled={busy || counted == null} onClick={fechar}>{recontar ? 'Confirmar a recontagem e encerrar' : 'Confirmar e encerrar o dia'}</button>}
    </>}>
      <div className="col gap-lg">
        {recontar && (
          <div className="problem-box" role="alert">
            <b>Conte de novo.</b> Conte o dinheiro da gaveta mais uma vez, com calma (notas e moedas), e digite o valor. Esta segunda contagem encerra o dia.
          </div>
        )}
        {!recontar && comSaldo > 0 && (
          <div className="info-box small">{comSaldo} conta(s) com saldo continuam abertas e os pagamentos futuros entram no próximo dia.</div>
        )}
        <div className="small muted">Conte o dinheiro da gaveta e digite o valor. {blind ? 'Fechamento às cegas: o sistema guarda a sua contagem e o responsável confere.' : ''}</div>
        <label className="field"><span>{recontar ? 'Dinheiro contado na gaveta (2ª contagem)' : 'Dinheiro contado na gaveta'}</span><MoneyInput key={recontar ? 'c2' : 'c1'} value={counted} onChange={(v) => { setCounted(v); setConfirm(false); }} autoFocus /></label>
        {diff != null && (
          <div className="kv total"><span>Diferença</span><span className="v" style={{ color: diff === 0 ? 'var(--ok)' : 'var(--danger)' }}>{signed(diff)}</span></div>
        )}
        {!blind && s.primeiraContagemCents != null && <div className="small muted">1ª contagem do caixa: {brl(s.primeiraContagemCents)}</div>}
        <label className="field"><span>Observação (opcional)</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: faltou troco de R$ 10" /></label>
        {confirm && <div className="info-box small">Ao encerrar: o caixa fecha, o estabelecimento fica <b>FECHADO</b> (sem novos pedidos). Tudo fica salvo e entra na cópia de segurança diária.</div>}
      </div>
    </Modal>
  );
}
