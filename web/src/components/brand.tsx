import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth';
import { api } from '../api';
import type { Settings } from '../types';

const useSettingsLite = () => useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/api/settings'), staleTime: 30_000 });

/** Luminância relativa (WCAG 2) de uma cor #rrggbb. */
function luminancia(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** Razão de contraste WCAG entre duas cores #rrggbb (1 a 21; texto normal pede 4,5). */
export function contraste(a: string, b: string) {
  const [x, y] = [luminancia(a), luminancia(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const TINTAS = ['#1a1508', '#ffffff'];
/** Tinta legível sobre a cor de destaque: a que der MAIOR contraste (escura ou branca), sem limiar fixo. */
export function inkFor(hex: string) {
  return TINTAS.reduce((melhor, t) => (contraste(t, hex) > contraste(melhor, hex) ? t : melhor), TINTAS[0]);
}

/** Aplica o tema (escuro/claro/automático) e a cor de destaque escolhidos pelo Dono em todas as telas. */
export function ThemeApplier() {
  const { meta } = useAuth();
  const accent = meta?.accent;
  const tema = meta?.tema ?? 'escuro';
  useEffect(() => {
    const root = document.documentElement;
    const mq = window.matchMedia?.('(prefers-color-scheme: light)');
    const aplicar = () => {
      const claro = tema === 'claro' || (tema === 'auto' && !!mq?.matches);
      root.dataset.theme = claro ? 'light' : 'dark';
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', claro ? '#f6f4ee' : '#161513');
    };
    aplicar();
    if (tema !== 'auto' || !mq) return;
    mq.addEventListener('change', aplicar);
    return () => mq.removeEventListener('change', aplicar);
  }, [tema]);
  // ícone e nome do app no iPhone (o Safari lê estas tags, não o manifesto)
  const icone = meta?.icone; const nomeApp = meta?.nomeApp || meta?.restaurantName;
  useEffect(() => {
    document.querySelector('link[rel="apple-touch-icon"]')?.setAttribute('href', icone || '/comanda-icon-180.png');
    if (nomeApp) document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', nomeApp);
  }, [icone, nomeApp]);
  useEffect(() => {
    const root = document.documentElement;
    if (accent && /^#[0-9a-f]{6}$/i.test(accent)) {
      root.style.setProperty('--brand', accent);
      root.style.setProperty('--brand-ink', inkFor(accent));
    } else {
      root.style.removeProperty('--brand');
      root.style.removeProperty('--brand-ink');
    }
  }, [accent]);
  return null;
}

/** Título da aba: "<restaurante> — <tela>". */
export function usePageTitle(tela: string) {
  const { meta } = useAuth();
  const nome = meta?.restaurantName || meta?.product || 'ONE UP Comanda';
  useEffect(() => { document.title = `${nome} — ${tela}`; }, [nome, tela]);
  return `${nome} — ${tela}`;
}

/** Logotipo do restaurante; sem logotipo, o nome escrito na cor de destaque. */
export function BrandLogo({ height = 40, className, logo, name }: { height?: number; className?: string; logo?: string | null; name?: string }) {
  const { meta } = useAuth();
  const src = logo !== undefined ? logo : meta?.logo;
  const nome = name ?? meta?.restaurantName ?? 'ONE UP Comanda';
  if (src) return <img className={className} src={src} alt={nome} style={{ height, maxWidth: '100%', objectFit: 'contain' }} />;
  return <span className={`brand-word ${className ?? ''}`} style={{ fontSize: Math.max(14, height * 0.45) }}>{nome}</span>;
}

/** Assinatura do produto (logotipo ONE UP Comanda, em cartão de bordas suaves). */
export function ProductMark({ height = 36 }: { height?: number }) {
  return <img className="product-mark-img" src="/comanda-logo-sm.webp" alt="ONE UP Comanda" style={{ height }} />;
}

/** Nome que o Dono deu ao campo "Mesa" (Quiosque, Comanda, Casa…). */
export function useMesaLabel() {
  const { data } = useSettingsLite();
  return (data?.config?.rotulo_mesa as string | undefined) || 'Mesa';
}
