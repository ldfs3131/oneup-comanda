import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { Spinner } from '../../components/ui';
import { BrandLogo, usePageTitle } from '../../components/brand';
import '../../styles/clientes.css';

type Politica = { titulo: string; restaurante: string; whatsapp: string | null; secoes: { titulo: string; texto: string }[] };

/** Política de privacidade de 1 página, com o nome e o WhatsApp do restaurante (o responsável pelos dados). */
export default function Privacidade() {
  usePageTitle('Privacidade');
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ['privacidade'], queryFn: () => api.get<Politica>('/api/public/privacidade'), staleTime: 300_000 });
  const { data: menu } = useQuery({ queryKey: ['public-menu'], queryFn: () => api.get<{ name: string; config?: Record<string, any> }>('/api/public/menu'), staleTime: 60_000 });
  if (isLoading) return <Spinner />;
  if (isError || !data) return (
    <div className="pub"><div className="card center col gap-lg" style={{ margin: 16 }}>
      <h2>Não foi possível carregar</h2>
      <button className="btn" onClick={() => refetch()}>Tentar de novo</button>
    </div></div>
  );
  return (
    <div className="pub">
      <div className="pub-logo-wrap"><BrandLogo className="pub-logo" height={72} logo={menu?.config?.logo ?? null} name={menu?.name ?? data.restaurante} /></div>
      <main className="privacidade">
        <h1>Privacidade e seus dados</h1>
        <p className="muted">{data.restaurante}</p>
        {data.secoes.map((s) => (
          <section key={s.titulo}>
            <h2>{s.titulo}</h2>
            <p>{s.texto}</p>
          </section>
        ))}
        <div className="rodape row wrap" style={{ gap: 8 }}>
          {data.whatsapp && <a className="btn go" href={`https://wa.me/55${data.whatsapp.replace(/\D/g, '')}`} target="_blank" rel="noreferrer">💬 Falar com o restaurante</a>}
          <a className="btn" href="/cardapio">Voltar ao cardápio</a>
        </div>
      </main>
    </div>
  );
}
