import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { homeFor, useAuth } from './auth';
import { Spinner } from './components/ui';
import type { Role } from './types';
import Login from './pages/Login';
import CashierLayout from './pages/caixa/CashierLayout';
import Board from './pages/caixa/Board';
import NewAccount from './pages/caixa/NewAccount';
import AccountPage from './pages/caixa/AccountPage';
import Receivables from './pages/caixa/Receivables';
import RegisterPage from './pages/caixa/RegisterPage';
import Availability from './pages/caixa/Availability';
import OrdersToday from './pages/caixa/OrdersToday';
import StockPage from './pages/caixa/StockPage';
import Kitchen from './pages/cozinha/Kitchen';
import AdminLayout from './pages/admin/AdminLayout';
import Dashboard from './pages/admin/Dashboard';
import Accounts from './pages/admin/Accounts';
import MenuAdmin from './pages/admin/MenuAdmin';
import Users from './pages/admin/Users';
import Registers from './pages/admin/Registers';
import Audit from './pages/admin/Audit';
import Cancellations from './pages/admin/Cancellations';
import SettingsPage from './pages/admin/SettingsPage';
import PublicMenu from './pages/public/PublicMenu';
import InsightsPage from './pages/admin/InsightsPage';
import FinancePage from './pages/admin/FinancePage';
import TimingPage from './pages/admin/TimingPage';
import OrdersHistory from './pages/admin/OrdersHistory';
import { ThemeApplier } from './components/brand';

function Guard({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Spinner />;
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (user.role !== 'ADMIN' && !roles.includes(user.role)) return <Navigate to={homeFor(user.role)} replace />;
  return <>{children}</>;
}

function Home() {
  const { user, loading } = useAuth();
  if (loading) return <Spinner />;
  return <Navigate to={user ? homeFor(user.role) : '/login'} replace />;
}

export default function App() {
  return (
    <>
    <ThemeApplier />
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route path="/cardapio" element={<PublicMenu />} />
      <Route path="/cozinha" element={<Guard roles={['COZINHA']}><Kitchen /></Guard>} />
      <Route path="/caixa" element={<Guard roles={['CAIXA']}><CashierLayout /></Guard>}>
        <Route index element={<Board />} />
        <Route path="nova" element={<NewAccount />} />
        <Route path="conta/:id" element={<AccountPage />} />
        <Route path="receber" element={<Receivables />} />
        <Route path="registro" element={<RegisterPage />} />
        <Route path="disponibilidade" element={<Availability />} />
        <Route path="pedidos" element={<OrdersToday />} />
        <Route path="estoque" element={<StockPage />} />
      </Route>
      <Route path="/admin" element={<Guard roles={['ADMIN']}><AdminLayout /></Guard>}>
        <Route index element={<Dashboard />} />
        <Route path="contas" element={<Accounts />} />
        <Route path="receber" element={<Receivables />} />
        <Route path="conta/:id" element={<AccountPage />} />
        <Route path="cardapio" element={<MenuAdmin />} />
        <Route path="caixas" element={<Registers />} />
        <Route path="historico" element={<Audit />} />
        <Route path="cancelamentos" element={<Cancellations />} />
        <Route path="usuarios" element={<Users />} />
        <Route path="configuracoes" element={<SettingsPage />} />
        <Route path="insights" element={<InsightsPage />} />
        <Route path="financeiro" element={<FinancePage />} />
        <Route path="tempo" element={<TimingPage />} />
        <Route path="pedidos" element={<OrdersHistory />} />
      </Route>
      <Route path="*" element={<Home />} />
    </Routes>
    </>
  );
}
