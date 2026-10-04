import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../api';
import { dateOnly } from '../../../format';
import { Spinner, useToast } from '../../../components/ui';
import type { Pacote, Relatorio } from './tipos';
import {
  BarrasMesa, Cardapio, ClientesFiado, ConfiancaMetodo, Estoque, GraficoMeses, GraficoPilares, ListaAchados, MesaHero, NotaHero,
  Numeros, Plano, PlanoAnterior, Previsao, Secao, Tecnicas, VendeLucra, Destravas, brl0, copiar, nivelTxt,
} from './partes';
import '../../../styles/analise.css';

/*
 * Relatório Mensal ONE UP — versão para imprimir / salvar em PDF (estrutura fixa do Módulo I.2, numerada 1 a 13).
 * O roteiro da reunião NÃO entra no PDF (é só da ONE UP); os botões ficam fora da impressão.
 */
const STATUS_TXT: Record<string, string> = { RASCUNHO: 'Rascunho', REVISAO: 'Em revisão', FINALIZADO: 'Finalizado' };

export default function RelatorioImpressao() {
  const { mes = '' } = useParams();
  const toast = useToast();
  const { data, isLoading, error } = useQuery({ queryKey: ['analise-relatorio', mes], queryFn: () => api.get<{ restaurante: string; relatorio: Relatorio; pacote: Pacote & { congelado?: boolean } }>(`/api/oneup/analise/relatorio/${mes}`) });
  if (isLoading) return <Spinner />;
  if (error || !data) return <div className="card muted">Não foi possível carregar o relatório.</div>;
  const { pacote: p, relatorio: r, restaurante } = data;
  const copiarTexto = async (rota: string, ok: string) => { const t = await api.get<{ texto: string }>(rota); toast((await copiar(t.texto)) ? ok : 'Não deu para copiar.', 'ok'); };

  return (
    <div className="an-print">
      <div className="row wrap no-print an-print-barra" style={{ gap: 8 }}>
        <Link className="btn sm" to="/admin/oneup/analise">← Central de Análise</Link>
        <button className="btn sm primary" onClick={() => window.print()}>📄 Salvar em PDF</button>
        <button className="btn sm" onClick={() => copiarTexto(`/api/oneup/analise/relatorio/${mes}/whatsapp`, 'Resumo para WhatsApp copiado.')}>💬 Copiar resumo WhatsApp</button>
        <button className="btn sm" onClick={() => copiarTexto(`/api/oneup/analise/relatorio/${mes}/roteiro`, 'Roteiro copiado (fica fora do PDF).')}>🗒 Copiar roteiro</button>
        <span className="small muted">Situação: {STATUS_TXT[r.status]}{r.status !== 'FINALIZADO' ? ' — números ainda podem mudar até finalizar' : ''}</span>
      </div>

      <header className="an-capa">
        <img src="/oneup.png" alt="ONE UP" className="an-logo" />
        <div>
          <div className="an-capa-tit">Relatório Mensal</div>
          <div className="an-capa-sub">{restaurante} · {p.nome}{p.emCurso ? ` (parcial, até o dia ${p.diaCorte})` : ''}</div>
          <div className="small muted">{r.status === 'FINALIZADO' && r.finalizadoEm ? `Finalizado em ${dateOnly(r.finalizadoEm)}` : `Versão ${STATUS_TXT[r.status].toLowerCase()} de ${dateOnly(p.geradoEm)}`} · confiança dos dados: {nivelTxt(p.confianca.nivel)}</div>
        </div>
      </header>

      <Secao n={1} titulo="Resumo executivo"><div className="an-resumo">{p.resumo.map((f) => <p key={f}>{f}</p>)}</div></Secao>
      <div className="an-heros"><div className="card"><NotaHero p={p} /></div><div className="card"><MesaHero p={p} /></div></div>
      <Secao n={2} titulo="Nota do restaurante e os 6 pilares" sub={p.nota.regra}><div className="card"><GraficoPilares pilares={p.nota.pilares} /></div></Secao>
      <Secao n={3} titulo="Dinheiro na mesa" sub={p.dinheiroNaMesa.premissa}>
        {p.dinheiroNaMesa.itens.length ? <div className="card"><BarrasMesa itens={p.dinheiroNaMesa.itens} /></div> : <div className="card muted small">Nenhuma oportunidade em R$ com amostra suficiente.</div>}
        {p.dinheiroNaMesa.caixaItens.length > 0 && <div className="small">A recuperar/liberar (uma vez, fora da soma): {p.dinheiroNaMesa.caixaItens.map((c) => `${c.titulo} ≈ ${brl0(c.cents)}`).join(' · ')}</div>}
      </Secao>
      <Secao titulo="Indicadores do mês"><Numeros p={p} /><div className="card"><GraficoMeses serie={p.serie12} /></div></Secao>
      <Secao n={4} titulo="Os gargalos do mês" aviso={p.avisosSecoes.gargalos}><ListaAchados lista={p.gargalos} tom="neg" vazio="Nenhum gargalo com amostra suficiente." /></Secao>
      <Secao n={5} titulo="Comparativo" aviso={p.avisosSecoes.comparativo}><ListaAchados lista={p.comparativo} tom="neu" vazio="Sem mês de comparação com dados." /></Secao>
      <Secao n={6} titulo="Pontos positivos" sub="O que NÃO mexer." aviso={p.avisosSecoes.positivos}><ListaAchados lista={p.positivos} tom="pos" vazio="Nenhum ponto positivo passou na amostra mínima." /></Secao>
      <Secao n={7} titulo="Pontos negativos" aviso={p.avisosSecoes.negativos}><ListaAchados lista={p.negativos} tom="neg" vazio="Nenhum ponto negativo além dos gargalos." /></Secao>
      <Secao n={8} titulo="O que mais vende × o que mais lucra e engenharia de cardápio"><VendeLucra p={p} /><Cardapio p={p} /></Secao>
      <Secao n={9} titulo="Estoque, clientes e fiado"><Estoque e={p.estoque} /><ClientesFiado c={p.clientesFiado} /></Secao>
      <Secao titulo="O que destrava mais lucro"><Destravas d={p.destravas} /><Tecnicas t={p.tecnicas} /></Secao>
      <Secao n={10} titulo="Plano de ação de 30 dias"><Plano plano={r.status === 'FINALIZADO' || r.salvo ? r.acoes : p.plano} /></Secao>
      <Secao n={11} titulo="Resultado do plano do mês passado"><PlanoAnterior r={p.resultadoPlanoAnterior} /></Secao>
      <Secao n={12} titulo="Previsão do próximo mês, confiança e metodologia"><Previsao p={p.previsao} /><ConfiancaMetodo p={p} /></Secao>
      <Secao n={13} titulo="Parecer do consultor ONE UP"><div className="card an-parecer">{r.parecer.trim() || <span className="muted">(sem parecer)</span>}</div></Secao>
      <footer className="an-rodape small muted">ONE UP · Relatório gerado por regras sobre os registros do sistema. Sugestões de apoio à decisão; não substituem contador.</footer>
    </div>
  );
}
