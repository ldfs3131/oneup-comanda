import { useEffect, useState } from 'react';
import { Modal } from './ui';
import { useAuth } from '../auth';

/*
 * "Baixar o aplicativo": o app é instalado pelo navegador (sem loja), com o nome e o ícone do restaurante.
 * Android/Chrome: o próprio navegador oferece a instalação (botão abaixo chama esse convite).
 * iPhone/Safari: não existe convite automático; mostramos o passo a passo (Compartilhar → Adicionar à Tela de Início).
 */
type ConviteEvt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
let convite: ConviteEvt | null = null;
const ouvintes = new Set<() => void>();
const avisar = () => ouvintes.forEach((f) => f());

/** Chamado uma vez ao abrir (main.tsx): guarda o convite do navegador e liga o service worker. */
export function prepararInstalacao() {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); convite = e as ConviteEvt; avisar(); });
  window.addEventListener('appinstalled', () => { convite = null; avisar(); });
  if ('serviceWorker' in navigator) window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => undefined); });
}

export const rodandoComoApp = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
export const ehIphone = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function useInstalacao() {
  const [, forcar] = useState(0);
  useEffect(() => { const f = () => forcar((n) => n + 1); ouvintes.add(f); return () => { ouvintes.delete(f); }; }, []);
  return {
    instalado: rodandoComoApp(),
    podeConvidar: !!convite,
    iphone: ehIphone(),
    instalar: async () => {
      if (!convite) return false;
      await convite.prompt();
      const r = await convite.userChoice.catch(() => ({ outcome: 'dismissed' as const }));
      convite = null; avisar();
      return r.outcome === 'accepted';
    },
  };
}

/** Botão "Baixar o aplicativo" (some quando já está aberto como app). */
export function BotaoBaixarApp({ para, className = 'btn', texto }: { para: 'cliente' | 'equipe'; className?: string; texto?: string }) {
  const { instalado, podeConvidar, iphone, instalar } = useInstalacao();
  const [ajuda, setAjuda] = useState(false);
  if (instalado) return null;
  const clicar = async () => { if (podeConvidar) { const ok = await instalar(); if (!ok) setAjuda(true); } else setAjuda(true); };
  return <>
    <button type="button" className={className} onClick={clicar}>📲 {texto ?? 'Baixar o aplicativo'}</button>
    {ajuda && <ComoInstalar para={para} iphone={iphone} onClose={() => setAjuda(false)} />}
  </>;
}

export function ComoInstalar({ para, iphone, onClose }: { para: 'cliente' | 'equipe'; iphone: boolean; onClose: () => void }) {
  const { meta } = useAuth();
  const nome = meta?.nomeApp || meta?.restaurantName || 'o restaurante';
  return (
    <Modal title={`Baixar o app ${para === 'cliente' ? 'de ' + nome : `da equipe — ${nome}`}`} onClose={onClose} footer={<button className="btn primary block" onClick={onClose}>Entendi</button>}>
      <div className="app-passos">
        {iphone ? <ol>
          <li>Abra esta página no <b>Safari</b> (o navegador da Apple).</li>
          <li>Toque em <b>Compartilhar</b> <span className="app-ico">⬆︎</span> (o quadrado com a seta, embaixo da tela).</li>
          <li>Role e toque em <b>Adicionar à Tela de Início</b>.</li>
          <li>Confirme em <b>Adicionar</b>. O ícone <b>{nome}</b> aparece na tela do celular.</li>
        </ol> : <ol>
          <li>Abra esta página no <b>Chrome</b>.</li>
          <li>Toque no menu <b>⋮</b> (canto de cima, à direita).</li>
          <li>Toque em <b>Instalar app</b> ou <b>Adicionar à tela inicial</b>.</li>
          <li>Confirme. O ícone <b>{nome}</b> aparece na tela do celular e abre em tela cheia.</li>
        </ol>}
        <p className="small muted">Não precisa de loja nem de cadastro, e não ocupa espaço: o app abre sempre a versão mais nova.</p>
      </div>
    </Modal>
  );
}
