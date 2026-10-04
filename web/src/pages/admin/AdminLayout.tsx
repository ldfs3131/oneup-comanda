import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Banners, EstablishmentChip, Logo, SoundToggle, UserMenu, useSettings } from '../../components/layout';
import { useAuth } from '../../auth';
import { api } from '../../api';
import { dateOnly, fmtDay } from '../../format';
import { useAction } from '../../components/ui';

export default function AdminLayout() {
  const { data: settings } = useSettings();
  const { user } = useAuth();
  // contador de Pendências no menu (o que o Dono precisa conferir)
  const { data: pend } = useQuery({ queryKey: ['pendencias-contagem'], queryFn: () => api.get<{ total: number }>('/api/pendencias/contagem'), refetchInterval: 120_000 });
  const { data: alertas = [] } = useQuery({ queryKey: ['stock-alertas'], queryFn: async () => (await api.get<{ situacao?: string; active?: boolean }[]>('/api/stock')).filter((r) => r.active !== false && r.situacao && r.situacao !== 'ok'), refetchInterval: 120_000 });
  const [mais, setMais] = useState(false);
  return (
    <div className="app">
      <Banners />
      <AvisoLicenca />
      {user?.oneup && <LembreteBackup />}
      <header className="topbar">
        <Logo to="/admin" />
        <div className="grow hide-mobile" style={{ fontWeight: 700, color: 'var(--muted)' }}>{user?.oneup ? 'Painel · acesso ONE UP' : 'Painel do Dono'}</div>
        <EstablishmentChip hasRegister />
        <SoundToggle />
        <UserMenu />
      </header>
      <div className="admin-shell">
        <nav className="sidenav">
          {/* Dono: 6 itens principais, um por pergunta */}
          <NavLink to="/admin/pedidos">📋 Pedidos</NavLink>
          <NavLink to="/admin/financeiro">💵 Financeiro</NavLink>
          <NavLink to="/admin/estoque">📦 Estoque{alertas.length > 0 && <span className="nav-count warn">{alertas.length}</span>}</NavLink>
          <NavLink to="/admin/receber">⏳ A receber</NavLink>
          <NavLink to="/admin/pendencias">✅ Pendências{!!pend?.total && <span className="nav-count">{pend.total}</span>}</NavLink>
          <NavLink to="/admin/configuracoes">⚙ Configurações</NavLink>
          <button className={`nav-mais${mais ? ' on' : ''}`} onClick={() => setMais((m) => !m)}>{mais ? '▾' : '▸'} Mais</button>
          {mais && <>
            <NavLink to="/admin" end>📊 Painel do dia</NavLink>
            <NavLink to="/admin/cardapio">🍢 Cardápio</NavLink>
            <NavLink to="/admin/usuarios">👤 Usuários</NavLink>
            <NavLink to="/admin/caixas">💰 Caixas</NavLink>
            <NavLink to="/admin/contas">🧾 Contas</NavLink>
            <NavLink to="/admin/clientes">🙋 Clientes</NavLink>
            <NavLink to="/admin/cancelamentos">✕ Cancelamentos</NavLink>
            <NavLink to="/admin/historico">🕘 Auditoria</NavLink>
          </>}
          {/* Leitura dos números: serviço da ONE UP (o Dono não vê) */}
          {user?.oneup && <>
            <div className="nav-sec">ONE UP</div>
            <NavLink to="/admin/oneup/analise">📊 Central de Análise</NavLink>
            <NavLink to="/admin/oneup/recuperacao">💸 Recuperação de vendas</NavLink>
            <NavLink to="/admin/oneup/plataforma">🏢 Plataforma</NavLink>
            <NavLink to="/admin/oneup/base">📈 Base de comparação</NavLink>
            <NavLink to="/admin/tempo">⏱ Tempo de preparo</NavLink>
          </>}
          <div className="sep" />
          <NavLink to="/caixa">▶ Operar caixa</NavLink>
          <NavLink to="/cozinha">▶ Tela da cozinha</NavLink>
        </nav>
        <main className="page"><Outlet /></main>
      </div>
    </div>
  );
}

/** A cada 30 dias, lembra a ONE UP de copiar o backup para fora do servidor (Google Drive). */
function LembreteBackup() {
  const { data } = useQuery({ queryKey: ['oneup-lembretes'], queryFn: () => api.get<{ backupExterno: { mostrar: boolean; ultimoEm: string | null } }>('/api/oneup/lembretes'), staleTime: 300_000 });
  const qc = useQueryClient();
  const { busy, run } = useAction();
  if (!data?.backupExterno.mostrar) return null;
  const responder = (acao: 'feito' | 'amanha') => run(async () => { await api.post('/api/oneup/lembretes/backup', { acao }); qc.invalidateQueries({ queryKey: ['oneup-lembretes'] }); }, acao === 'feito' ? 'Anotado. Próximo lembrete em 30 dias.' : 'Lembro amanhã.');
  return (
    <div className="banner info row wrap" style={{ gap: 10, justifyContent: 'center' }}>
      <span>💾 Você fez o backup externo no Google Drive? {data.backupExterno.ultimoEm ? `Último confirmado em ${dateOnly(data.backupExterno.ultimoEm)}.` : 'Ainda não há nenhum confirmado.'}</span>
      <button className="btn sm primary" disabled={busy} onClick={() => responder('feito')}>Já fiz</button>
      <button className="btn sm" disabled={busy} onClick={() => responder('amanha')}>Lembrar amanhã</button>
    </div>
  );
}

/**
 * Aviso de licença no topo do painel do Dono: só a partir de 5 dias antes do vencimento, e sempre que estiver
 * em "só consulta" ou suspensa. Sem valores (a mensalidade não aparece aqui).
 */
function AvisoLicenca() {
  const { data } = useSettings();
  const { user } = useAuth();
  const l = data?.licenca;
  if (!l || !l.avisar) return null;
  if (l.status === 'SUSPENSO') return (
    <div className="banner licenca bloqueio" role="alert">⛔ <b>Acesso suspenso</b><span>A equipe do restaurante não consegue entrar. {user?.oneup ? '(Você vê porque é o acesso ONE UP.)' : 'Fale com a ONE UP.'}</span></div>
  );
  if (l.status === 'SO_CONSULTA') {
    if (l.diaAberto) return (
      <div className="banner licenca aviso" role="status">⚠ <b>{l.vencida ? `A licença venceu${l.venceEm ? ` em ${fmtDay(l.venceEm)}` : ''}.` : 'A ONE UP colocou o sistema em só consulta.'}</b><span>O dia de hoje segue normal até encerrar. No próximo “abrir o dia”, o sistema entra em só consulta — fale com a ONE UP.</span></div>
    );
    return (
      <div className="banner licenca bloqueio" role="alert">🔒 <b>Sistema em só consulta</b><span>Dá para ver o histórico, receber contas abertas e exportar. Abrir o dia e pedidos novos estão bloqueados{l.vencida && l.venceEm ? ` (licença vencida em ${fmtDay(l.venceEm)})` : ''}. Fale com a ONE UP para regularizar.</span></div>
    );
  }
  const d = l.diasParaVencer ?? 0;
  return (
    <div className="banner licenca aviso" role="status">📅 <b>{d === 0 ? 'A mensalidade do sistema vence hoje' : `A mensalidade do sistema vence em ${d} dia${d > 1 ? 's' : ''}`}{l.venceEm ? ` (${fmtDay(l.venceEm)})` : ''}.</b><span>Depois do vencimento, o sistema entra em só consulta no próximo “abrir o dia”.</span></div>
  );
}
