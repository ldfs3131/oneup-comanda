import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { brl, dateOnly, dateTime } from '../../format';
import { Badge, ConfirmModal, Modal, Spinner, useAction } from '../../components/ui';
import '../../styles/clientes.css';

export type Cliente = {
  id: number; nome: string; telefone: string | null; contato: string | null;
  aceitaOfertas: boolean; aceiteEm: string | null; textoDoAceite: string | null; ofertasRevogadasEm: string | null;
  cadastradoEm: string; contas: number; ultimoPedido: string | null; aReceberCents: number; contasAbertas: number;
};

/**
 * Clientes (LGPD): o restaurante é o responsável pelos dados. Aqui o Dono atende os pedidos dos clientes:
 * corrigir, parar ofertas, juntar cadastros duplicados, apagar dados e exportar.
 */
export default function Clientes() {
  const [busca, setBusca] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => { const t = setTimeout(() => setQ(busca.trim()), 300); return () => clearTimeout(t); }, [busca]);
  const curta = q.length > 0 && q.length < 3;
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['clientes', curta ? '' : q],
    queryFn: () => api.get<Cliente[]>(`/api/clientes${!curta && q ? `?q=${encodeURIComponent(q)}` : ''}`),
  });
  const [aberto, setAberto] = useState<Cliente | null>(null);
  const [marcados, setMarcados] = useState<number[]>([]);
  const [juntar, setJuntar] = useState(false);
  const lista = data ?? [];
  const marcar = (id: number) => setMarcados((m) => m.includes(id) ? m.filter((x) => x !== id) : [...m.slice(-1), id]);
  const doisMarcados = lista.filter((c) => marcados.includes(c.id));

  return (
    <div className="col gap-lg">
      <div>
        <h1>Clientes</h1>
        <div className="muted small">O restaurante é o responsável pelos dados dos clientes. Se alguém pedir para corrigir, parar as ofertas, ver ou apagar os próprios dados, é por aqui.</div>
      </div>
      <div className="row wrap" style={{ gap: 8 }}>
        <label className="field grow" style={{ minWidth: 220 }}>
          <span>Buscar por nome, telefone ou casa</span>
          <input className="input" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Digite pelo menos 3 letras ou números" maxLength={60} inputMode="search" />
        </label>
        {doisMarcados.length === 2 && <button className="btn primary" style={{ alignSelf: 'flex-end' }} onClick={() => setJuntar(true)}>Juntar os 2 marcados</button>}
      </div>
      {curta && <div className="small muted">Digite pelo menos 3 letras para buscar.</div>}
      {isLoading ? <Spinner /> : isError ? (
        <div className="card empty">Não foi possível carregar. <button className="btn sm" onClick={() => refetch()}>Tentar de novo</button></div>
      ) : lista.length === 0 ? (
        <div className="card empty">{q && !curta ? 'Nenhum cliente encontrado.' : 'Nenhum cliente cadastrado ainda.'}</div>
      ) : (
        <div className="card tight">
          {!q && <div className="small muted" style={{ marginBottom: 8 }}>Os 100 com pedido mais recente. Use a busca para achar os outros. Marque 2 cadastros da mesma pessoa para juntar.</div>}
          <div className="table-wrap">
            <table className="table clientes-tabela">
              <thead><tr>
                <th aria-label="Marcar para juntar" />
                <th>Cliente</th><th>Telefone</th><th className="num">Contas</th><th>Último pedido</th><th>Ofertas</th><th className="num">A receber</th><th />
              </tr></thead>
              <tbody>
                {lista.map((c) => (
                  <tr key={c.id}>
                    <td><input type="checkbox" className="chk-juntar" aria-label={`Marcar ${c.nome} para juntar`} checked={marcados.includes(c.id)} onChange={() => marcar(c.id)} /></td>
                    <td><b>{c.nome}</b>{c.contato && <div className="small muted">{c.contato}</div>}<div className="small faint">#{c.id}</div></td>
                    <td className="nowrap" data-label="Telefone">{c.telefone ?? '—'}</td>
                    <td className="num" data-label="Contas">{c.contas}</td>
                    <td className="nowrap" data-label="Último pedido">{c.ultimoPedido ? dateOnly(c.ultimoPedido) : '—'}</td>
                    <td data-label="Ofertas"><Ofertas c={c} /></td>
                    <td className={`num nowrap${c.aReceberCents > 0 ? '' : ' vazio'}`} data-label="A receber">{c.aReceberCents > 0 ? <b>{brl(c.aReceberCents)}</b> : '—'}</td>
                    <td><button className="btn sm" onClick={() => setAberto(c)}>Abrir</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {aberto && <ClienteModal c={aberto} onClose={() => setAberto(null)} />}
      {juntar && doisMarcados.length === 2 && <JuntarModal par={doisMarcados as [Cliente, Cliente]} onClose={() => setJuntar(false)} onDone={() => setMarcados([])} />}
    </div>
  );
}

function Ofertas({ c }: { c: Cliente }) {
  if (c.aceitaOfertas) return <span title={c.textoDoAceite ?? ''}><Badge tone="ok">Aceita</Badge>{c.aceiteEm && <div className="small faint">desde {dateOnly(c.aceiteEm)}</div>}</span>;
  if (c.ofertasRevogadasEm) return <span><Badge>Parou</Badge><div className="small faint">em {dateOnly(c.ofertasRevogadasEm)}</div></span>;
  return <span className="small muted">Não</span>;
}

function useRecarregar() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['clientes'] });
}

function ClienteModal({ c, onClose }: { c: Cliente; onClose: () => void }) {
  const { busy, run } = useAction();
  const recarregar = useRecarregar();
  const [editar, setEditar] = useState(false);
  const [nome, setNome] = useState(c.nome);
  const [telefone, setTelefone] = useState(c.telefone ?? '');
  const [contato, setContato] = useState(c.contato ?? '');
  const [parar, setParar] = useState(false);
  const [apagar, setApagar] = useState(false);

  const salvar = () => run(async () => {
    await api.patch(`/api/clientes/${c.id}`, { nome, telefone: telefone.trim() || null, contato: contato.trim() || null });
    recarregar(); onClose();
  }, 'Cliente corrigido.');

  return (
    <Modal title={`Cliente #${c.id}`} onClose={onClose} wide>
      {editar ? (
        <div className="col" style={{ gap: 10 }}>
          <label className="field"><span>Nome</span><input className="input" value={nome} onChange={(e) => setNome(e.target.value)} maxLength={80} autoFocus /></label>
          <label className="field"><span>Telefone (com DDD)</span><input className="input" inputMode="tel" value={telefone} onChange={(e) => setTelefone(e.target.value)} maxLength={30} placeholder="(61) 99999-1111" /></label>
          <label className="field"><span>Casa / apartamento / outro contato</span><input className="input" value={contato} onChange={(e) => setContato(e.target.value)} maxLength={120} /></label>
          <div className="small muted">O telefone identifica o cliente: se ele já for de outro cadastro, use “Juntar” na lista.</div>
          <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setEditar(false)}>Voltar</button>
            <button className="btn primary" disabled={busy || nome.trim().length < 2} onClick={salvar}>Salvar correção</button>
          </div>
        </div>
      ) : (
        <div className="col" style={{ gap: 12 }}>
          <div>
            <div className="kv"><span>Nome</span><span className="v">{c.nome}</span></div>
            <div className="kv"><span>Telefone</span><span className="v">{c.telefone ?? '—'}</span></div>
            <div className="kv"><span>Casa / contato</span><span className="v">{c.contato ?? '—'}</span></div>
            <div className="kv"><span>Contas</span><span className="v">{c.contas}{c.contasAbertas ? ` (${c.contasAbertas} aberta/a receber)` : ''}</span></div>
            <div className="kv"><span>Último pedido</span><span className="v">{c.ultimoPedido ? dateTime(c.ultimoPedido) : '—'}</span></div>
            <div className="kv"><span>A receber</span><span className="v">{brl(c.aReceberCents)}</span></div>
            <div className="kv"><span>Cadastrado em</span><span className="v">{dateOnly(c.cadastradoEm)}</span></div>
          </div>
          <div className="card tight" style={{ background: 'var(--surface-2)' }}>
            <div className="panel-title" style={{ marginBottom: 6 }}>Ofertas pelo WhatsApp</div>
            {c.aceitaOfertas ? <>
              <div>Aceitou em <b>{c.aceiteEm ? dateTime(c.aceiteEm) : '—'}</b> com o texto:</div>
              <div className="small muted" style={{ marginTop: 4 }}>“{c.textoDoAceite ?? '—'}”</div>
            </> : c.ofertasRevogadasEm ? <div>Pediu para parar em <b>{dateTime(c.ofertasRevogadasEm)}</b>. Não enviar ofertas.</div>
              : <div className="muted">Não aceitou receber ofertas. Não enviar.</div>}
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <button className="btn" onClick={() => setEditar(true)}>Corrigir nome/telefone</button>
            {c.aceitaOfertas && <button className="btn" onClick={() => setParar(true)}>Parar ofertas</button>}
            <a className="btn" href={`/api/clientes/${c.id}/exportar?formato=csv`} download={`cliente-${c.id}.csv`}>Exportar dados (planilha)</a>
            <a className="btn ghost" href={`/api/clientes/${c.id}/exportar?formato=json`} download={`cliente-${c.id}.json`}>Exportar (JSON)</a>
          </div>
          <div className="card tight" style={{ borderColor: 'var(--danger)' }}>
            <div className="row between wrap" style={{ gap: 8 }}>
              <div className="small" style={{ flex: '1 1 260px' }}><b>Apagar dados</b><br />
                <span className="muted">Tira nome, telefone e casa do cliente e das contas já encerradas. As vendas continuam no caixa e no financeiro, sem identificar a pessoa. Não dá para desfazer.</span>
                {c.contasAbertas > 0 && <div style={{ color: 'var(--danger)', marginTop: 4 }}>Tem conta aberta ou a receber: só dá para apagar depois que ela for paga/encerrada.</div>}
              </div>
              <button className="btn danger" disabled={c.contasAbertas > 0} onClick={() => setApagar(true)}>Apagar dados</button>
            </div>
          </div>
        </div>
      )}
      {parar && <ConfirmModal title="Parar ofertas" confirmLabel="Parar ofertas" onClose={() => setParar(false)}
        onConfirm={() => run(async () => { await api.post(`/api/clientes/${c.id}/parar-ofertas`); recarregar(); onClose(); }, 'Ofertas paradas para este cliente.')}>
        <p>O cliente não vai mais aparecer como “aceita ofertas”. Fica registrado quando e quem fez.</p>
      </ConfirmModal>}
      {apagar && <ConfirmModal title="Apagar os dados deste cliente?" confirmLabel="Apagar dados" tone="danger" onClose={() => setApagar(false)}
        onConfirm={() => run(async () => { await api.post(`/api/clientes/${c.id}/apagar`); recarregar(); onClose(); }, 'Dados apagados. As vendas continuam.')}>
        <p>Nome, telefone e casa de <b>{c.nome}</b> serão apagados do cadastro e das {c.contas} conta(s) encerradas. As vendas continuam. <b>Não dá para desfazer.</b></p>
        <p className="small muted">Dica: se o cliente pediu uma cópia dos dados, exporte antes de apagar.</p>
      </ConfirmModal>}
    </Modal>
  );
}

function JuntarModal({ par, onClose, onDone }: { par: [Cliente, Cliente]; onClose: () => void; onDone: () => void }) {
  const [fica, setFica] = useState(par[0].contas >= par[1].contas ? par[0].id : par[1].id);
  const { busy, run } = useAction();
  const recarregar = useRecarregar();
  const sai = par.find((c) => c.id !== fica)!;
  return (
    <Modal title="Juntar cadastros da mesma pessoa" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      <button className="btn primary" disabled={busy} onClick={() => run(async () => {
        await api.post(`/api/clientes/${fica}/juntar`, { outroId: sai.id }); recarregar(); onDone(); onClose();
      }, 'Cadastros juntados.')}>Juntar</button>
    </>}>
      <p className="small muted">Escolha qual cadastro fica. As contas do outro passam para ele, e o outro some da lista.</p>
      <div className="col" style={{ gap: 8 }}>
        {par.map((c) => (
          <label key={c.id} className={`card tight check${fica === c.id ? ' on' : ''}`} style={{ alignItems: 'flex-start' }}>
            <input type="radio" name="fica" checked={fica === c.id} onChange={() => setFica(c.id)} />
            <span><b>{c.nome}</b> <span className="small faint">#{c.id}</span><br />
              <span className="small muted">{[c.telefone, c.contato].filter(Boolean).join(' · ') || 'sem telefone'} · {c.contas} conta(s){c.ultimoPedido ? ` · último ${dateOnly(c.ultimoPedido)}` : ''}</span></span>
          </label>
        ))}
      </div>
    </Modal>
  );
}
