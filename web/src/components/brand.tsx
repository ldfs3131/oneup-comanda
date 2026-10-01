import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth';
import { api } from '../api';
import type { Settings } from '../types';

const useSettingsLite = () => useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/api/settings'), staleTime: 30_000 });

/** Tinta legível sobre a cor de destaque (texto escuro em cor clara e vice-versa). */
function inkFor(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.35 ? '#1a1508' : '#ffffff';
}

/** Aplica a cor de destaque escolhida pelo Dono em todas as telas. */
export function ThemeApplier() {
  const { meta } = useAuth();
  const accent = meta?.accent;
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
  const nome = meta?.restaurantName || meta?.product || 'ONE UP';
  useEffect(() => { document.title = `${nome} — ${tela}`; }, [nome, tela]);
  return `${nome} — ${tela}`;
}

/** Logotipo do restaurante; sem logotipo, o nome escrito na cor de destaque. */
export function BrandLogo({ height = 40, className, logo, name }: { height?: number; className?: string; logo?: string | null; name?: string }) {
  const { meta } = useAuth();
  const src = logo !== undefined ? logo : meta?.logo;
  const nome = name ?? meta?.restaurantName ?? 'ONE UP';
  if (src) return <img className={className} src={src} alt={nome} style={{ height, maxWidth: '100%', objectFit: 'contain' }} />;
  return <span className={`brand-word ${className ?? ''}`} style={{ fontSize: Math.max(14, height * 0.45) }}>{nome}</span>;
}

/** Assinatura do produto. */
export function ProductMark() {
  return <span className="product-mark">ONE <b>UP</b></span>;
}

/** Nome que o Dono deu ao campo "Mesa" (Quiosque, Comanda, Casa…). */
export function useMesaLabel() {
  const { data } = useSettingsLite();
  return (data?.config?.rotulo_mesa as string | undefined) || 'Mesa';
}
