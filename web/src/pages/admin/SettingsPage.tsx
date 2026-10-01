import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { api } from '../../api';
import { OneUpCredit, useSettings } from '../../components/layout';
import { Modal, MoneyInput, Spinner, Toggle, useAction, useToast } from '../../components/ui';
import { brl, dateTime } from '../../format';

/*
 * Configurações do ONE UP Comanda — tela GERADA pelo catálogo do servidor (/api/configuracoes).
 * Cada opção mostra: o que faz, se está no padrão, quem pode mudar, cadeado da ONE UP e histórico.
 */

type Item = {
  chave: string; secao: string; rotulo: string; ajuda: string; tipo: string; padrao: unknown; valor: unknown;
  min?: number; max?: number; maxLen?: number; minLen?: number; opcional: boolean; requer: string | null;
  quem: 'DONO' | 'ONEUP'; ehPadrao: boolean; trava: string | null; editavel: boolean;
};
type Tela = { secoes: { id: string; titulo: string; descricao: string }[]; itens: Item[] };
type Hist = { id: number; chave: string; rotulo: string; antes: unknown; depois: unknown; origem: string; criadoEm: string; usuario: string | null };
type Metodo = { id: number; code: string; name: string; active: boolean; isCash: boolean; sortOrder: number; taxaBp: number };

const fmt = (tipo: string, v: unknown) => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'object') return (v as { trava?: string }).trava ? `travado: ${(v as { trava: string }).trava}` : JSON.stringify(v);
  if (tipo === 'bool') return v ? 'Ligado' : 'Desligado';
  if (tipo === 'dinheiro') return brl(Number(v));
  if (tipo === 'percentual') return `${v}%`;
  return String(v);
};
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export default function SettingsPage() {
  const { data: settings } = useSettings();
  const qc = useQueryClient();
  const { data: tela } = useQuery({ queryKey: ['configuracoes'], queryFn: () => api.get<Tela>('/api/configuracoes') });
  const { busy, run } = useAction();
  const [busca, setBusca] = useState('');
  const [hist, setHist] = useState<string | null | undefined>(undefined); // undefined = fechado; null = tudo
  const [backup, setBackup] = useState<{ dir: string; ok: boolean; file?: string; error?: string }[] | null>(null);

  const salvar = (valores: Record<string, unknown>, msg = 'Salvo.') => run(async () => {
    const r = await api.patch<{ tela: Tela }>('/api/configuracoes', { valores });
    qc.setQueryData(['configuracoes'], r.tela);
    qc.invalidateQueries({ queryKey: ['settings'] }); qc.invalidateQueries({ queryKey: ['meta'] });
  }, msg);
  const padrao = (chaves: string[]) => run(async () => {
    const r = await api.post<{ tela: Tela }>('/api/configuracoes/padrao', { chaves });
    qc.setQueryData(['configuracoes'], r.tela);
    qc.invalidateQueries({ queryKey: ['settings'] }); qc.invalidateQueries({ queryKey: ['meta'] });
  }, 'Voltou ao padrão.');

  const filtrados = useMemo(() => {
    if (!tela) return [];
    const q = norm(busca.trim());
    return tela.itens.filter((i) => !q || norm(`${i.rotulo} ${i.ajuda}`).includes(q));
  }, [tela, busca]);

  if (!tela || !settings) return <Spinner />;
  const valorDe = (chave: string) => tela.itens.find((i) => i.chave === chave)?.valor;

  return (
    <div className="col gap-lg page narrow cfg" style={{ padding: 0 }}>
      <div className="row between wrap" style={{ gap: 12 }}>
        <div>
          <h1>Configurações</h1>
          <div className="small muted">Deixe o sistema com a cara e o jeito do seu restaurante. Toda mudança fica registrada.</div>
        </div>
        <button className="btn" onClick={() => setHist(null)}>Histórico de mudanças</button>
      </div>

      <input className="input cfg-search" placeholder="Buscar configuração (ex.: mesa, desconto, cor)…" value={busca} onChange={(e) => setBusca(e.target.value)} />

      {!busca && <nav className="cfg-nav">{tela.secoes.map((s) => <a key={s.id} href={`#sec-${s.id}`}>{s.titulo}</a>)}<a href="#sec-pagamentos">Formas de pagamento</a></nav>}

      {!busca && <Operacao busy={busy} run={run} isOpen={settings.restaurant.isOpen} qrLigado={valorDe('cardapio_digital_ligado') === true} />}

      {tela.secoes.map((sec) => {
        const itens = filtrados.filter((i) => i.secao === sec.id);
        if (!itens.length) return null;
        const resetaveis = itens.filter((i) => i.editavel && !i.ehPadrao).map((i) => i.chave);
        return (
          <section key={sec.id} id={`sec-${sec.id}`} className="card col cfg-sec">
            <div className="row between wrap" style={{ gap: 8 }}>
              <div>
                <h2>{sec.titulo}</h2>
                <div className="small muted">{sec.descricao}</div>
              </div>
              {resetaveis.length > 0 && <button className="btn sm ghost" disabled={busy} onClick={() => padrao(resetaveis)}>Voltar seção ao padrão</button>}
            </div>
            {itens.map((it) => (
              <Campo key={it.chave} it={it} busy={busy} dependeOk={!it.requer || valorDe(it.requer) === true}
                onSave={(v) => salvar({ [it.chave]: v }, `${it.rotulo}: salvo.`)}
                onPadrao={() => padrao([it.chave])} onHist={() => setHist(it.chave)} />
            ))}
          </section>
        );
      })}

      {(!busca || norm('formas de pagamento pix cartao dinheiro').includes(norm(busca))) && <FormasPagamento />}

      {settings.backupDirs.length > 0 && !busca && (
        <div className="card col gap-lg">
          <div>
            <h2>Backup (instalação própria)</h2>
            <div className="small muted">Automático a cada “Encerrar o dia”. Pastas: {settings.backupDirs.join(' · ')}</div>
          </div>
          <button className="btn" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => run(async () => { const r = await api.post<{ results: any[] }>('/api/backup'); setBackup(r.results); })}>Fazer backup agora</button>
          {backup && backup.map((b, i) => <div key={i} className={`small ${b.ok ? '' : 'cancel-text'}`}>{b.ok ? `✔ Salvo em ${b.file}` : `✘ ${b.dir}: ${b.error}`}</div>)}
        </div>
      )}

      <div className="center"><OneUpCredit version={settings.version} /></div>
      {hist !== undefined && <Historico chave={hist} onClose={() => setHist(undefined)} />}
    </div>
  );
}

/** ABERTO/FECHADO e o link do cardápio digital (estado operacional, não personalização). */
function Operacao({ busy, run, isOpen, qrLigado }: { busy: boolean; run: ReturnType<typeof useAction>['run']; isOpen: boolean; qrLigado: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [qr, setQr] = useState<string | null>(null);
  const url = `${window.location.origin}/cardapio`;
  useEffect(() => { QRCode.toDataURL(url, { width: 320, margin: 1 }).then(setQr).catch(() => setQr(null)); }, [url]);
  return (
    <div className="card col gap-lg">
      <div className="row between" style={{ gap: 16 }}>
        <div className="grow">
          <b>Estabelecimento</b>
          <div className="small muted">Mesmo botão ABERTO/FECHADO do caixa, em tempo real. Fechado: sem pedidos novos; dá para consultar e receber.</div>
        </div>
        <span className={`est-chip ${isOpen ? 'open' : 'closed'}`}><span className={`dot ${isOpen ? 'ok' : 'danger'}`} />{isOpen ? 'ABERTO' : 'FECHADO'}</span>
        <Toggle on={isOpen} disabled={busy} label="Estabelecimento" onChange={(v) => run(async () => { await api.patch('/api/settings', { isOpen: v }); qc.invalidateQueries({ queryKey: ['settings'] }); }, v ? 'Estabelecimento aberto.' : 'Estabelecimento fechado.')} />
      </div>
      {qrLigado && (
        <div className="row wrap" style={{ alignItems: 'flex-start', gap: 20 }}>
          {qr && <img src={qr} alt="QR Code do cardápio" style={{ width: 140, height: 140, borderRadius: 10, background: '#fff', padding: 6 }} />}
          <div className="col grow">
            <b>Link do seu cardápio digital</b>
            <div className="mono" style={{ wordBreak: 'break-all' }}>{url}</div>
            <div className="small muted">Imprima o QR Code nas mesas ou mande o link no WhatsApp. Todo pedido passa pela confirmação do caixa.</div>
            <div className="row wrap" style={{ gap: 8 }}>
              <a className="btn sm" href="/cardapio" target="_blank" rel="noreferrer">Ver como o cliente vê</a>
              <button className="btn sm" onClick={() => navigator.clipboard?.writeText(url).then(() => toast('Link copiado.', 'ok')).catch(() => toast('Não deu para copiar: selecione o link e copie.', 'danger'))}>Copiar link</button>
              <button className="btn sm" onClick={() => QRCode.toDataURL(url, { width: 1200, margin: 2 }).then((d) => { const a = document.createElement('a'); a.href = d; a.download = 'qrcode-cardapio.png'; a.click(); })}>Baixar QR para imprimir</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Campo({ it, busy, dependeOk, onSave, onPadrao, onHist }: {
  it: Item; busy: boolean; dependeOk: boolean; onSave: (v: unknown) => Promise<unknown>; onPadrao: () => void; onHist: () => void;
}) {
  const [draft, setDraft] = useState<unknown>(undefined);
  useEffect(() => setDraft(undefined), [it.valor]);
  const atual = draft === undefined ? it.valor : draft;
  const mudou = draft !== undefined && JSON.stringify(draft ?? null) !== JSON.stringify(it.valor ?? null);
  const bloqueado = !it.editavel || busy;
  const salvar = async () => { if (mudou) await onSave(draft === '' ? null : draft); };

  let controle: React.ReactNode;
  switch (it.tipo) {
    case 'bool':
      controle = <Toggle on={atual === true} disabled={bloqueado || (!dependeOk && atual !== true)} label={it.rotulo} onChange={(v) => onSave(v)} />;
      break;
    case 'dinheiro':
      controle = <fieldset disabled={bloqueado} className="cfg-fieldset" style={{ maxWidth: 200 }}><MoneyInput value={(atual as number | null) ?? null} onChange={(v) => setDraft(v)} /></fieldset>;
      break;
    case 'numero': case 'percentual':
      controle = <input className="input" style={{ maxWidth: 140 }} inputMode="numeric" disabled={bloqueado} value={atual == null ? '' : String(atual)}
        placeholder={it.opcional ? 'sem limite' : ''} onChange={(e) => { const t = e.target.value.replace(/\D/g, ''); setDraft(t === '' ? null : Number(t)); }} onKeyDown={(e) => e.key === 'Enter' && salvar()} />;
      break;
    case 'cor':
      controle = <CorPicker value={String(atual ?? '#FCB132')} disabled={bloqueado} onChange={setDraft} />;
      break;
    case 'texto_longo':
      controle = <textarea className="input" rows={2} disabled={bloqueado} maxLength={it.maxLen} value={String(atual ?? '')} onChange={(e) => setDraft(e.target.value)} />;
      break;
    case 'imagem':
      controle = <Imagem value={(atual as string | null) ?? null} disabled={bloqueado} onRemove={() => onSave(null)} />;
      break;
    default:
      controle = <input className="input" disabled={bloqueado} maxLength={it.maxLen} inputMode={it.tipo === 'telefone' ? 'tel' : it.tipo === 'url' ? 'url' : undefined}
        placeholder={it.tipo === 'telefone' ? '61999990000' : it.tipo === 'url' ? 'https://…' : ''} value={String(atual ?? '')}
        onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && salvar()} />;
  }

  return (
    <div className={`cfg-item${it.editavel ? '' : ' locked'}`}>
      <div className="cfg-label">
        <div className="row wrap" style={{ gap: 6 }}>
          <b>{it.rotulo}</b>
          {!it.ehPadrao && it.quem === 'DONO' && <span className="badge info">Alterado</span>}
          {it.trava && <span className="badge warn" title={it.trava}>🔒 Travado pela ONE UP</span>}
          {it.quem === 'ONEUP' && !it.trava && <span className="badge">Definido pelo plano</span>}
        </div>
        <div className="small muted">{it.ajuda}</div>
        {it.trava && <div className="small" style={{ color: 'var(--warn)' }}>Motivo: {it.trava}</div>}
        {!dependeOk && it.valor !== true && <div className="small faint">Não incluído no seu plano. Fale com a ONE UP.</div>}
      </div>
      <div className="cfg-ctrl">
        {controle}
        <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
          {mudou && <button className="btn sm primary" disabled={busy} onClick={salvar}>Salvar</button>}
          {mudou && <button className="btn sm ghost" onClick={() => setDraft(undefined)}>Desfazer</button>}
          {!mudou && it.editavel && !it.ehPadrao && <button className="btn sm ghost" disabled={busy} title={`Padrão: ${fmt(it.tipo, it.padrao)}`} onClick={onPadrao}>Padrão</button>}
          <button className="btn sm ghost" onClick={onHist} title="Histórico desta configuração">Histórico</button>
        </div>
      </div>
    </div>
  );
}

const CORES = ['#FCB132', '#F2D38A', '#8FE153', '#4FD1C5', '#6CB4F5', '#A78BFA', '#F472B6', '#F2604F', '#FB923C', '#FFFFFF'];
function CorPicker({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (v: string) => void }) {
  return (
    <div className="row wrap" style={{ gap: 6 }}>
      {CORES.map((c) => (
        <button key={c} type="button" disabled={disabled} className={`cfg-swatch${value.toUpperCase() === c ? ' on' : ''}`} style={{ background: c }} aria-label={`Cor ${c}`} onClick={() => onChange(c)} />
      ))}
      <label className="cfg-swatch custom" title="Outra cor"><input type="color" disabled={disabled} value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} /></label>
      <span className="mono small">{value.toUpperCase()}</span>
    </div>
  );
}

function Imagem({ value, disabled, onRemove }: { value: string | null; disabled: boolean; onRemove: () => void }) {
  const qc = useQueryClient();
  const { busy, run } = useAction();
  const enviar = (f: File) => run(async () => {
    const fd = new FormData(); fd.append('file', f);
    await api.upload('/api/configuracoes/logo', fd);
    qc.invalidateQueries({ queryKey: ['configuracoes'] }); qc.invalidateQueries({ queryKey: ['meta'] });
  }, 'Logotipo atualizado.');
  return (
    <div className="row wrap" style={{ gap: 10 }}>
      {value ? <img src={value} alt="Logotipo" style={{ height: 56, maxWidth: 180, objectFit: 'contain', background: 'var(--surface-2)', borderRadius: 8, padding: 4 }} /> : <span className="small faint">Sem logotipo</span>}
      <label className={`btn sm${disabled || busy ? ' disabled' : ''}`}>
        {value ? 'Trocar' : 'Enviar logotipo'}
        <input type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={disabled || busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) enviar(f); e.target.value = ''; }} />
      </label>
      {value && <button className="btn sm ghost" disabled={disabled || busy} onClick={onRemove}>Remover</button>}
    </div>
  );
}

function FormasPagamento() {
  const qc = useQueryClient();
  const { busy, run } = useAction();
  const { data } = useQuery({ queryKey: ['payment-methods-all'], queryFn: () => api.get<Metodo[]>('/api/payment-methods?todas=1') });
  const [nomes, setNomes] = useState<Record<number, string>>({});
  const [taxas, setTaxas] = useState<Record<number, string>>({});
  if (!data) return null;
  const taxaTxt = (bp: number) => (bp / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const taxaNum = (t: string) => { const v = Number(t.replace(/\s|%/g, '').replace(',', '.')); return Number.isFinite(v) && v >= 0 && v <= 20 ? v : null; };
  const patch = (id: number, body: object, msg: string) => run(async () => {
    const r = await api.patch<Metodo[]>(`/api/payment-methods/${id}`, body);
    qc.setQueryData(['payment-methods-all'], r); qc.invalidateQueries({ queryKey: ['payment-methods'] });
    setNomes((n) => { const c = { ...n }; delete c[id]; return c; });
    setTaxas((n) => { const c = { ...n }; delete c[id]; return c; });
  }, msg);
  const mover = (i: number, d: -1 | 1) => {
    const a = data[i], b = data[i + d]; if (!a || !b) return;
    run(async () => {
      await api.patch(`/api/payment-methods/${a.id}`, { sortOrder: b.sortOrder === a.sortOrder ? b.sortOrder + d : b.sortOrder });
      const r = await api.patch<Metodo[]>(`/api/payment-methods/${b.id}`, { sortOrder: a.sortOrder });
      qc.setQueryData(['payment-methods-all'], r);
    });
  };
  return (
    <section id="sec-pagamentos" className="card col cfg-sec">
      <div>
        <h2>Formas de pagamento</h2>
        <div className="small muted">Ligue as que você aceita, mude o nome e a ordem em que aparecem para o caixa. Pelo menos uma fica ligada. A <b>taxa da maquininha</b> mostra no Financeiro quanto realmente cai na conta (vale para os próximos recebimentos).</div>
      </div>
      {data.map((m, i) => (
        <div key={m.id} className="cfg-item">
          <div className="cfg-label">
            <input className="input" style={{ maxWidth: 260 }} value={nomes[m.id] ?? m.name} maxLength={30} onChange={(e) => setNomes({ ...nomes, [m.id]: e.target.value })} />
            <div className="small faint">{m.isCash ? 'Dinheiro (conta para a gaveta e o troco)' : 'Não entra na contagem da gaveta'}</div>
            {!m.isCash && (
              <label className="row small" style={{ gap: 6, marginTop: 6, alignItems: 'center' }}>
                <span className="muted">Taxa da maquininha</span>
                <input className="input num" inputMode="decimal" style={{ width: 84, padding: '4px 8px' }} value={taxas[m.id] ?? taxaTxt(m.taxaBp)}
                  aria-label={`Taxa da maquininha de ${m.name} em %`} onChange={(e) => setTaxas({ ...taxas, [m.id]: e.target.value })} />
                <span className="muted">%</span>
                {taxas[m.id] !== undefined && taxaNum(taxas[m.id]) !== m.taxaBp / 100 && (
                  <button className="btn sm primary" disabled={busy || taxaNum(taxas[m.id]) == null}
                    onClick={() => patch(m.id, { taxaPct: taxaNum(taxas[m.id]) }, `Taxa de ${m.name} salva.`)}>Salvar</button>
                )}
              </label>
            )}
          </div>
          <div className="cfg-ctrl row" style={{ gap: 6, justifyContent: 'flex-end' }}>
            {nomes[m.id] !== undefined && nomes[m.id] !== m.name && <button className="btn sm primary" disabled={busy || (nomes[m.id] ?? '').trim().length < 2} onClick={() => patch(m.id, { name: nomes[m.id].trim() }, 'Nome salvo.')}>Salvar</button>}
            <button className="btn sm ghost" disabled={busy || i === 0} onClick={() => mover(i, -1)} aria-label="Subir">↑</button>
            <button className="btn sm ghost" disabled={busy || i === data.length - 1} onClick={() => mover(i, 1)} aria-label="Descer">↓</button>
            <Toggle on={m.active} disabled={busy} label={m.name} onChange={(v) => patch(m.id, { active: v }, v ? `${m.name} ligado.` : `${m.name} desligado.`)} />
          </div>
        </div>
      ))}
    </section>
  );
}

function Historico({ chave, onClose }: { chave: string | null; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ['configuracoes-hist', chave], queryFn: () => api.get<Hist[]>(`/api/configuracoes/historico${chave ? `?chave=${encodeURIComponent(chave)}` : ''}`) });
  const { data: tela } = useQuery<Tela>({ queryKey: ['configuracoes'] });
  const tipo = (c: string) => tela?.itens.find((i) => i.chave === c)?.tipo ?? 'texto';
  return (
    <Modal title={chave ? `Histórico: ${data?.[0]?.rotulo ?? tela?.itens.find((i) => i.chave === chave)?.rotulo ?? chave}` : 'Histórico de mudanças'} onClose={onClose} wide>
      {!data ? <Spinner /> : !data.length ? <p className="muted">Nenhuma mudança registrada ainda.</p> : (
        <table className="table">
          <thead><tr><th>Quando</th>{!chave && <th>Configuração</th>}<th>Antes</th><th>Depois</th><th>Quem</th></tr></thead>
          <tbody>{data.map((h) => (
            <tr key={h.id}>
              <td className="num small">{dateTime(h.criadoEm)}</td>
              {!chave && <td>{h.rotulo}</td>}
              <td className="small muted">{fmt(tipo(h.chave), h.antes)}</td>
              <td className="small">{fmt(tipo(h.chave), h.depois)}</td>
              <td className="small">{h.origem === 'ONEUP' ? 'ONE UP' : h.origem === 'PADRAO' ? `${h.usuario ?? '—'} (padrão)` : h.usuario ?? '—'}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </Modal>
  );
}
