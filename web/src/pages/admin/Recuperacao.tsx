import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate } from 'react-router-dom';
import { api, qs } from '../../api';
import { useAuth } from '../../auth';
import { brl, dateOnly, dateTime, fmtDay, pct } from '../../format';
import { Badge, Modal, ReasonModal, Spinner, Toggle, useAction } from '../../components/ui';

/*
 * RECUPERAÇÃO DE VENDAS (CRM de cobrança do fiado) — só a ONE UP.
 * O sistema prepara a mensagem e abre o WhatsApp; quem envia é você. O pagamento cai direto no restaurante.
 * Comissão só quando o Caixa/Dono dá a baixa na conta a receber.
 */

type Canal = 'WHATSAPP' | 'LIGACAO';
type ItemFila = {
  id: number; nome: string; numero: number; contato: string; whatsapp: string | null; saldoCents: number; status: string; statusPt: string;
  venc: string; diasAtraso: number; motivo?: string; passo?: string; canais?: Canal[]; canalPorque?: string; atrasadaDias?: number;
  contatadoHoje?: boolean; diasSemBaixa?: number; alerta?: boolean; diasNaRegua?: number;
};
type Fila = {
  hoje: string; hora: string; podeContatar: string | null; contatar: ItemFila[]; aguardandoBaixa: ItemFila[]; corrigirContato: ItemFila[];
  encerrar: ItemFila[]; contestadas: ItemFila[]; pausadas: (ItemFila & { motivo: string })[];
  resumo: { aContatar: number; atrasadas: number; alertasBaixa: number };
};
type Evento = { id: number; tipo: string; canal: string | null; canalPt: string | null; resultado: string | null; resultadoPt: string | null; dataPrometida: string | null; nota: string | null; criadoEm: string; quem: string | null };
type Ficha = {
  id: number; status: string; statusPt: string;
  devedor: { nome: string; contato: string; whatsapp: string | null; conta: number; origem: string; vencimento: string };
  saldoCents: number; valorEntradaCents: number; diasAtraso: number; diasAtrasoEntrada: number; percentualBp: number; entradaEm: string;
  diasNaRecuperacao: number; proximoContato: string | null; prometidoPara: string | null; tentativas: number; semRespostaSeguidas: number;
  promessasQuebradas: number; recuperadoCents: number; comissaoCents: number; recuperadoEm: string | null; encerradoEm: string | null;
  naoCobrarMotivo: string | null; pausadoMotivo: string | null; passo: { nome: string; canais: Canal[]; porque: string }; mensagem: string;
  contatadoHoje: boolean; bloqueioContato: string | null;
  acoes: { contato: boolean; resultado: boolean; retomar: boolean; naoCobrar: boolean; encerrar: boolean };
  linhaDoTempo: Evento[]; comprovantes: { id: number; tipo: string; tamanho: number; criadoEm: string; apagadoEm: string | null; quem: string | null }[];
};
type Passo = { dia: number; nome: string; canais: Canal[]; texto: string; encerrar: boolean };
type Config = {
  entrada_dias: number; faixas: { dias: number; bp: number }[]; horario: { inicio: number; fim: number; dias: number[] };
  max_contatos_dia: number; sem_resposta: { intervalo_dias: number; max_tentativas: number }; promessa: { quebradas_para_ligacao: number };
  dias_alerta_baixa: number; comissao_sem_contato: boolean; chave_pix: string; regua: Passo[];
};

const TONS: Record<string, string> = {
  NOVO: 'info', CONTATADO: 'info', SEM_RESPOSTA: 'warn', PROMETEU: 'brand', PAGO_AGUARDANDO_BAIXA: 'ok', RECUPERADO: 'ok', PAGO_SEM_CONTATO: 'muted',
  CONTESTADO: 'danger', NUMERO_ERRADO: 'warn', PAUSADO: 'muted', PERDIDO: 'danger', NAO_COBRAR: 'muted',
};
const STATUS_PT: Record<string, string> = {
  NOVO: 'Novo', CONTATADO: 'Contatado', SEM_RESPOSTA: 'Sem resposta', PROMETEU: 'Prometeu pagar', PAGO_AGUARDANDO_BAIXA: 'Pago — aguardando baixa',
  RECUPERADO: 'Recuperado', PAGO_SEM_CONTATO: 'Pago sem contato', CONTESTADO: 'Contestado', NUMERO_ERRADO: 'Número errado', PAUSADO: 'Pausado',
  PERDIDO: 'Perdido', NAO_COBRAR: 'Não cobrar',
};
const CANAL: Record<string, string> = { WHATSAPP: '💬 WhatsApp', LIGACAO: '📞 Ligação', PESSOAL: '🤝 Pessoalmente' };
const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const bpPct = (bp: number) => `${(bp / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
const StatusBadge = ({ s, label }: { s: string; label?: string }) => <Badge tone={TONS[s] ?? 'muted'}>{label ?? STATUS_PT[s] ?? s}</Badge>;

type Aba = 'hoje' | 'funil' | 'fichas' | 'relatorio' | 'config';
const ABAS: { id: Aba; rotulo: string }[] = [
  { id: 'hoje', rotulo: 'Hoje' }, { id: 'funil', rotulo: 'Funil' }, { id: 'fichas', rotulo: 'Fichas' }, { id: 'relatorio', rotulo: 'Relatório' }, { id: 'config', rotulo: 'Configuração' },
];

export default function Recuperacao() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [aba, setAba] = useState<Aba>(() => { try { return (localStorage.getItem('oneup:crm-aba') as Aba) || 'hoje'; } catch { return 'hoje'; } });
  const [aberta, setAberta] = useState<number | null>(null);
  const { data: estado, isLoading } = useQuery({
    queryKey: ['crm-estado'], enabled: !!user?.oneup,
    queryFn: () => api.get<{ ligado: boolean; hoje: string; hora: string }>('/api/oneup/crm/estado'),
  });
  // ao abrir a tela: sincroniza (entram as contas vencidas, saem as já pagas) e atualiza tudo
  useEffect(() => {
    if (!estado?.ligado) return;
    api.post('/api/oneup/crm/sincronizar').then(() => qc.invalidateQueries({ queryKey: ['crm'] })).catch(() => undefined);
  }, [estado?.ligado, qc]);
  const trocar = (a: Aba) => { setAba(a); try { localStorage.setItem('oneup:crm-aba', a); } catch { /* sem armazenamento */ } };

  if (!user?.oneup) return <Navigate to="/admin" replace />;
  if (isLoading || !estado) return <Spinner />;

  return (
    <div className="col gap-lg crm">
      <div className="row between wrap no-print">
        <div>
          <h1>💸 Recuperação de vendas <Badge tone="info">ONE UP</Badge></h1>
          <div className="muted small">Cobrança do fiado vencido. Você envia; o sistema prepara, agenda e lembra. O Dono não vê esta tela.</div>
        </div>
        {estado.ligado && <div className="seg" role="tablist">
          {ABAS.map((a) => <button key={a.id} role="tab" aria-selected={aba === a.id} className={aba === a.id ? 'on' : ''} onClick={() => trocar(a.id)}>{a.rotulo}</button>)}
        </div>}
      </div>

      {!estado.ligado ? (
        <div className="card col gap-lg">
          <h2>Serviço desligado neste restaurante</h2>
          <div className="muted">Para usar, ligue <b>"Serviço de recuperação de vendas"</b> em <b>Configurações › ONE UP (só você vê)</b> — só com o contrato assinado (cláusula de dados/LGPD).</div>
          <div className="small faint">Com o serviço ligado você passa a ver o mínimo do devedor (nome, contato, valor, vencimento e origem) das contas a receber vencidas. Tudo fica na auditoria do restaurante.</div>
        </div>
      ) : (
        <>
          {aba === 'hoje' && <AbaHoje abrir={setAberta} />}
          {aba === 'funil' && <AbaFunil />}
          {aba === 'fichas' && <AbaFichas abrir={setAberta} />}
          {aba === 'relatorio' && <AbaRelatorio />}
          {aba === 'config' && <AbaConfig />}
        </>
      )}
      {aberta != null && <FichaModal id={aberta} onClose={() => setAberta(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
function AbaHoje({ abrir }: { abrir: (id: number) => void }) {
  const { data, isLoading } = useQuery({ queryKey: ['crm', 'hoje'], queryFn: () => api.get<Fila>('/api/oneup/crm/hoje'), refetchInterval: 120_000 });
  if (isLoading || !data) return <Spinner />;
  const pendentes = data.contatar.filter((c) => !c.contatadoHoje);
  const feitas = data.contatar.filter((c) => c.contatadoHoje);
  return (
    <div className="col gap-lg">
      {data.podeContatar && <div className="banner info" style={{ borderRadius: 12 }}>⏸ {data.podeContatar} Você pode olhar as fichas; os contatos ficam para o horário permitido.</div>}
      <div className="tiles">
        <div className="tile hero"><div className="label">Contatar hoje</div><div className="value">{data.resumo.aContatar}</div><div className="sub">{fmtDay(data.hoje)} · {data.hora}</div></div>
        <div className="tile"><div className="label">Atrasadas</div><div className="value" style={{ color: data.resumo.atrasadas ? 'var(--danger)' : undefined }}>{data.resumo.atrasadas}</div><div className="sub">o lembrete era para um dia anterior</div></div>
        <div className="tile"><div className="label">Pagas sem baixa (alerta)</div><div className="value" style={{ color: data.resumo.alertasBaixa ? 'var(--warn)' : undefined }}>{data.resumo.alertasBaixa}</div><div className="sub">combinar com o Dono</div></div>
      </div>

      <Secao titulo={`Quem contatar (${pendentes.length})`} vazio="Ninguém para contatar agora. 🎉">
        {pendentes.map((c) => <LinhaFila key={c.id} c={c} abrir={abrir} />)}
      </Secao>
      {data.aguardandoBaixa.length > 0 && <Secao titulo={`Pago — aguardando baixa (${data.aguardandoBaixa.length})`} ajuda="O cliente disse que pagou direto ao restaurante. Só vira Recuperado (e gera comissão) quando o Caixa/Dono der a baixa no A receber.">
        {data.aguardandoBaixa.map((c) => (
          <LinhaSimples key={c.id} c={c} abrir={abrir} extra={c.alerta
            ? <Badge tone="warn">{c.diasSemBaixa} dia(s) sem baixa — combine com o Dono</Badge>
            : <span className="small faint">há {c.diasSemBaixa} dia(s)</span>} />
        ))}
      </Secao>}
      {data.corrigirContato.length > 0 && <Secao titulo={`Pedir correção do contato (${data.corrigirContato.length})`} ajuda="Número errado. Peça ao restaurante para corrigir o contato da conta; quando corrigirem, a ficha volta sozinha para a fila.">
        {data.corrigirContato.map((c) => <LinhaSimples key={c.id} c={c} abrir={abrir} extra={<span className="small muted">{c.contato || 'sem contato'}</span>} />)}
      </Secao>}
      {data.encerrar.length > 0 && <Secao titulo={`Passaram do fim da régua (${data.encerrar.length})`} ajuda="Sugestão: encerrar e levar ao Dono no relatório do mês.">
        {data.encerrar.map((c) => <LinhaSimples key={c.id} c={c} abrir={abrir} extra={<span className="small faint">{c.diasNaRegua} dias na régua</span>} />)}
      </Secao>}
      {data.contestadas.length > 0 && <Secao titulo={`Contestadas (${data.contestadas.length})`} ajuda="Pausadas: confira com o restaurante antes de retomar.">
        {data.contestadas.map((c) => <LinhaSimples key={c.id} c={c} abrir={abrir} />)}
      </Secao>}
      {data.pausadas.length > 0 && <Secao titulo={`Pausadas (${data.pausadas.length})`}>
        {data.pausadas.map((c) => <LinhaSimples key={c.id} c={c} abrir={abrir} extra={<span className="small faint">{c.motivo}</span>} />)}
      </Secao>}
      {feitas.length > 0 && <Secao titulo={`Já contatadas hoje (${feitas.length})`}>
        {feitas.map((c) => <LinhaFila key={c.id} c={c} abrir={abrir} />)}
      </Secao>}
    </div>
  );
}

function Secao({ titulo, ajuda, vazio, children }: { titulo: string; ajuda?: string; vazio?: string; children: ReactNode }) {
  const vazioMesmo = Array.isArray(children) && children.length === 0;
  return (
    <div className="card col" style={{ padding: 0 }}>
      <div style={{ padding: '14px 16px 4px' }}>
        <div className="panel-title" style={{ marginBottom: 2 }}>{titulo}</div>
        {ajuda && <div className="small muted">{ajuda}</div>}
      </div>
      {vazioMesmo ? <div className="empty">{vazio ?? 'Nada aqui.'}</div> : <div className="crm-lista">{children}</div>}
    </div>
  );
}

function LinhaFila({ c, abrir }: { c: ItemFila; abrir: (id: number) => void }) {
  return (
    <button className="crm-linha" onClick={() => abrir(c.id)}>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="row wrap" style={{ gap: 6 }}>
          <b>{c.nome}</b> <span className="faint small">#{c.numero}</span>
          {!!c.atrasadaDias && c.atrasadaDias > 0 && !c.contatadoHoje && <Badge tone="danger">atrasada {c.atrasadaDias}d</Badge>}
          {c.contatadoHoje && <Badge tone="ok">contatada hoje</Badge>}
        </div>
        <div className="small muted">{c.motivo}</div>
        <div className="small faint">{c.diasAtraso} dias de atraso · {(c.canais ?? []).map((k) => CANAL[k]).join(' + ')}{!c.whatsapp && (c.canais ?? []).includes('WHATSAPP') ? ' (sem WhatsApp)' : ''}</div>
      </div>
      <div className="right"><div className="num" style={{ fontWeight: 800 }}>{brl(c.saldoCents)}</div><div className="small faint">abrir ›</div></div>
    </button>
  );
}
function LinhaSimples({ c, abrir, extra }: { c: ItemFila; abrir: (id: number) => void; extra?: ReactNode }) {
  return (
    <button className="crm-linha" onClick={() => abrir(c.id)}>
      <div className="grow" style={{ minWidth: 0 }}>
        <div><b>{c.nome}</b> <span className="faint small">#{c.numero}</span></div>
        <div className="row wrap" style={{ gap: 6 }}>{extra}</div>
      </div>
      <div className="right num" style={{ fontWeight: 800 }}>{brl(c.saldoCents)}</div>
    </button>
  );
}

// ---------------------------------------------------------------------------------------------
type Funil = { etapas: { status: string; label: string; n: number; valorEntradaCents: number; recuperadoCents: number; comissaoCents: number }[]; totais: { fichas: number; emAbertoN: number; emAbertoCents: number; recuperadoCents: number; comissaoCents: number } };
type Insight = { id: string; frase: string; numero: string; amostra: string; confianca: string; acao: string; impacto?: string | null };

function AbaFunil() {
  const { data, isLoading } = useQuery({ queryKey: ['crm', 'funil'], queryFn: () => api.get<Funil>('/api/oneup/crm/funil') });
  const { data: ins } = useQuery({ queryKey: ['crm', 'insights'], queryFn: () => api.get<{ insights: Insight[]; semAmostra: string[] }>('/api/oneup/crm/insights') });
  if (isLoading || !data) return <Spinner />;
  const caminho = data.etapas.slice(0, 6);
  const lado = data.etapas.slice(6);
  const max = Math.max(1, ...data.etapas.map((e) => e.n));
  const Barra = ({ e }: { e: Funil['etapas'][number] }) => (
    <div className="crm-barra" title={`${e.label}: ${e.n} ficha(s), ${brl(e.valorEntradaCents)}`}>
      <div className="crm-barra-rot"><StatusBadge s={e.status} label={e.label} /></div>
      <div className="crm-barra-trilho"><div className="crm-barra-cheia" style={{ width: `${(e.n / max) * 100}%` }} /></div>
      <div className="crm-barra-val num"><b>{e.n}</b> <span className="small muted">{brl(e.status === 'RECUPERADO' ? e.recuperadoCents : e.valorEntradaCents)}</span></div>
    </div>
  );
  return (
    <div className="col gap-lg">
      <div className="tiles">
        <div className="tile"><div className="label">Em aberto na recuperação</div><div className="value">{brl(data.totais.emAbertoCents)}</div><div className="sub">{data.totais.emAbertoN} ficha(s) · valor na entrada</div></div>
        <div className="tile hero"><div className="label">Recuperado (com baixa)</div><div className="value">{brl(data.totais.recuperadoCents)}</div><div className="sub">desde o início do serviço</div></div>
        <div className="tile"><div className="label">Comissão ONE UP</div><div className="value">{brl(data.totais.comissaoCents)}</div><div className="sub">só sobre baixas feitas pelo restaurante</div></div>
      </div>
      <div className="card col">
        <div className="panel-title">Funil — Novo → Contatado → Sem resposta → Prometeu → Pago → Recuperado</div>
        {caminho.map((e) => <Barra key={e.status} e={e} />)}
        <div className="sep" />
        <div className="panel-title">Fora do caminho principal</div>
        {lado.map((e) => <Barra key={e.status} e={e} />)}
        <div className="small faint">Barras: número de fichas. Valor: saldo na entrada (em Recuperado, o valor efetivamente recebido).</div>
      </div>
      <div className="card col">
        <div className="panel-title">O que os números da recuperação dizem</div>
        {!ins ? <Spinner /> : !ins.insights.length ? <div className="muted small">Ainda sem dados suficientes para conclusões.</div> : ins.insights.map((i) => (
          <div key={i.id} className="crm-insight">
            <div className="row between wrap"><b>{i.frase}</b><Badge tone={i.confianca === 'alta' ? 'ok' : i.confianca === 'média' ? 'info' : 'muted'}>confiança {i.confianca}</Badge></div>
            <div className="small">{i.numero}</div>
            <div className="small faint">Amostra: {i.amostra}</div>
            <div className="small"><b>Ação:</b> {i.acao}</div>
            {i.impacto && <div className="small muted">{i.impacto}</div>}
          </div>
        ))}
        {!!ins?.semAmostra.length && <div className="small faint">Ainda sem amostra: {ins.semAmostra.join(' ')}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
type FichaLista = { id: number; nome: string; numero: number; status: string; statusPt: string; saldoCents: number; valorEntradaCents: number; diasAtraso: number; venc: string; percentualBp: number; proximoContato: string | null; tentativas: number; recuperadoCents: number; comissaoCents: number };
function AbaFichas({ abrir }: { abrir: (id: number) => void }) {
  const [status, setStatus] = useState('');
  const [busca, setBusca] = useState('');
  const [b, setB] = useState('');
  useEffect(() => { const t = setTimeout(() => setB(busca.trim()), 300); return () => clearTimeout(t); }, [busca]);
  const { data, isLoading } = useQuery({ queryKey: ['crm', 'fichas', status, b], queryFn: () => api.get<FichaLista[]>(`/api/oneup/crm/fichas${qs({ status, busca: b })}`) });
  return (
    <div className="col gap-lg">
      <div className="row wrap">
        <select className="input" style={{ maxWidth: 240 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todas as situações</option>
          <option value="NOVO,CONTATADO,SEM_RESPOSTA,PROMETEU">Em cobrança</option>
          {Object.entries(STATUS_PT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input className="input grow" style={{ minWidth: 160 }} placeholder="Buscar por nome ou nº da conta" value={busca} onChange={(e) => setBusca(e.target.value)} />
      </div>
      {isLoading || !data ? <Spinner /> : !data.length ? <div className="card empty">Nenhuma ficha.</div> : (
        <div className="card table-wrap" style={{ padding: 0 }}>
          <table className="table">
            <thead><tr><th>Cliente</th><th>Situação</th><th className="hide-mobile">Atraso</th><th className="hide-mobile">Próximo</th><th className="right">Saldo</th><th className="right hide-mobile">Comissão</th></tr></thead>
            <tbody>
              {data.map((f) => (
                <tr key={f.id} className="click" onClick={() => abrir(f.id)}>
                  <td><b>{f.nome}</b> <span className="faint small">#{f.numero}</span><div className="small faint">faixa {bpPct(f.percentualBp)} · {f.tentativas} contato(s)</div></td>
                  <td><StatusBadge s={f.status} label={f.statusPt} /></td>
                  <td className="small hide-mobile">{f.diasAtraso} dias<div className="faint">venc. {fmtDay(f.venc)}</div></td>
                  <td className="small hide-mobile">{f.proximoContato ? fmtDay(f.proximoContato) : '—'}</td>
                  <td className="right num" style={{ fontWeight: 800 }}>{brl(f.status === 'RECUPERADO' ? f.recuperadoCents : f.saldoCents)}</td>
                  <td className="right num hide-mobile">{f.comissaoCents ? brl(f.comissaoCents) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
function FichaModal({ id, onClose }: { id: number; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: f, isLoading } = useQuery({ queryKey: ['crm', 'ficha', id], queryFn: () => api.get<Ficha>(`/api/oneup/crm/fichas/${id}`) });
  const { busy, run } = useAction();
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState<null | 'VAI_PAGAR' | 'PARCELAR' | 'CONTESTOU' | 'PAGOU' | 'NAO_VAI_PAGAR'>(null);
  const [data, setData] = useState('');
  const [nota, setNota] = useState('');
  const [anot, setAnot] = useState('');
  const [motivoModal, setMotivoModal] = useState<null | 'nao' | 'encerrar'>(null);
  const arquivo = useRef<HTMLInputElement>(null);
  const atualizar = () => qc.invalidateQueries({ queryKey: ['crm'] });
  useEffect(() => { if (f && msg == null) setMsg(f.mensagem); }, [f, msg]);
  if (isLoading || !f) return <Modal title="Ficha" onClose={onClose} wide><Spinner /></Modal>;

  const texto = msg ?? f.mensagem;
  const abrirWhats = async () => {
    // abre a janela já no toque (o navegador não bloqueia) e só manda para o WhatsApp se o servidor aceitar o contato
    const janela = window.open('', '_blank');
    const ok = await run(async () => { await api.post(`/api/oneup/crm/fichas/${f.id}/contato`, { canal: 'WHATSAPP' }); }, 'Contato registrado. Envie a mensagem no WhatsApp.');
    if (ok && janela && f.devedor.whatsapp) { janela.opener = null; janela.location.href = `https://wa.me/${f.devedor.whatsapp}?text=${encodeURIComponent(texto.trim())}`; } else janela?.close();
    if (ok) atualizar();
  };
  const ligar = async () => { if (await run(() => api.post(`/api/oneup/crm/fichas/${f.id}/contato`, { canal: 'LIGACAO' }), 'Ligação registrada.')) atualizar(); };
  const resultado = async (resultado: string, extra: { data?: string | null; nota?: string | null } = {}) => {
    if (await run(() => api.post(`/api/oneup/crm/fichas/${f.id}/resultado`, { resultado, ...extra }), 'Resultado registrado.')) { setForm(null); setData(''); setNota(''); atualizar(); }
  };
  const enviarComprovante = async (file: File) => {
    const fd = new FormData(); fd.append('arquivo', file);
    if (await run(() => api.upload(`/api/oneup/crm/fichas/${f.id}/comprovante`, fd), 'Comprovante anexado.')) atualizar();
    if (arquivo.current) arquivo.current.value = '';
  };
  const encerrada = !!f.encerradoEm && f.status !== 'PERDIDO';

  return (
    <Modal wide onClose={onClose} title={<span className="row wrap" style={{ gap: 8 }}>{f.devedor.nome} <StatusBadge s={f.status} label={f.statusPt} /></span>}>
      <div className="crm-ficha">
        <div className="col gap-lg">
          <div className="card tight col" style={{ gap: 0 }}>
            <div className="kv"><span>Saldo atual</span><span className="v">{brl(f.saldoCents)}</span></div>
            <div className="kv"><span>Contato</span><span className="v">{f.devedor.contato || '—'}</span></div>
            <div className="kv"><span>Conta</span><span className="v">#{f.devedor.conta} <span className="small faint">({f.devedor.origem === 'QR_CODE' ? 'cardápio digital' : f.devedor.origem.toLowerCase()})</span></span></div>
            <div className="kv"><span>Vencimento</span><span className="v">{fmtDay(f.devedor.vencimento)} <span className="small faint">· {f.diasAtraso} dias</span></span></div>
            <div className="kv"><span>Entrada na recuperação</span><span className="v">{dateOnly(f.entradaEm)} <span className="small faint">· {brl(f.valorEntradaCents)}</span></span></div>
            <div className="kv"><span>Faixa da comissão</span><span className="v">{bpPct(f.percentualBp)} <span className="small faint">({f.diasAtrasoEntrada} dias na entrada)</span></span></div>
            <div className="kv"><span>Contatos</span><span className="v">{f.tentativas}{f.semRespostaSeguidas ? ` · ${f.semRespostaSeguidas} sem resposta` : ''}{f.promessasQuebradas ? ` · ${f.promessasQuebradas} promessa(s) quebrada(s)` : ''}</span></div>
            <div className="kv"><span>Próximo lembrete</span><span className="v">{f.proximoContato ? fmtDay(f.proximoContato) : '—'}{f.prometidoPara ? <span className="small faint"> · prometeu {fmtDay(f.prometidoPara)}</span> : null}</span></div>
            {f.status === 'RECUPERADO' && <div className="kv total"><span>Recuperado · comissão</span><span className="v">{brl(f.recuperadoCents)} · {brl(f.comissaoCents)}</span></div>}
            {f.naoCobrarMotivo && <div className="small muted" style={{ paddingTop: 6 }}>Não cobrar: {f.naoCobrarMotivo}</div>}
            {f.pausadoMotivo && <div className="small muted" style={{ paddingTop: 6 }}>Pausada: {f.pausadoMotivo}</div>}
          </div>

          {f.acoes.contato && <div className="col">
            <div className="panel-title" style={{ marginBottom: 0 }}>Mensagem — {f.passo.nome}</div>
            <div className="small faint">Sugestão: {f.passo.canais.map((k) => CANAL[k]).join(' + ')} ({f.passo.porque}). Edite à vontade; nunca ameace nem exponha o cliente.</div>
            <textarea className="input" rows={5} maxLength={700} value={texto} onChange={(e) => setMsg(e.target.value)} />
            {f.bloqueioContato && <div className="banner info" style={{ borderRadius: 10, textAlign: 'left' }}>{f.bloqueioContato}</div>}
            <div className="row wrap">
              <button className="btn primary" disabled={busy || !!f.bloqueioContato || !f.devedor.whatsapp || texto.trim().length < 5} onClick={abrirWhats}
                title={f.devedor.whatsapp ? 'Registra o contato e abre o WhatsApp com a mensagem' : 'Sem WhatsApp válido nesta conta'}>💬 Abrir no WhatsApp</button>
              <button className="btn" disabled={busy || !!f.bloqueioContato} onClick={ligar}>📞 Registrar ligação</button>
            </div>
          </div>}

          {f.acoes.resultado && <div className="col">
            <div className="panel-title" style={{ marginBottom: 0 }}>Resultado do contato</div>
            <div className="row wrap" style={{ gap: 6 }}>
              <button className="btn sm" disabled={busy} onClick={() => resultado('SEM_RESPOSTA')}>Sem resposta</button>
              <button className={`btn sm${form === 'VAI_PAGAR' ? ' primary' : ''}`} onClick={() => setForm('VAI_PAGAR')}>Vai pagar (data)</button>
              <button className={`btn sm${form === 'PAGOU' ? ' primary' : ''}`} onClick={() => setForm('PAGOU')}>Pagou</button>
              <button className={`btn sm${form === 'PARCELAR' ? ' primary' : ''}`} onClick={() => setForm('PARCELAR')}>Pediu parcelar</button>
              <button className={`btn sm${form === 'CONTESTOU' ? ' primary' : ''}`} onClick={() => setForm('CONTESTOU')}>Contestou</button>
              <button className="btn sm" disabled={busy} onClick={() => resultado('NUMERO_ERRADO')}>Número errado</button>
              <button className={`btn sm${form === 'NAO_VAI_PAGAR' ? ' primary' : ''}`} onClick={() => setForm('NAO_VAI_PAGAR')}>Não vai pagar</button>
            </div>
            {form && <div className="card tight col">
              {form === 'PAGOU' && <div className="small muted">O pagamento vai direto ao restaurante. A ficha fica "Pago — aguardando baixa" até o Caixa/Dono receber no A receber (só então conta como recuperado). Anexe o comprovante, se tiver.</div>}
              {form === 'NAO_VAI_PAGAR' && <div className="small muted">A ficha é encerrada como perdida. Se a baixa acontecer depois, ela conta como recuperada.</div>}
              {(form === 'VAI_PAGAR' || form === 'PARCELAR') && <label className="field"><span>{form === 'VAI_PAGAR' ? 'Data que vai pagar' : 'Data da 1ª parcela (opcional)'}</span>
                <input type="date" className="input" value={data} onChange={(e) => setData(e.target.value)} /></label>}
              {form !== 'VAI_PAGAR' && <label className="field"><span>{form === 'PARCELAR' ? 'Proposta (obrigatório — combine com o Dono)' : form === 'CONTESTOU' ? 'O que o cliente contestou (obrigatório)' : 'Nota (opcional)'}</span>
                <input className="input" maxLength={500} value={nota} onChange={(e) => setNota(e.target.value)} /></label>}
              <div className="row"><button className="btn" onClick={() => setForm(null)}>Cancelar</button>
                <button className="btn primary" disabled={busy || (form === 'VAI_PAGAR' && !data) || ((form === 'PARCELAR' || form === 'CONTESTOU') && nota.trim().length < 3)}
                  onClick={() => resultado(form, { data: data || null, nota: nota.trim() || null })}>Registrar</button></div>
            </div>}
          </div>}

          <div className="row wrap" style={{ gap: 6 }}>
            {f.acoes.retomar && <button className="btn sm" disabled={busy} onClick={async () => { if (await run(() => api.post(`/api/oneup/crm/fichas/${f.id}/retomar`, {}), 'Ficha retomada.')) atualizar(); }}>↺ Retomar</button>}
            {f.acoes.encerrar && <button className="btn sm" onClick={() => setMotivoModal('encerrar')}>Encerrar como perdida</button>}
            {f.acoes.naoCobrar && <button className="btn sm danger" onClick={() => setMotivoModal('nao')}>⛔ Não cobrar</button>}
          </div>
          {encerrada && <div className="small faint">Ficha encerrada em {dateOnly(f.encerradoEm)}.</div>}
        </div>

        <div className="col gap-lg">
          <div className="col">
            <div className="panel-title" style={{ marginBottom: 0 }}>Comprovantes</div>
            <div className="small faint">Foto, print ou PDF (até 5 MB). Dado bancário: só você vê; fica fora das listas e do relatório. Recomendado apagar depois do fechamento do mês.</div>
            {f.comprovantes.map((c) => (
              <div key={c.id} className="row between small">
                <span>{c.tipo.toUpperCase()} · {dateTime(c.criadoEm)}{c.quem ? ` · ${c.quem}` : ''}</span>
                {c.apagadoEm ? <span className="faint">apagado em {dateOnly(c.apagadoEm)}</span> : <span className="row" style={{ gap: 6 }}>
                  <a className="btn sm" href={`/api/oneup/crm/comprovantes/${c.id}`} target="_blank" rel="noreferrer">Ver</a>
                  <button className="btn sm danger" disabled={busy} onClick={async () => { if (confirm('Apagar este comprovante? O arquivo sai do sistema (o registro de que existiu fica).') && await run(() => api.del(`/api/oneup/crm/comprovantes/${c.id}`), 'Comprovante apagado.')) atualizar(); }}>Apagar</button>
                </span>}
              </div>
            ))}
            {f.status !== 'NAO_COBRAR' && <label className="btn sm" style={{ alignSelf: 'flex-start' }}>📎 Anexar comprovante
              <input ref={arquivo} type="file" accept="image/png,image/jpeg,image/webp,application/pdf" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) void enviarComprovante(file); }} />
            </label>}
          </div>

          <div className="col">
            <div className="panel-title" style={{ marginBottom: 0 }}>Linha do tempo</div>
            <div className="row">
              <input className="input grow" placeholder="Anotar algo na ficha…" maxLength={500} value={anot} onChange={(e) => setAnot(e.target.value)} />
              <button className="btn" disabled={busy || anot.trim().length < 2} onClick={async () => { if (await run(() => api.post(`/api/oneup/crm/fichas/${f.id}/nota`, { nota: anot.trim() }))) { setAnot(''); atualizar(); } }}>Anotar</button>
            </div>
            <ol className="crm-tempo">
              {f.linhaDoTempo.map((e) => (
                <li key={e.id} className={`t-${e.tipo.toLowerCase()}`}>
                  <div className="small"><b>{e.tipo === 'CONTATO' ? `Contato · ${e.canalPt}` : e.tipo === 'RESULTADO' ? `Resultado · ${e.resultadoPt}` : e.tipo === 'NOTA' ? 'Nota' : 'Sistema'}</b>
                    <span className="faint"> · {dateTime(e.criadoEm)}{e.quem ? ` · ${e.quem}` : ''}</span></div>
                  {e.nota && <div className="small muted">{e.nota}</div>}
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
      {motivoModal && <ReasonModal
        title={motivoModal === 'nao' ? 'Não cobrar esta conta (definitivo)' : 'Encerrar como perdida'}
        description={motivoModal === 'nao' ? 'A conta nunca mais será contatada pelo serviço. Não dá para desfazer.' : 'A ficha sai da fila. Se a baixa acontecer depois, conta como recuperada.'}
        confirmLabel={motivoModal === 'nao' ? 'Não cobrar' : 'Encerrar'} danger={motivoModal === 'nao'}
        suggestions={motivoModal === 'nao' ? ['O Dono pediu', 'Cliente especial da casa', 'Valor muito baixo'] : ['Mudou de cidade', 'Não atende há meses', 'Passou do fim da régua']}
        onClose={() => setMotivoModal(null)}
        onConfirm={async (motivo) => {
          const ok = await run(() => api.post(`/api/oneup/crm/fichas/${f.id}/${motivoModal === 'nao' ? 'nao-cobrar' : 'encerrar'}`, { motivo }), 'Feito.');
          if (ok) atualizar();
          return ok;
        }} />}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
type Relatorio = {
  mes: string; restaurante: string; geradoEm: string; entraram: { n: number; cents: number }; recuperado: { n: number; cents: number };
  emNegociacao: { n: number; cents: number; aguardandoBaixa: number }; perdido: { n: number; cents: number }; pagoSemContato: { n: number; cents: number };
  taxaRecuperacao: number | null; taxaPremissa: string; tempoMedioDias: number | null; comissaoCents: number; liquidoRestauranteCents: number;
  porFaixa: { bp: number; n: number; recuperadoCents: number; comissaoCents: number }[];
  fichas: { id: number; conta: number; nome: string; status: string; statusPt: string; diasAtrasoEntrada: number; percentualBp: number; entradaCents: number; recuperadoCents: number; comissaoCents: number; diasAteEncerrar: number | null }[];
  mesesDisponiveis: string[];
};
const nomeMes = (m: string) => { const [a, mm] = m.split('-').map(Number); return new Date(Date.UTC(a, mm - 1, 15)).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }); };

function AbaRelatorio() {
  const [mes, setMes] = useState<string | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['crm', 'relatorio', mes], queryFn: () => api.get<Relatorio>(`/api/oneup/crm/relatorio${qs({ mes })}`) });
  if (isLoading || !data) return <Spinner />;
  return (
    <div className="col gap-lg">
      <div className="row wrap no-print">
        <select className="input" style={{ maxWidth: 220 }} value={data.mes} onChange={(e) => setMes(e.target.value)}>
          {data.mesesDisponiveis.map((m) => <option key={m} value={m}>{nomeMes(m)}</option>)}
        </select>
        <button className="btn" onClick={() => window.print()}>🖨 Imprimir / salvar PDF</button>
        <span className="small faint">Só para você. Leve ao Dono por fora.</span>
      </div>
      <div className="crm-relatorio print-area">
        <div className="row between wrap">
          <div>
            <div className="small muted">ONE UP · Recuperação de vendas</div>
            <h2 style={{ textTransform: 'capitalize' }}>{data.restaurante} — {nomeMes(data.mes)}</h2>
          </div>
          <div className="small faint">Gerado em {dateTime(data.geradoEm)}</div>
        </div>
        <div className="tiles mt">
          <div className="tile"><div className="label">Enviado para cobrança</div><div className="value">{brl(data.entraram.cents)}</div><div className="sub">{data.entraram.n} conta(s) entraram no mês</div></div>
          <div className="tile hero"><div className="label">Recuperado (com baixa)</div><div className="value">{brl(data.recuperado.cents)}</div><div className="sub">{data.recuperado.n} conta(s)</div></div>
          <div className="tile"><div className="label">Em negociação</div><div className="value">{brl(data.emNegociacao.cents)}</div><div className="sub">{data.emNegociacao.n} ficha(s) abertas no fim do mês{data.emNegociacao.aguardandoBaixa ? ` · ${data.emNegociacao.aguardandoBaixa} aguardando baixa` : ''}</div></div>
          <div className="tile"><div className="label">Perdido</div><div className="value">{brl(data.perdido.cents)}</div><div className="sub">{data.perdido.n} ficha(s)</div></div>
          <div className="tile"><div className="label">Taxa de recuperação</div><div className="value">{data.taxaRecuperacao == null ? '—' : pct(data.taxaRecuperacao)}</div><div className="sub">das fichas encerradas no mês</div></div>
          <div className="tile"><div className="label">Tempo médio</div><div className="value">{data.tempoMedioDias == null ? '—' : `${data.tempoMedioDias.toLocaleString('pt-BR')} dias`}</div><div className="sub">da entrada à baixa</div></div>
          <div className="tile"><div className="label">Comissão ONE UP</div><div className="value">{brl(data.comissaoCents)}</div><div className="sub">sobre o valor recuperado</div></div>
          <div className="tile"><div className="label">Líquido ao restaurante</div><div className="value">{brl(data.liquidoRestauranteCents)}</div><div className="sub">recuperado − comissão</div></div>
        </div>
        {data.pagoSemContato.n > 0 && <div className="small muted mt">Pagas antes de qualquer contato (sem comissão): {data.pagoSemContato.n} · {brl(data.pagoSemContato.cents)}.</div>}
        {data.porFaixa.length > 0 && <div className="mt">
          <div className="panel-title">Comissão por faixa de atraso na entrada</div>
          <table className="table"><thead><tr><th>Faixa</th><th className="right">Contas</th><th className="right">Recuperado</th><th className="right">Comissão</th></tr></thead>
            <tbody>{data.porFaixa.map((x) => <tr key={x.bp}><td>{bpPct(x.bp)}</td><td className="right num">{x.n}</td><td className="right num">{brl(x.recuperadoCents)}</td><td className="right num">{brl(x.comissaoCents)}</td></tr>)}</tbody></table>
        </div>}
        <div className="mt">
          <div className="panel-title">Fichas encerradas no mês</div>
          {!data.fichas.length ? <div className="muted small">Nenhuma ficha recuperada ou perdida neste mês.</div> : (
            <div className="table-wrap"><table className="table"><thead><tr><th>Conta</th><th>Situação</th><th className="right">Atraso na entrada</th><th className="right">Entrada</th><th className="right">Recuperado</th><th className="right">Comissão</th></tr></thead>
              <tbody>{data.fichas.map((x) => <tr key={x.id}><td>#{x.conta} {x.nome}</td><td>{x.statusPt}</td><td className="right num">{x.diasAtrasoEntrada} d · {bpPct(x.percentualBp)}</td><td className="right num">{brl(x.entradaCents)}</td><td className="right num">{x.status === 'RECUPERADO' ? brl(x.recuperadoCents) : '—'}</td><td className="right num">{x.comissaoCents ? brl(x.comissaoCents) : '—'}</td></tr>)}</tbody></table></div>
          )}
        </div>
        <div className="small faint mt">Taxa de recuperação: {data.taxaPremissa} Comissão só sobre contas com baixa feita pelo restaurante; o pagamento cai sempre direto na conta do restaurante.</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
function AbaConfig() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['crm', 'config'], queryFn: () => api.get<{ config: Config; padrao: Config }>('/api/oneup/crm/config') });
  const [c, setC] = useState<Config | null>(null);
  const { busy, run } = useAction();
  useEffect(() => { if (data && !c) setC(structuredClone(data.config)); }, [data, c]);
  if (!data || !c) return <Spinner />;
  const set = (patch: Partial<Config>) => setC({ ...c, ...patch });
  const num = (v: string) => (v === '' ? 0 : Math.round(Number(v)));
  const menorFaixa = Math.min(...c.faixas.map((f) => f.dias));
  const setPasso = (i: number, p: Partial<Passo>) => set({ regua: c.regua.map((x, k) => (k === i ? { ...x, ...p } : x)) });
  return (
    <div className="col gap-lg">
      <div className="card col gap-lg">
        <div className="panel-title">Entrada e comissão (contrato)</div>
        <label className="field"><span>Entra na recuperação a conta a receber vencida há (dias)</span>
          <input className="input" type="number" min={0} max={365} style={{ maxWidth: 140 }} value={c.entrada_dias} onChange={(e) => set({ entrada_dias: num(e.target.value) })} />
          <span className="small faint">Vencimento = data combinada; sem data, o dia em que a conta ficou pendente.</span></label>
        {c.entrada_dias < menorFaixa && <div className="banner info" style={{ borderRadius: 10 }}>Contas que entram com menos de {menorFaixa} dias de atraso não geram comissão (abaixo da menor faixa).</div>}
        <div className="col">
          <span className="small muted">Percentual por faixa de dias de atraso NA ENTRADA</span>
          {c.faixas.map((f, i) => (
            <div key={i} className="row wrap">
              <span className="small">a partir de</span>
              <input className="input" type="number" min={0} style={{ width: 90 }} value={f.dias} onChange={(e) => set({ faixas: c.faixas.map((x, k) => (k === i ? { ...x, dias: num(e.target.value) } : x)) })} />
              <span className="small">dias →</span>
              <input className="input" type="number" min={0} max={50} step={0.5} style={{ width: 90 }} value={f.bp / 100} onChange={(e) => set({ faixas: c.faixas.map((x, k) => (k === i ? { ...x, bp: Math.round(Number(e.target.value || 0) * 100) } : x)) })} />
              <span className="small">%</span>
              {c.faixas.length > 1 && <button className="btn sm ghost" onClick={() => set({ faixas: c.faixas.filter((_, k) => k !== i) })}>remover</button>}
            </div>
          ))}
          {c.faixas.length < 8 && <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => set({ faixas: [...c.faixas, { dias: (c.faixas[c.faixas.length - 1]?.dias ?? 0) + 30, bp: 2000 }] })}>+ faixa</button>}
        </div>
        <label className="row" style={{ gap: 10 }}><Toggle on={c.comissao_sem_contato} onChange={(v) => set({ comissao_sem_contato: v })} label="Comissão sem contato" /><span className="small">Cobrar comissão mesmo quando a conta é paga antes de qualquer contato (padrão: não)</span></label>
        <label className="field"><span>Chave Pix do restaurante (entra no lugar de {'{pix}'})</span>
          <input className="input" maxLength={120} value={c.chave_pix} onChange={(e) => set({ chave_pix: e.target.value })} placeholder="CNPJ, celular, e-mail ou chave aleatória" />
          <span className="small faint">O pagamento cai sempre direto no restaurante, nunca na ONE UP.</span></label>
      </div>

      <div className="card col gap-lg">
        <div className="panel-title">Guarda-corpos</div>
        <div className="row wrap">
          <span className="small">Contatos das</span>
          <input className="input" type="number" min={0} max={23} style={{ width: 80 }} value={c.horario.inicio} onChange={(e) => set({ horario: { ...c.horario, inicio: num(e.target.value) } })} />
          <span className="small">h às</span>
          <input className="input" type="number" min={1} max={24} style={{ width: 80 }} value={c.horario.fim} onChange={(e) => set({ horario: { ...c.horario, fim: num(e.target.value) } })} />
          <span className="small">h, em:</span>
          {DIAS.map((d, i) => <label key={d} className="check small"><input type="checkbox" checked={c.horario.dias.includes(i)} onChange={(e) => set({ horario: { ...c.horario, dias: e.target.checked ? [...c.horario.dias, i].sort() : c.horario.dias.filter((x) => x !== i) } })} />{d}</label>)}
        </div>
        <div className="row wrap">
          <span className="small">Máximo de contatos por dia por conta</span>
          <input className="input" type="number" min={1} max={3} style={{ width: 80 }} value={c.max_contatos_dia} onChange={(e) => set({ max_contatos_dia: num(e.target.value) })} />
        </div>
        <div className="row wrap">
          <span className="small">Sem resposta: nova tentativa a cada</span>
          <input className="input" type="number" min={1} max={30} style={{ width: 80 }} value={c.sem_resposta.intervalo_dias} onChange={(e) => set({ sem_resposta: { ...c.sem_resposta, intervalo_dias: num(e.target.value) } })} />
          <span className="small">dias, no máximo</span>
          <input className="input" type="number" min={1} max={20} style={{ width: 80 }} value={c.sem_resposta.max_tentativas} onChange={(e) => set({ sem_resposta: { ...c.sem_resposta, max_tentativas: num(e.target.value) } })} />
          <span className="small">tentativas (depois pausa)</span>
        </div>
        <div className="row wrap">
          <span className="small">Promessa quebrada</span>
          <input className="input" type="number" min={1} max={10} style={{ width: 80 }} value={c.promessa.quebradas_para_ligacao} onChange={(e) => set({ promessa: { quebradas_para_ligacao: num(e.target.value) } })} />
          <span className="small">vez(es) → próximo contato por ligação</span>
        </div>
        <div className="row wrap">
          <span className="small">"Pago — aguardando baixa": avisar depois de</span>
          <input className="input" type="number" min={1} max={60} style={{ width: 80 }} value={c.dias_alerta_baixa} onChange={(e) => set({ dias_alerta_baixa: num(e.target.value) })} />
          <span className="small">dias sem baixa</span>
        </div>
        <div className="small faint">Fixo (não é configuração): nada é enviado sozinho; "Não cobrar" é definitivo; mensagem identifica o restaurante e oferece canal para contestar.</div>
      </div>

      <div className="card col gap-lg">
        <div className="panel-title">Régua de cobrança (D = dia em que a conta entrou na recuperação)</div>
        <div className="small faint">Use {'{nome}'} {'{valor}'} {'{restaurante}'} {'{data}'} (vencimento) e {'{pix}'}. Valores provisórios — ajuste ao contrato.</div>
        {c.regua.map((p, i) => (
          <div key={i} className="card tight col">
            <div className="row wrap">
              <span className="small">D+</span>
              <input className="input" type="number" min={0} max={365} style={{ width: 80 }} value={p.dia} onChange={(e) => setPasso(i, { dia: num(e.target.value) })} />
              <input className="input grow" style={{ minWidth: 160 }} maxLength={60} value={p.nome} onChange={(e) => setPasso(i, { nome: e.target.value })} />
              {(['WHATSAPP', 'LIGACAO'] as Canal[]).map((k) => <label key={k} className="check small"><input type="checkbox" checked={p.canais.includes(k)} onChange={(e) => setPasso(i, { canais: e.target.checked ? [...p.canais, k] : p.canais.filter((x) => x !== k) })} />{CANAL[k]}</label>)}
              <label className="check small"><input type="checkbox" checked={p.encerrar} onChange={(e) => setPasso(i, { encerrar: e.target.checked })} />último passo</label>
              {c.regua.length > 1 && <button className="btn sm ghost" onClick={() => set({ regua: c.regua.filter((_, k) => k !== i) })}>remover</button>}
            </div>
            <textarea className="input" rows={3} maxLength={600} value={p.texto} onChange={(e) => setPasso(i, { texto: e.target.value })} />
          </div>
        ))}
        {c.regua.length < 12 && <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => set({ regua: [...c.regua, { dia: (c.regua[c.regua.length - 1]?.dia ?? 0) + 7, nome: 'Novo passo', canais: ['WHATSAPP'], texto: 'Oi, {nome}! Aqui é do {restaurante}. Sobre o valor de {valor}: se tiver alguma dúvida, é só responder aqui.', encerrar: false }] })}>+ passo</button>}
      </div>

      <div className="row wrap">
        <button className="btn primary" disabled={busy} onClick={async () => {
          const cfg = { ...c, regua: [...c.regua].sort((a, b) => a.dia - b.dia) };
          if (await run(async () => { const r = await api.put<{ config: Config }>('/api/oneup/crm/config', { config: cfg }); setC(r.config); }, 'Configuração salva.')) qc.invalidateQueries({ queryKey: ['crm'] });
        }}>Salvar configuração</button>
        <button className="btn" onClick={() => setC(structuredClone(data.config))}>Desfazer alterações</button>
        <button className="btn ghost" onClick={() => setC(structuredClone(data.padrao))}>Carregar valores padrão</button>
      </div>
    </div>
  );
}
