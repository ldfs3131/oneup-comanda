import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../api';
import { brl, time } from '../../format';
import { Spinner } from '../../components/ui';
import { BrandLogo, usePageTitle } from '../../components/brand';

type Etapa = 'aguardando' | 'confirmado' | 'preparo' | 'pronto' | 'entregue' | 'recusado';
type Pedido = {
  numero: number; etapa: Etapa; motivo: string | null; cozinha: boolean; totalCents: number;
  horarios: { enviado: string; confirmado: string | null; preparo: string | null; pronto: string | null; entregue: string | null };
  itens: { nome: string; quantidade: number; opcoes: string[] }[];
};

/** Acompanhamento do pedido feito no cardápio digital (link com código aleatório; sem nome, telefone nem estimativa). */
export default function PedidoStatus() {
  usePageTitle('Meu pedido');
  const { token = '' } = useParams();
  const { data, error, isLoading } = useQuery({
    queryKey: ['pedido-publico', token], queryFn: () => api.get<Pedido>(`/api/public/pedido/${encodeURIComponent(token)}`),
    refetchInterval: (q) => (q.state.data && ['entregue', 'recusado'].includes(q.state.data.etapa) ? false : 8000), refetchOnWindowFocus: true, retry: 1,
  });
  const { data: menu } = useQuery({ queryKey: ['public-menu'], queryFn: () => api.get<{ name: string; config?: Record<string, any> }>('/api/public/menu'), staleTime: 60_000 });
  const logo = <div className="pub-logo-wrap"><BrandLogo className="pub-logo" height={80} logo={menu?.config?.logo ?? null} name={menu?.name} /></div>;

  if (isLoading) return <Spinner />;
  if (error || !data) return (
    <div className="pub">{logo}
      <div className="card center col gap-lg" style={{ margin: 16 }}>
        <h2>Pedido não encontrado</h2>
        <p className="muted">{(error as ApiError)?.status === 404 ? 'Confira se o link está completo.' : 'Sem conexão agora. A tela tenta de novo sozinha.'}</p>
        <a className="btn primary block" href="/cardapio">Ver o cardápio</a>
      </div>
    </div>
  );

  const passos: { id: Etapa; titulo: string; quando: string | null; texto: string }[] = [
    { id: 'aguardando', titulo: 'Aguardando confirmação', quando: data.horarios.enviado, texto: 'O caixa está conferindo o seu pedido.' },
    { id: 'confirmado', titulo: 'Confirmado', quando: data.horarios.confirmado, texto: data.cozinha ? 'Seu pedido entrou na fila da cozinha.' : 'Seu pedido foi confirmado.' },
    ...(data.cozinha ? [{ id: 'preparo' as Etapa, titulo: 'Em preparação', quando: data.horarios.preparo, texto: 'A cozinha começou a preparar.' }] : []),
    { id: 'pronto', titulo: 'Pronto para retirar', quando: data.horarios.pronto ?? data.horarios.entregue, texto: 'Pode buscar no balcão. 😋' },
  ];
  const ordem: Etapa[] = ['aguardando', 'confirmado', 'preparo', 'pronto', 'entregue'];
  const atual = data.etapa === 'entregue' ? ordem.indexOf('pronto') : ordem.indexOf(data.etapa);

  return (
    <div className="pub">
      {logo}
      <main className="pub-main" style={{ paddingBottom: 40 }}>
        <div className="card col gap-lg">
          <div className="row between wrap">
            <h2 style={{ margin: 0 }}>Pedido #{data.numero}</h2>
            <span className="num" style={{ fontWeight: 800 }}>{brl(data.totalCents)}</span>
          </div>
          {data.etapa === 'recusado' ? (
            <div className="problem-box">
              <b>Pedido não aceito.</b>{data.motivo ? <> Motivo: {data.motivo}</> : null}
              <div className="small" style={{ marginTop: 6 }}>Se quiser, fale com o caixa ou faça um novo pedido.</div>
            </div>
          ) : (
            <ol className="pedido-passos">
              {passos.map((p) => {
                const i = ordem.indexOf(p.id);
                const estado = i < atual ? 'feito' : i === atual ? 'agora' : 'depois';
                return (
                  <li key={p.id} className={estado}>
                    <span className="pedido-bolinha">{estado === 'feito' ? '✓' : ''}</span>
                    <div>
                      <div className="pedido-titulo">{p.titulo}{p.quando && estado !== 'depois' && <span className="small faint"> · {time(p.quando)}</span>}</div>
                      {estado === 'agora' && <div className="small muted">{p.texto}</div>}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          {data.etapa === 'entregue' && <div className="info-box small">Pedido entregue. Bom apetite!</div>}
          <div>
            {data.itens.map((it, i) => <div key={i} className="kv small"><span>{it.quantidade}× {it.nome}{it.opcoes.length > 0 && <span className="muted"> · {it.opcoes.join(', ')}</span>}</span></div>)}
          </div>
          <div className="small faint">Esta tela atualiza sozinha. O pagamento é feito no balcão.</div>
        </div>
        <a className="btn block lg" href="/cardapio" style={{ marginTop: 16 }}>Voltar ao cardápio</a>
      </main>
    </div>
  );
}
