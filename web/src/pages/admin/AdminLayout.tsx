import { NavLink, Outlet } from 'react-router-dom';
import { Banners, EstablishmentChip, Logo, SoundToggle, UserMenu, useSettings } from '../../components/layout';
import { useAuth } from '../../auth';

export default function AdminLayout() {
  const { data: settings } = useSettings();
  const { user } = useAuth();
  return (
    <div className="app">
      <Banners />
      <header className="topbar">
        <Logo to="/admin" />
        <div className="grow hide-mobile" style={{ fontWeight: 700, color: 'var(--muted)' }}>Painel administrativo</div>
        <EstablishmentChip hasRegister />
        <SoundToggle />
        <UserMenu />
      </header>
      <div className="admin-shell">
        <nav className="sidenav">
          <NavLink to="/admin" end>📊 Dashboard</NavLink>
          {/* Leitura dos números: serviço da ONE UP (o Dono não vê) */}
          {user?.oneup && <div className="nav-sec">ONE UP</div>}
          {settings?.insightsEnabled && <NavLink to="/admin/insights">💡 Insights</NavLink>}
          {user?.oneup && <NavLink to="/admin/oneup/base">📈 Base de comparação</NavLink>}
          {user?.oneup && <div className="sep" />}
          <NavLink to="/admin/financeiro">💵 Financeiro</NavLink>
          <NavLink to="/admin/pedidos">📋 Pedidos</NavLink>
          <NavLink to="/admin/tempo">⏱ Tempo de preparo</NavLink>
          <NavLink to="/admin/contas">🧾 Contas</NavLink>
          <NavLink to="/admin/receber">⏳ A receber</NavLink>
          <NavLink to="/admin/caixas">💰 Caixas</NavLink>
          <NavLink to="/admin/cardapio">🍢 Cardápio</NavLink>
          <NavLink to="/admin/historico">🕘 Auditoria</NavLink>
          <NavLink to="/admin/cancelamentos">✕ Cancelamentos</NavLink>
          <NavLink to="/admin/usuarios">👤 Usuários</NavLink>
          <NavLink to="/admin/configuracoes">⚙ Configurações</NavLink>
          <div className="sep" />
          <NavLink to="/caixa">▶ Operar caixa</NavLink>
          <NavLink to="/caixa/estoque">▶ Estoque</NavLink>
          <NavLink to="/cozinha">▶ Tela da cozinha</NavLink>
        </nav>
        <main className="page"><Outlet /></main>
      </div>
    </div>
  );
}
