import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate } from 'react-router-dom';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { addDaysISO, brl, dateTime, fmtDay, norm, timeAgo } from '../../format';
import { Badge, Modal, MoneyInput, Spinner, useAction, useToast } from '../../components/ui';

/*
 * CENTRAL DE COMANDO (Plataforma ONE UP) — só o acesso ONE UP vê.
 * Carteira de clientes × MRR, licença de cada restaurante, cobrança pelo WhatsApp (uma pessoa envia) e
 * criação de restaurante novo com o cardápio de exemplo genérico.
 */
type Status = 'ATIVO' | 'SO_CONSULTA' | 'SUSPENSO';
type Restaurante = {
  id: number; slug: string; nome: string; endereco: string | null; criadaEm: string;
  licencaStatus: Status; efetivo: Status; venceEm: string | null; diasParaVencer: number | null; vencida: boolean; aVencer: boolean; diaAberto: boolean;
  mensalidadeCents: number; plano: string | null; donoNome: string | null; donoWhatsapp: string | null; cobrancaEnviadaEm: string | null; observacao: string | null;
  ultimaAtividade: string | null; contasNoMes: number; usuarios: number; versao: string;
};
type Carteira = { restaurantes: number; mrrCents: number; ativos: number; soConsulta: number; suspensos: number; aVencer: number; semPagamento: number; hoje: string; diasAviso: number };
type Resp = { carteira: Carteira; restaurantes: Restaurante[] };
type Hist = { id: number; tipo: string; mensagem: string; usuario: string | null; createdAt: string };

const ROTULO: Record<Status, string> = { ATIVO: 'Ativo', SO_CONSULTA: 'Só consulta', SUSPENSO: 'Suspenso' };
const TOM: Record<Status, string> = { ATIVO: 'ok', SO_CONSULTA: 'warn', SUSPENSO: 'danger' };
const EXPLICA: Record<Status, string> = {
  ATIVO: 'Tudo funciona normalmente.',
  SO_CONSULTA: 'Vê o histórico, recebe contas abertas e exporta. Não abre o dia nem lança pedido novo; o cardápio online sai do ar. Vale a partir do próximo "abrir o dia".',
  SUSPENSO: 'A equipe do restaurante não entra ("Acesso suspenso — fale com a ONE UP"). O seu acesso ONE UP continua entrando.',
};
const fone = (d: string | null) => (!d ? '—' : d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`);
const waLink = (d: string, msg: string) => `https://wa.me/55${d}?text=${encodeURIComponent(msg)}`;

function Vencimento({ r }: { r: Restaurante }) {
  if (!r.venceEm) return <span className="faint small">sem vencimento</span>;
  const d = r.diasParaVencer ?? 0;
  const txt = d < 0 ? `venceu ${fmtDay(r.venceEm)}` : d === 0 ? 'vence hoje' : `vence ${fmtDay(r.venceEm)} · ${d} dia${d > 1 ? 's' : ''}`;
  const cor = d < 0 ? 'var(--danger)' : r.aVencer ? 'var(--warn)' : 'var(--muted)';
  return <span className="small" style={{ color: cor, fontWeight: d <= 5 ? 700 : 500 }}>{txt}</span>;
}

function Licenca({ r }: { r: Restaurante }) {
  return (
    <div className="col" style={{ gap: 4 }}>
      <span><Badge tone={TOM[r.efetivo]}>{ROTULO[r.efetivo]}</Badge></span>
      <Vencimento r={r} />
      {r.vencida && r.diaAberto && r.licencaStatus === 'ATIVO' && <span className="small faint">dia aberto: trava só no próximo “abrir o dia”</span>}
    </div>
  );
}

type Filtro = 'todos' | 'vencer' | 'sem' | 'consulta' | 'suspensos';
const FILTROS: { k: Filtro; label: string; f: (r: Restaurante) => boolean }[] = [
  { k: 'todos', label: 'Todos', f: () => true },
  { k: 'vencer', label: 'A vencer', f: (r) => r.aVencer },
  { k: 'sem', label: 'Sem pagamento', f: (r) => r.vencida && r.efetivo !== 'SUSPENSO' },
  { k: 'consulta', label: 'Só consulta', f: (r) => r.efetivo === 'SO_CONSULTA' },
  { k: 'suspensos', label: 'Suspensos', f: (r) => r.efetivo === 'SUSPENSO' },
];

export default function Plataforma() {
  const { user } = useAuth();
  const { data, isLoading } = useQuery({ queryKey: ['plataforma'], enabled: !!user?.oneup, queryFn: () => api.get<Resp>('/api/plataforma/restaurantes'), refetchInterval: 60_000 });
  const [filtro, setFiltro] = useState<Filtro>('todos');
  const [busca, setBusca] = useState('');
  const [gerir, setGerir] = useState<Restaurante | null>(null);
  const [cobrar, setCobrar] = useState<Restaurante | null>(null);
  const [novo, setNovo] = useState(false);
  const lista = useMemo(() => {
    const f = FILTROS.find((x) => x.k === filtro)!.f;
    const q = norm(busca);
    return (data?.restaurantes ?? []).filter(f).filter((r) => !q || norm(`${r.nome} ${r.slug} ${r.donoNome ?? ''}`).includes(q));
  }, [data, filtro, busca]);
  if (!user?.oneup) return <Navigate to="/admin" replace />;
  if (isLoading || !data) return <Spinner />;
  const c = data.carteira;

  const acoes = (r: Restaurante) => (
    <div className="row wrap" style={{ gap: 6 }}>
      <button className="btn sm" onClick={() => setGerir(r)}>Gerenciar</button>
      <button className="btn sm" onClick={() => setCobrar(r)} disabled={!r.donoWhatsapp} title={r.donoWhatsapp ? 'Abrir o WhatsApp com a cobrança pronta' : 'Cadastre o WhatsApp do Dono em Gerenciar'}>💬 Cobrar</button>
      {r.endereco && <a className="btn sm ghost" href={r.endereco} target="_blank" rel="noreferrer">Abrir ↗</a>}
    </div>
  );

  return (
    <div className="col gap-lg plataforma">
      <div className="row between wrap">
        <div>
          <h1>Central de comando <Badge tone="info">ONE UP</Badge></h1>
          <div className="muted small">Carteira de restaurantes, licença online e cobrança. Só o seu acesso ONE UP vê esta tela.</div>
        </div>
        <button className="btn primary" onClick={() => setNovo(true)}>＋ Novo restaurante</button>
      </div>

      <div className="fin-cartoes">
        <div className="tile hero">
          <div className="label">MRR (mensalidades dos ativos)</div>
          <div className="value num">{brl(c.mrrCents)}</div>
          <div className="sub">{c.ativos} ativo{c.ativos === 1 ? '' : 's'} de {c.restaurantes} restaurante{c.restaurantes === 1 ? '' : 's'}</div>
        </div>
        <Cartao label="Ativos" valor={c.ativos} onClick={() => setFiltro('todos')} />
        <Cartao label={`A vencer em ${c.diasAviso} dias`} valor={c.aVencer} cor={c.aVencer ? 'var(--warn)' : undefined} onClick={() => setFiltro('vencer')} />
        <Cartao label="Sem pagamento (vencidos)" valor={c.semPagamento} cor={c.semPagamento ? 'var(--danger)' : undefined} onClick={() => setFiltro('sem')} />
        <Cartao label="Só consulta" valor={c.soConsulta} cor={c.soConsulta ? 'var(--warn)' : undefined} onClick={() => setFiltro('consulta')} />
        <Cartao label="Suspensos" valor={c.suspensos} cor={c.suspensos ? 'var(--danger)' : undefined} onClick={() => setFiltro('suspensos')} />
      </div>

      <div className="card col">
        <div className="row between wrap">
          <div className="seg">{FILTROS.map((f) => <button key={f.k} className={filtro === f.k ? 'on' : ''} onClick={() => setFiltro(f.k)}>{f.label}</button>)}</div>
          <input className="input" style={{ maxWidth: 260 }} placeholder="Buscar restaurante ou Dono" value={busca} onChange={(e) => setBusca(e.target.value)} />
        </div>

        {!lista.length ? <div className="empty">Nenhum restaurante neste filtro.</div> : <>
          <div className="table-wrap hide-mobile">
            <table className="table">
              <thead><tr><th>Restaurante</th><th>Licença</th><th>Mensalidade</th><th>Última atividade</th><th>Cobrança</th><th /></tr></thead>
              <tbody>
                {lista.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div style={{ fontWeight: 700 }}>{r.nome}</div>
                      <div className="small faint">{r.slug} · {r.donoNome ?? 'Dono não informado'}</div>
                    </td>
                    <td><Licenca r={r} /></td>
                    <td><div className="num" style={{ fontWeight: 700 }}>{brl(r.mensalidadeCents)}</div><div className="small faint">{r.plano ?? 'sem plano'}</div></td>
                    <td><div>{r.ultimaAtividade ? timeAgo(r.ultimaAtividade) : 'nenhum pedido'}</div><div className="small faint">{r.contasNoMes} conta{r.contasNoMes === 1 ? '' : 's'} no mês · v{r.versao}</div></td>
                    <td className="small">{r.cobrancaEnviadaEm ? <>enviada<br /><span className="faint">{dateTime(r.cobrancaEnviadaEm)}</span></> : <span className="faint">—</span>}</td>
                    <td>{acoes(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="plat-cards show-mobile-block">
            {lista.map((r) => (
              <div key={r.id} className="plat-card">
                <div className="row between" style={{ alignItems: 'flex-start' }}>
                  <div><div style={{ fontWeight: 800 }}>{r.nome}</div><div className="small faint">{r.slug} · {r.donoNome ?? 'Dono não informado'}</div></div>
                  <div className="num" style={{ fontWeight: 800, whiteSpace: 'nowrap' }}>{brl(r.mensalidadeCents)}</div>
                </div>
                <Licenca r={r} />
                <div className="small muted">{r.ultimaAtividade ? `Último pedido ${timeAgo(r.ultimaAtividade)}` : 'Nenhum pedido ainda'} · {r.contasNoMes} contas no mês{r.cobrancaEnviadaEm ? ` · cobrança enviada ${dateTime(r.cobrancaEnviadaEm)}` : ''}</div>
                {acoes(r)}
              </div>
            ))}
          </div>
        </>}
      </div>

      {gerir && <Gerenciar r={gerir} hoje={c.hoje} onClose={() => setGerir(null)} />}
      {cobrar && <Cobrar r={cobrar} onClose={() => setCobrar(null)} />}
      {novo && <NovoRestaurante hoje={c.hoje} onClose={() => setNovo(false)} />}
    </div>
  );
}

function Cartao({ label, valor, cor, onClick }: { label: string; valor: number; cor?: string; onClick: () => void }) {
  return (
    <button className="tile plat-tile" onClick={onClick}>
      <div className="label">{label}</div>
      <div className="value num" style={{ color: cor }}>{valor}</div>
    </button>
  );
}

/** Campo com rótulo. `grupo`: vários controles dentro (data + caixinha, botões) — não usa <label> aninhado. */
function Campo({ label, children, dica, grupo }: { label: string; children: ReactNode; dica?: ReactNode; grupo?: boolean }) {
  const corpo = <><span>{label}</span>{children}{dica && <div className="small faint">{dica}</div>}</>;
  return grupo ? <div className="field" role="group" aria-label={label}>{corpo}</div> : <label className="field">{corpo}</label>;
}

// ---------------------------------------------------------------------------------------------
function Gerenciar({ r, hoje, onClose }: { r: Restaurante; hoje: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { busy, run } = useAction();
  const [status, setStatus] = useState<Status>(r.licencaStatus);
  const [semVenc, setSemVenc] = useState(!r.venceEm);
  const [vence, setVence] = useState(r.venceEm ?? addDaysISO(hoje, 30));
  const [mensal, setMensal] = useState<number | null>(r.mensalidadeCents);
  const [plano, setPlano] = useState(r.plano ?? '');
  const [donoNome, setDonoNome] = useState(r.donoNome ?? '');
  const [donoWa, setDonoWa] = useState(r.donoWhatsapp ?? '');
  const [obs, setObs] = useState(r.observacao ?? '');
  const { data: hist } = useQuery({ queryKey: ['plataforma-hist', r.id], queryFn: () => api.get<Hist[]>(`/api/plataforma/restaurantes/${r.id}/historico`) });
  const atualizar = () => { qc.invalidateQueries({ queryKey: ['plataforma'] }); qc.invalidateQueries({ queryKey: ['plataforma-hist', r.id] }); };
  const salvar = () => run(async () => {
    await api.patch(`/api/plataforma/restaurantes/${r.id}`, {
      licencaStatus: status, licencaVenceEm: semVenc ? null : vence, mensalidadeCents: mensal ?? 0,
      plano: plano.trim() || null, donoNome: donoNome.trim() || null, donoWhatsapp: donoWa.trim() || null, observacao: obs.trim() || null,
    });
    atualizar(); onClose();
  }, 'Restaurante atualizado.');
  const pagamento = () => run(async () => {
    const x = await api.post<{ venceEm: string }>(`/api/plataforma/restaurantes/${r.id}/pagamento`, {});
    setVence(x.venceEm); setSemVenc(false); if (status === 'SO_CONSULTA') setStatus('ATIVO');
    atualizar();
  }, 'Pagamento registrado: vencimento renovado por 1 mês.');

  return (
    <Modal wide title={`Gerenciar · ${r.nome}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary" disabled={busy} onClick={salvar}>Salvar</button>
    </>}>
      <div className="col gap-lg">
        <div className="col">
          <div className="field"><span>Licença</span>
            <div className="seg">{(['ATIVO', 'SO_CONSULTA', 'SUSPENSO'] as Status[]).map((s) => <button key={s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>{ROTULO[s]}</button>)}</div>
          </div>
          <div className={`small ${status === 'SUSPENSO' ? '' : 'muted'}`} style={status === 'SUSPENSO' ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>{EXPLICA[status]}</div>
        </div>
        <div className="grid-2 plat-form">
          <Campo grupo label="Vencimento (último dia válido)" dica={semVenc ? 'Sem vencimento: nunca entra em só consulta pelo relógio.' : 'Aviso ao Dono 5 dias antes. Vencida: só consulta no próximo “abrir o dia”.'}>
            <input type="date" className="input" value={vence} disabled={semVenc} onChange={(e) => e.target.value && setVence(e.target.value)} />
            <label className="check small"><input type="checkbox" checked={semVenc} onChange={(e) => setSemVenc(e.target.checked)} />Sem vencimento</label>
          </Campo>
          <Campo grupo label="Mensalidade"><MoneyInput value={mensal} onChange={setMensal} /></Campo>
          <Campo label="Plano"><input className="input" value={plano} maxLength={40} placeholder="Ex.: Essencial" onChange={(e) => setPlano(e.target.value)} /></Campo>
          <Campo label="Nome do Dono"><input className="input" value={donoNome} maxLength={60} onChange={(e) => setDonoNome(e.target.value)} /></Campo>
          <Campo label="WhatsApp do Dono" dica="DDD + número. Usado só no botão “Cobrar”."><input className="input" inputMode="tel" value={donoWa} placeholder="(11) 91234-5678" onChange={(e) => setDonoWa(e.target.value)} /></Campo>
          <Campo label="Observação (só a ONE UP vê)"><input className="input" value={obs} maxLength={500} onChange={(e) => setObs(e.target.value)} /></Campo>
        </div>
        <div className="row wrap between info-box">
          <span className="small">Recebeu a mensalidade? Renove o vencimento por mais 1 mês{r.licencaStatus === 'SO_CONSULTA' ? ' e volte a licença para Ativo' : ''}.</span>
          <button className="btn sm go" disabled={busy} onClick={pagamento}>✔ Registrar pagamento</button>
        </div>
        <div>
          <div className="panel-title">Histórico de licença e cobrança</div>
          {!hist ? <div className="small faint">Carregando…</div> : !hist.length ? <div className="small faint">Nenhuma mudança registrada ainda.</div> : (
            <ul className="plat-hist">
              {hist.map((h) => <li key={h.id}><span className="faint small">{dateTime(h.createdAt)}</span> {h.mensagem}{h.usuario && <span className="faint small"> — {h.usuario}</span>}</li>)}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
function Cobrar({ r, onClose }: { r: Restaurante; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, error } = useQuery({ queryKey: ['plataforma-cobranca', r.id], queryFn: () => api.get<{ whatsapp: string; mensagem: string; ultimaEnviadaEm: string | null }>(`/api/plataforma/restaurantes/${r.id}/cobranca`), gcTime: 0 });
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setMsg(data.mensagem); }, [data]);
  const enviar = async () => {
    if (!data || msg.trim().length < 10) return;
    // abre o WhatsApp na hora do toque (o navegador não bloqueia) e registra o envio em seguida
    window.open(waLink(data.whatsapp, msg.trim()), '_blank', 'noopener');
    setBusy(true);
    try {
      await api.post(`/api/plataforma/restaurantes/${r.id}/cobranca`, { mensagem: msg.trim() });
      toast('Cobrança registrada. Confira e toque em enviar no WhatsApp.', 'ok');
      qc.invalidateQueries({ queryKey: ['plataforma'] });
      onClose();
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Cobrar no WhatsApp · ${r.nome}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn go" disabled={busy || !data || msg.trim().length < 10} onClick={enviar}>💬 Abrir WhatsApp</button>
    </>}>
      {error ? <div className="login-error">{(error as Error).message}</div> : !data ? <div className="small faint">Preparando a mensagem…</div> : (
        <div className="col">
          <div className="small muted">Para: <b>{r.donoNome ?? 'Dono'}</b> · {fone(data.whatsapp)}{data.ultimaEnviadaEm && <> · última cobrança {dateTime(data.ultimaEnviadaEm)}</>}</div>
          <textarea className="input" rows={7} value={msg} maxLength={1500} onChange={(e) => setMsg(e.target.value)} />
          <div className="small faint">O sistema só abre o WhatsApp com a mensagem pronta: quem envia é você. O envio fica registrado no histórico.</div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
const paraSlug = (t: string) => norm(t).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
type Criado = { empresa: { id: number; slug: string; nome: string }; endereco: string | null; produtos: number; acessos: Record<'dono' | 'caixa' | 'cozinha' | 'oneup', { login: string; senha: string }> };

function NovoRestaurante({ hoje, onClose }: { hoje: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { busy, run } = useAction();
  const [nome, setNome] = useState('');
  const [slug, setSlug] = useState('');
  const [slugMexido, setSlugMexido] = useState(false);
  const [donoNome, setDonoNome] = useState('');
  const [donoLogin, setDonoLogin] = useState('dono');
  const [donoWa, setDonoWa] = useState('');
  const [cardapio, setCardapio] = useState<'exemplo' | 'vazio'>('exemplo');
  const [mensal, setMensal] = useState<number | null>(null);
  const [plano, setPlano] = useState('');
  const [semVenc, setSemVenc] = useState(false);
  const [vence, setVence] = useState(addDaysISO(hoje, 30));
  const [criado, setCriado] = useState<Criado | null>(null);
  const [checagem, setChecagem] = useState<{ ok: boolean; motivo?: string } | null>(null);

  useEffect(() => { if (!slugMexido) setSlug(paraSlug(nome)); }, [nome, slugMexido]);
  useEffect(() => {
    setChecagem(null);
    if (!slug) return;
    const t = setTimeout(() => { api.get<{ ok: boolean; motivo?: string }>(`/api/plataforma/slug/${encodeURIComponent(slug)}`).then(setChecagem).catch(() => undefined); }, 350);
    return () => clearTimeout(t);
  }, [slug]);

  const criar = () => run(async () => {
    const r = await api.post<Criado>('/api/plataforma/restaurantes', {
      nome: nome.trim(), slug, donoNome: donoNome.trim(), donoLogin: donoLogin.trim() || undefined, donoWhatsapp: donoWa.trim() || null,
      cardapio, mensalidadeCents: mensal ?? 0, plano: plano.trim() || null, licencaVenceEm: semVenc ? null : vence,
    });
    setCriado(r);
    qc.invalidateQueries({ queryKey: ['plataforma'] });
  });

  if (criado) {
    const a = criado.acessos;
    const texto = `${criado.empresa.nome}\nEndereço: ${criado.endereco ?? criado.empresa.slug}\nDono: login ${a.dono.login} · senha ${a.dono.senha}\nCaixa: login ${a.caixa.login} · senha ${a.caixa.senha}\nCozinha: login ${a.cozinha.login} · senha ${a.cozinha.senha}`;
    return (
      <Modal title="Restaurante criado" onClose={onClose} footer={<>
        <button className="btn" onClick={() => { navigator.clipboard?.writeText(texto).then(() => toast('Acessos copiados.', 'ok'), () => toast('Não consegui copiar: anote os acessos.', 'danger')); }}>Copiar acessos</button>
        <button className="btn primary" onClick={onClose}>Já anotei</button>
      </>}>
        <div className="col">
          <div className="problem-box small"><b>Anote agora:</b> as senhas aparecem só nesta tela (o sistema guarda apenas uma versão protegida delas).</div>
          <div className="kv"><span>Restaurante</span><span className="v">{criado.empresa.nome}</span></div>
          <div className="kv"><span>Endereço</span><span className="v">{criado.endereco ? <a href={criado.endereco} target="_blank" rel="noreferrer">{criado.endereco}</a> : criado.empresa.slug}</span></div>
          <div className="kv"><span>Cardápio</span><span className="v">{criado.produtos ? `exemplo genérico (${criado.produtos} produtos)` : 'vazio'}</span></div>
          <div className="plat-sep" />
          {(['dono', 'caixa', 'cozinha'] as const).map((k) => (
            <div key={k} className="kv"><span>{k === 'dono' ? 'Dono' : k === 'caixa' ? 'Caixa' : 'Cozinha'}</span><span className="v"><code>{a[k].login}</code> · senha <code style={{ fontSize: '1.05rem' }}>{a[k].senha}</code></span></div>
          ))}
          <div className="small faint">Seu acesso ONE UP ({a.oneup.login}) já entra neste restaurante com a sua senha de sempre.</div>
        </div>
      </Modal>
    );
  }

  const podeCriar = nome.trim().length >= 2 && donoNome.trim().length >= 2 && !!slug && checagem?.ok === true;
  return (
    <Modal wide title="Novo restaurante" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary" disabled={busy || !podeCriar} onClick={criar}>{busy ? 'Criando…' : 'Criar restaurante'}</button>
    </>}>
      <div className="grid-2 plat-form">
        <Campo label="Nome do restaurante"><input className="input" autoFocus value={nome} maxLength={60} onChange={(e) => setNome(e.target.value)} /></Campo>
        <Campo label="Endereço (subdomínio)" dica={checagem ? (checagem.ok ? <span style={{ color: 'var(--ok)' }}>✔ disponível</span> : <span style={{ color: 'var(--danger)' }}>{checagem.motivo}</span>) : 'letras minúsculas, números e hífen'}>
          <input className="input" value={slug} maxLength={40} autoCapitalize="none" onChange={(e) => { setSlugMexido(true); setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')); }} />
        </Campo>
        <Campo label="Nome do Dono"><input className="input" value={donoNome} maxLength={60} onChange={(e) => setDonoNome(e.target.value)} /></Campo>
        <Campo label="Login do Dono"><input className="input" value={donoLogin} maxLength={30} autoCapitalize="none" onChange={(e) => setDonoLogin(e.target.value.toLowerCase())} /></Campo>
        <Campo label="WhatsApp do Dono" dica="Para a cobrança da mensalidade."><input className="input" inputMode="tel" value={donoWa} placeholder="(11) 91234-5678" onChange={(e) => setDonoWa(e.target.value)} /></Campo>
        <Campo grupo label="Cardápio inicial" dica={cardapio === 'exemplo' ? 'Restaurante fictício (porções, pratos, bebidas e sobremesas) para o Dono trocar pelos dele.' : 'Em branco: o Dono cadastra ou importa por planilha.'}>
          <div className="seg"><button className={cardapio === 'exemplo' ? 'on' : ''} onClick={() => setCardapio('exemplo')}>Exemplo genérico</button><button className={cardapio === 'vazio' ? 'on' : ''} onClick={() => setCardapio('vazio')}>Vazio</button></div>
        </Campo>
        <Campo grupo label="Mensalidade"><MoneyInput value={mensal} onChange={setMensal} /></Campo>
        <Campo label="Plano"><input className="input" value={plano} maxLength={40} placeholder="Ex.: Essencial" onChange={(e) => setPlano(e.target.value)} /></Campo>
        <Campo grupo label="Primeiro vencimento" dica={semVenc ? 'Sem vencimento.' : 'Último dia válido da licença.'}>
          <input type="date" className="input" value={vence} disabled={semVenc} min={hoje} onChange={(e) => e.target.value && setVence(e.target.value)} />
          <label className="check small"><input type="checkbox" checked={semVenc} onChange={(e) => setSemVenc(e.target.checked)} />Sem vencimento</label>
        </Campo>
      </div>
      <div className="small faint" style={{ marginTop: 12 }}>Senhas do Dono, do Caixa e da Cozinha são geradas na hora e mostradas uma única vez.</div>
    </Modal>
  );
}
