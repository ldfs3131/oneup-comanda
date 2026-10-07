import { Link } from 'react-router-dom';
import { useAuth } from '../../auth';
import { BrandLogo, usePageTitle } from '../../components/brand';
import { BotaoBaixarApp, useInstalacao } from '../../components/instalar';

/** Página pública /app: os dois aplicativos do restaurante (clientes e equipe), sem loja. */
export default function AppPage() {
  usePageTitle('Aplicativo');
  const { meta } = useAuth();
  const { instalado } = useInstalacao();
  const nome = meta?.nomeApp || meta?.restaurantName || 'Restaurante';
  const icone = meta?.icone || '/comanda-icon-192.png';
  return (
    <div className="app-page">
      <header className="app-page-head">
        {meta?.logo ? <BrandLogo height={72} /> : <img src={icone} alt="" className="app-page-icone" />}
        <h1>Aplicativo {nome}</h1>
        <p className="muted">Baixe direto do navegador: sem loja, sem cadastro e sempre na versão mais nova.</p>
        {instalado && <div className="info-box small">Você já está usando o aplicativo. 👍</div>}
      </header>
      <div className="app-page-cards">
        <section className="card col gap-lg">
          <div className="row" style={{ gap: 12 }}><img src={icone} alt="" className="app-mini-icone" /><div><b>Para clientes</b><div className="small muted">Cardápio, pedido pelo celular e acompanhamento do pedido.</div></div></div>
          <a className="btn go lg block" href="/cardapio?instalar=1">📲 Baixar o app de clientes</a>
        </section>
        <section className="card col gap-lg">
          <div className="row" style={{ gap: 12 }}><img src={icone} alt="" className="app-mini-icone" /><div><b>Para quem trabalha no restaurante</b><div className="small muted">Caixa, cozinha e painel do Dono. Entra com usuário e senha (ou PIN).</div></div></div>
          <BotaoBaixarApp para="equipe" className="btn primary lg block" texto="Baixar o app do sistema" />
          <Link className="small center" to="/login">Só entrar no sistema</Link>
        </section>
      </div>
      <p className="small faint center">{meta?.product ?? 'ONE UP Comanda'}</p>
    </div>
  );
}
