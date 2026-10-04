import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../../../api';
import { dateTime } from '../../../format';
import { Spinner, useAction, useToast } from '../../../components/ui';
import { InsightCard } from '../../../components/insights';
import type { InsightsResult } from '../../../types';
import RitmoMes from '../RitmoMes';
import type { AcaoPlano, RespostaAnalise } from './tipos';
import {
  BarrasMesa, Cardapio, ClientesFiado, ConfBadge, ConfiancaMetodo, Destravas, Estoque, GraficoMeses, GraficoPilares, ListaAchados,
  MesaHero, NotaHero, Numeros, Plano, PlanoAnterior, Previsao, Secao, Tecnicas, VendeLucra, brl0, copiar,
} from './partes';
import '../../../styles/analise.css';

/*
 * CENTRAL DE ANÁLISE (só a ONE UP). Seções na ordem do Relatório Mensal (Módulo I.2), em abas para caber no celular.
 * Tudo é calculado por regra no servidor; aqui só se mostra e se edita o parecer e as ações.
 */
const ABAS = [
  { id: 'geral', rot: 'Visão geral' }, { id: 'diagnostico', rot: 'Diagnóstico' }, { id: 'acao', rot: 'O que fazer' },
  { id: 'cardapio', rot: 'Cardápio' }, { id: 'estoque', rot: 'Estoque' }, { id: 'clientes', rot: 'Clientes e fiado' },
  { id: 'ritmo', rot: 'Ritmo do mês' }, { id: 'hoje', rot: 'Leituras do dia' }, { id: 'relatorio', rot: 'Relatório' }, { id: 'metodo', rot: 'Confiança' },
] as const;
type Aba = typeof ABAS[number]['id'];
const STATUS_TXT: Record<string, string> = { RASCUNHO: 'Rascunho', REVISAO: 'Em revisão', FINALIZADO: 'Finalizado' };

export default function CentralAnalise() {
  // mês escolhido; até a lista chegar, o mês atual do servidor (primeiro da lista)
  const [escolhido, setMes] = useState<string | null>(null);
  const [aba, setAba] = useState<Aba>(() => { try { return (localStorage.getItem('oneup:analise:aba') as Aba) || 'geral'; } catch { return 'geral'; } });
  useEffect(() => { try { localStorage.setItem('oneup:analise:aba', aba); } catch { /* sem armazenamento */ } }, [aba]);
  const { data: meses } = useQuery({ queryKey: ['analise-meses'], queryFn: () => api.get<{ meses: { mes: string; nome: string; status: string | null }[] }>('/api/oneup/analise/meses') });
  const mes = escolhido ?? meses?.meses[0]?.mes ?? null;
  const { data, isLoading, error } = useQuery({ queryKey: ['analise', mes], queryFn: () => api.get<RespostaAnalise>(`/api/oneup/analise${qs({ mes })}`), staleTime: 60_000, enabled: !!mes });

  return (
    <div className="col gap-lg an-central">
      <div className="row between wrap" style={{ gap: 12 }}>
        <div>
          <h1>📊 Central de Análise</h1>
          <div className="small muted">Só a ONE UP vê. Números e leituras calculados por regra a partir dos registros do sistema — sem IA.</div>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <select className="input" style={{ width: 220 }} value={mes ?? ''} onChange={(e) => setMes(e.target.value)} aria-label="Mês">
            {(meses?.meses ?? []).map((m) => <option key={m.mes} value={m.mes}>{m.nome}{m.status ? ` · ${STATUS_TXT[m.status]}` : ''}</option>)}
          </select>
          {mes && <Link className="btn" to={`/admin/oneup/analise/relatorio/${mes}`}>🖨 Relatório (PDF)</Link>}
        </div>
      </div>

      <nav className="an-abas" role="tablist" aria-label="Seções da análise">
        {ABAS.map((a) => <button key={a.id} role="tab" aria-selected={aba === a.id} className={aba === a.id ? 'on' : ''} onClick={() => setAba(a.id)}>{a.rot}</button>)}
      </nav>

      {!mes || isLoading ? <Spinner /> : error || !data ? <div className="card muted">Não foi possível carregar a análise deste mês.</div> : <Conteudo p={data} aba={aba} />}
    </div>
  );
}

function Conteudo({ p, aba }: { p: RespostaAnalise; aba: Aba }) {
  const cab = (
    <div className="row wrap small muted" style={{ gap: 8 }}>
      <span>{p.nome}{p.emCurso ? ` · parcial até o dia ${p.diaCorte}` : ''}</span>
      <ConfBadge c={p.confianca.nivel} />
      {p.congelado && <span className="badge brand">retrato congelado (finalizado)</span>}
      <span className="faint">calculado {dateTime(p.geradoEm)}</span>
    </div>
  );
  return (
    <div className="col gap-lg">
      {cab}
      {p.confianca.aviso && <div className="info-box small">ⓘ {p.confianca.aviso}</div>}
      {aba === 'geral' && <>
        <Secao n={1} titulo="Resumo executivo"><div className="card an-resumo">{p.resumo.map((f) => <p key={f}>{f}</p>)}</div></Secao>
        <div className="an-heros"><div className="card"><NotaHero p={p} /></div><div className="card"><MesaHero p={p} /></div></div>
        <Secao n={2} titulo="Nota do restaurante e os 6 pilares" sub={p.nota.regra}><div className="card"><GraficoPilares pilares={p.nota.pilares} /></div></Secao>
        <Secao n={3} titulo="Dinheiro na mesa" sub={p.dinheiroNaMesa.premissa}>
          {p.dinheiroNaMesa.itens.length ? <div className="card"><BarrasMesa itens={p.dinheiroNaMesa.itens} /></div> : <div className="card muted small">Nenhuma oportunidade em R$ com amostra suficiente.</div>}
          {p.dinheiroNaMesa.caixaItens.length > 0 && <div className="card small"><b>A recuperar ou liberar (uma vez, fora da soma):</b><ul className="an-lista">{p.dinheiroNaMesa.caixaItens.map((c) => <li key={c.id}>{c.titulo}: ≈ {brl0(c.cents)} — {c.premissa}</li>)}</ul></div>}
        </Secao>
        <Secao titulo="Indicadores do mês"><Numeros p={p} /></Secao>
        <Secao titulo="Últimos 12 meses"><div className="card"><GraficoMeses serie={p.serie12} /></div></Secao>
        <Secao n={12} titulo="Previsão do próximo mês"><Previsao p={p.previsao} /></Secao>
      </>}
      {aba === 'diagnostico' && <>
        <Secao n={4} titulo="Os gargalos do mês" sub="Onde o lucro está sendo perdido ou travado agora — ranqueados por impacto × confiança." aviso={p.avisosSecoes.gargalos}><ListaAchados lista={p.gargalos} tom="neg" vazio="Nenhum gargalo com amostra suficiente." /></Secao>
        <Secao n={5} titulo="Comparativo" sub="As maiores mudanças vs mês anterior, média de 3 meses e mesmo mês do ano anterior (quando existe)." aviso={p.avisosSecoes.comparativo}><ListaAchados lista={p.comparativo} tom="neu" vazio="Sem mês de comparação com dados." /></Secao>
        <Secao n={6} titulo="Pontos positivos" sub="O que está bem — o que NÃO mexer." aviso={p.avisosSecoes.positivos}><ListaAchados lista={p.positivos} tom="pos" vazio="Nenhum ponto positivo passou na amostra mínima." /></Secao>
        <Secao n={7} titulo="Pontos negativos" sub="Sinais de alerta que ainda não viraram gargalo." aviso={p.avisosSecoes.negativos}><ListaAchados lista={p.negativos} tom="neg" vazio="Nenhum ponto negativo além dos gargalos." /></Secao>
      </>}
      {aba === 'acao' && <>
        <Secao titulo="Destravas: o que destrava mais lucro em cada horizonte"><Destravas d={p.destravas} /></Secao>
        <Secao titulo="Técnicas de gestão indicadas" sub="Cada técnica aparece ligada ao achado que a justifica."><Tecnicas t={p.tecnicas} /></Secao>
        <Secao n={10} titulo="Plano de ação de 30 dias" sub="No máximo 5 ações, semana a semana, com meta mensurável."><Plano plano={p.plano} /></Secao>
        <Secao n={11} titulo="Resultado do plano do mês passado"><PlanoAnterior r={p.resultadoPlanoAnterior} /></Secao>
      </>}
      {aba === 'cardapio' && <>
        <Secao n={8} titulo="O que mais vende × o que mais lucra"><VendeLucra p={p} /></Secao>
        <Secao titulo="Engenharia de cardápio"><Cardapio p={p} /></Secao>
      </>}
      {aba === 'estoque' && <Secao n={9} titulo="Estoque"><Estoque e={p.estoque} /></Secao>}
      {aba === 'clientes' && <Secao n={9} titulo="Clientes e fiado"><ClientesFiado c={p.clientesFiado} /></Secao>}
      {aba === 'ritmo' && <Secao titulo="Ritmo do mês" sub="Receita acumulada dia a dia comparada com os meses anteriores no mesmo dia."><RitmoMes mes={p.mes} /></Secao>}
      {aba === 'hoje' && <LeiturasDoDia emCurso={p.emCurso} />}
      {aba === 'relatorio' && <PainelRelatorio p={p} />}
      {aba === 'metodo' && <Secao n={12} titulo="Confiança dos dados e metodologia"><ConfiancaMetodo p={p} detalhes /></Secao>}
    </div>
  );
}

/** Leituras automáticas do dia (os insights por regra da versão 2). */
function LeiturasDoDia({ emCurso }: { emCurso: boolean }) {
  const { data, isLoading } = useQuery({ queryKey: ['insights'], queryFn: () => api.get<InsightsResult>('/api/insights'), refetchInterval: 5 * 60_000 });
  if (isLoading || !data) return <Spinner />;
  return (
    <Secao titulo="Leituras do dia" sub={`${data.message}${emCurso ? '' : ' (sempre do dia de hoje, independente do mês escolhido)'}`}>
      {data.all.length === 0 ? <div className="card muted small">Nada fora do padrão para destacar agora.</div>
        : <div className="insight-grid">{data.all.map((i) => <InsightCard key={i.key} i={i} />)}</div>}
    </Secao>
  );
}

/** Parecer, ações (feito/não feito), situação do relatório e textos prontos (WhatsApp e roteiro). */
function PainelRelatorio({ p }: { p: RespostaAnalise }) {
  const r = p.relatorio;
  const [parecer, setParecer] = useState(r.parecer);
  const [acoes, setAcoes] = useState<AcaoPlano[]>(r.acoes);
  useEffect(() => { setParecer(r.parecer); setAcoes(r.acoes); }, [r.mes, r.atualizadoEm, r.status]);
  const { busy, run } = useAction();
  const toast = useToast();
  const qc = useQueryClient();
  const travado = r.status === 'FINALIZADO';
  const { data: roteiro } = useQuery({ queryKey: ['analise-roteiro', p.mes, p.geradoEm], queryFn: () => api.get<{ texto: string }>(`/api/oneup/analise/relatorio/${p.mes}/roteiro`) });
  const recarregar = () => { qc.invalidateQueries({ queryKey: ['analise', p.mes] }); qc.invalidateQueries({ queryKey: ['analise-meses'] }); };
  const salvar = () => run(async () => { await api.put(`/api/oneup/analise/relatorio/${p.mes}`, { parecer, acoes }); recarregar(); }, 'Relatório salvo.');
  const mudar = (status: string) => run(async () => {
    if (!travado) await api.put(`/api/oneup/analise/relatorio/${p.mes}`, { parecer, acoes });
    await api.post(`/api/oneup/analise/relatorio/${p.mes}/status`, { status }); recarregar();
  }, status === 'FINALIZADO' ? 'Relatório finalizado: os números ficaram congelados.' : 'Situação atualizada.');
  const copiarWhats = async () => { const t = await api.get<{ texto: string }>(`/api/oneup/analise/relatorio/${p.mes}/whatsapp`); toast((await copiar(t.texto)) ? 'Resumo para WhatsApp copiado.' : 'Não deu para copiar.', 'ok'); };
  const copiarRoteiro = async () => { if (roteiro) toast((await copiar(roteiro.texto)) ? 'Roteiro copiado.' : 'Não deu para copiar.', 'ok'); };

  return (
    <div className="col gap-lg">
      <Secao titulo="Relatório mensal" sub="Rascunho → em revisão → finalizado. Ao finalizar, os números ficam congelados e nada mais muda.">
        <div className="card col">
          <div className="row wrap" style={{ gap: 8 }}>
            <span>Situação: <b>{STATUS_TXT[r.status]}</b>{!r.salvo && <span className="small faint"> (ainda não salvo)</span>}</span>
            {r.status === 'RASCUNHO' && <button className="btn sm" disabled={busy} onClick={() => mudar('REVISAO')}>Enviar para revisão</button>}
            {r.status === 'REVISAO' && <>
              <button className="btn sm" disabled={busy} onClick={() => mudar('RASCUNHO')}>Voltar para rascunho</button>
              <button className="btn sm primary" disabled={busy || p.emCurso} title={p.emCurso ? 'Só dá para finalizar um mês encerrado' : ''} onClick={() => mudar('FINALIZADO')}>Finalizar e congelar</button>
            </>}
            {p.emCurso && r.status !== 'FINALIZADO' && <span className="small faint">Mês em andamento: dá para finalizar depois que ele terminar.</span>}
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <Link className="btn sm" to={`/admin/oneup/analise/relatorio/${p.mes}`}>🖨 Versão para imprimir / PDF</Link>
            <button className="btn sm" onClick={copiarWhats}>💬 Copiar resumo WhatsApp</button>
            <button className="btn sm" onClick={copiarRoteiro} disabled={!roteiro}>🗒 Copiar roteiro da reunião</button>
          </div>
        </div>
      </Secao>
      <Secao n={13} titulo="Meu parecer">
        <textarea className="input" rows={7} value={parecer} onChange={(e) => setParecer(e.target.value)} disabled={travado} maxLength={8000} placeholder="Leitura do consultor: contexto, prioridades, o que conversar com o Dono…" />
      </Secao>
      <Secao titulo="Ações aprovadas (acompanhamento)" sub="O efeito de cada ação é medido automaticamente no relatório do mês seguinte.">
        {acoes.length === 0 ? <div className="card muted small">Sem ações neste mês.</div> : (
          <div className="col">{acoes.map((a, i) => (
            <div key={a.id} className="card tight row wrap" style={{ gap: 10 }}>
              <span className="badge">sem. {a.semana}</span>
              <div className="grow"><div>{a.texto}</div><div className="small muted">Meta: {a.meta}</div></div>
              <div className="seg" role="radiogroup" aria-label="Situação da ação">
                {(['PENDENTE', 'FEITO', 'NAO_FEITO'] as const).map((s) => (
                  <button key={s} role="radio" aria-checked={a.status === s} className={a.status === s ? 'on' : ''} disabled={travado}
                    onClick={() => setAcoes((l) => l.map((x, j) => (j === i ? { ...x, status: s } : x)))}>{s === 'PENDENTE' ? 'Pendente' : s === 'FEITO' ? 'Feito' : 'Não feito'}</button>
                ))}
              </div>
            </div>
          ))}</div>
        )}
        {!travado && <div><button className="btn primary" disabled={busy} onClick={salvar}>Salvar parecer e ações</button></div>}
      </Secao>
      {roteiro && <Secao titulo="Roteiro da reunião (só para você)"><pre className="card an-roteiro">{roteiro.texto}</pre></Secao>}
    </div>
  );
}
