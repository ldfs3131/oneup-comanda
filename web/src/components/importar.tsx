import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Badge, Modal, useAction } from './ui';

type Linha = { linha: number; produto: string; categoria: string; acao: 'criar' | 'atualizar' | 'erro'; erros: string[]; mudancas: string[]; avisos: string[] };
type Previa = { linhas: Linha[]; resumo: { criar: number; atualizar: number; semMudanca: number; erros: number } };

/** Importar produtos por planilha (CSV): modelo → prévia com erro por linha → confirmar. Nunca apaga nada. */
export function ImportarPlanilha({ onClose }: { onClose: () => void }) {
  const [csv, setCsv] = useState('');
  const [nomeArq, setNomeArq] = useState('');
  const [previa, setPrevia] = useState<Previa | null>(null);
  const [feito, setFeito] = useState<{ criados: number; atualizados: number; ignoradas: number } | null>(null);
  const { busy, run } = useAction();
  const qc = useQueryClient();
  const ler = async (f: File) => {
    const buf = await f.arrayBuffer();
    let texto = new TextDecoder('utf-8').decode(buf);
    if (texto.includes('�')) texto = new TextDecoder('windows-1252').decode(buf); // Excel antigo salva em ANSI
    setCsv(texto); setNomeArq(f.name); setPrevia(null);
  };
  if (feito) return (
    <Modal title="Planilha importada ✔" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>OK</button>}>
      <div className="col gap-lg">
        <div className="kv"><span>Produtos criados</span><span className="v">{feito.criados}</span></div>
        <div className="kv"><span>Produtos atualizados</span><span className="v">{feito.atualizados}</span></div>
        {feito.ignoradas > 0 && <div className="kv"><span>Linhas com erro (não entraram)</span><span className="v">{feito.ignoradas}</span></div>}
        <div className="small muted">Nada foi apagado. Cada mudança ficou registrada na Auditoria.</div>
      </div>
    </Modal>
  );
  return (
    <Modal wide title="Importar produtos por planilha" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Voltar</button>
      {!previa
        ? <button className="btn primary" disabled={busy || !csv.trim()} onClick={() => run(async () => { setPrevia(await api.post<Previa>('/api/importacao/produtos/previa', { csv })); })}>Ver prévia</button>
        : <button className="btn primary" disabled={busy || previa.resumo.criar + previa.resumo.atualizar === 0} onClick={() => run(async () => {
          setFeito(await api.post('/api/importacao/produtos/confirmar', { csv })); qc.invalidateQueries({ queryKey: ['menu'] }); qc.invalidateQueries({ queryKey: ['pendencias'] });
        })}>Confirmar: {previa.resumo.criar} novo(s), {previa.resumo.atualizar} atualização(ões)</button>}
    </>}>
      <div className="col gap-lg">
        <ol className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
          <li><a href="/api/importacao/produtos/modelo" download>Baixe o modelo</a> e abra no Excel ou Google Planilhas.</li>
          <li>Uma linha por produto: categoria, produto, preço, custo, estoque inicial, estoque mínimo, ativo (sim/não), envia à cozinha (sim/não).</li>
          <li>Salve como <b>CSV</b> e envie aqui. Produto com o mesmo nome é atualizado; o resto é criado. Nada é apagado.</li>
        </ol>
        <div className="row wrap">
          <label className="btn"><input type="file" accept=".csv,text/csv,text/plain" hidden onChange={(e) => e.target.files?.[0] && ler(e.target.files[0])} />Escolher arquivo CSV</label>
          {nomeArq && <span className="small">{nomeArq}</span>}
        </div>
        <details>
          <summary className="small muted">…ou cole o conteúdo da planilha</summary>
          <textarea className="input mono small" rows={6} value={csv} onChange={(e) => { setCsv(e.target.value); setPrevia(null); }} placeholder="categoria;produto;preco;custo;estoque_inicial;estoque_minimo;ativo;envia_cozinha" />
        </details>
        {previa && <>
          <div className="row wrap" style={{ gap: 8 }}>
            <Badge tone="ok">{previa.resumo.criar} novo(s)</Badge>
            <Badge tone="info">{previa.resumo.atualizar} atualização(ões)</Badge>
            {previa.resumo.semMudanca > 0 && <Badge>{previa.resumo.semMudanca} sem mudança</Badge>}
            {previa.resumo.erros > 0 && <Badge tone="danger">{previa.resumo.erros} com erro (ficam de fora)</Badge>}
          </div>
          <div className="table-wrap" style={{ maxHeight: 360 }}>
            <table className="table">
              <thead><tr><th>Linha</th><th>Produto</th><th>O que acontece</th></tr></thead>
              <tbody>
                {previa.linhas.map((l) => (
                  <tr key={l.linha}>
                    <td className="num small">{l.linha}</td>
                    <td><b>{l.produto || '—'}</b><div className="small faint">{l.categoria}</div></td>
                    <td className="small">
                      {l.acao === 'erro' ? <span className="cancel-text">✘ {l.erros.join('; ')}</span>
                        : l.acao === 'criar' ? <span>＋ Novo produto</span>
                        : l.mudancas.length ? <span>✎ {l.mudancas.join('; ')}</span> : <span className="faint">sem mudança</span>}
                      {l.avisos.length > 0 && <div className="faint">{l.avisos.join('; ')}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>}
      </div>
    </Modal>
  );
}
