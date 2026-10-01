export function brl(cents: number | null | undefined): string {
  const c = Number(cents ?? 0);
  const neg = c < 0;
  const [int, dec] = (Math.abs(c) / 100).toFixed(2).split('.');
  return `${neg ? '-' : ''}R$ ${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`;
}

/** "25,50" / "25.5" / "25" → 2550. Retorna null se inválido. */
export function parseMoney(s: string): number | null {
  const t = s.trim().replace(/\s|R\$/g, '');
  if (!t) return null;
  const norm = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  if (!/^\d+(\.\d{0,2})?$/.test(norm)) return null;
  return Math.round(Number(norm) * 100);
}
export const centsToInput = (c: number) => (c / 100).toFixed(2).replace('.', ',');

const tz = 'America/Sao_Paulo';
export const time = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: tz }) : '';
export const dateTime = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: tz }) : '';
export const dateOnly = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: tz }) : '';
export const todayISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());

export function minutesSince(d: string | Date | null | undefined, now = Date.now()) {
  return d ? Math.max(0, Math.floor((now - new Date(d).getTime()) / 60000)) : 0;
}

export const ACCOUNT_STATUS: Record<string, { label: string; tone: string }> = {
  OPEN: { label: 'Aberta', tone: 'info' },
  PARTIALLY_PAID: { label: 'Parcialmente paga', tone: 'warn' },
  PENDING: { label: 'Pendente', tone: 'danger' },
  PAID: { label: 'Paga', tone: 'ok' },
  CLOSED: { label: 'Encerrada', tone: 'muted' },
  CANCELLED: { label: 'Cancelada', tone: 'muted' },
  MERGED: { label: 'Juntada', tone: 'muted' },
};

export const ORDER_STATUS: Record<string, { label: string; tone: string }> = {
  NEW: { label: 'Novo', tone: 'info' },
  AWAITING_CONFIRMATION: { label: 'Aguardando confirmação', tone: 'warn' },
  CONFIRMED: { label: 'Novo (cozinha)', tone: 'info' },
  IN_PREPARATION: { label: 'Em preparo', tone: 'warn' },
  READY: { label: 'Pronto', tone: 'ok' },
  DELIVERED: { label: 'Entregue', tone: 'muted' },
  CANCELLED: { label: 'Cancelado', tone: 'danger' },
};

export const ROLE_LABEL: Record<string, string> = { ADMIN: 'Dono', CAIXA: 'Caixa', COZINHA: 'Cozinha' };

export const SITUATION: Record<string, { label: string; tone: string }> = {
  PAGO: { label: 'Pago', tone: 'ok' }, PARCIAL: { label: 'Parcial', tone: 'warn' }, PENDENTE: { label: 'A pagar', tone: 'danger' }, '—': { label: '—', tone: 'muted' },
};
export const ORIGIN_LABEL: Record<string, string> = { CAIXA: 'Caixa', QR_CODE: 'QR Code', DELIVERY: 'Delivery', WHATSAPP: 'WhatsApp' };
export const CONSUMPTION_LABEL: Record<string, string> = { LOCAL: 'Comer no local', VIAGEM: 'Para viagem' };
export const MOVEMENT_LABEL: Record<string, string> = {
  ENTRADA: 'Entrada', AJUSTE: 'Ajuste (contagem)', VENDA: 'Venda', CANCELAMENTO: 'Devolução (cancelamento)', DIVERGENCIA: 'Venda sem estoque (divergência)',
};

/** normaliza para busca sem acento: "Guaraná" → "guarana" */
export const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

export const pct = (x: number | null | undefined, digits = 0) => x == null || !isFinite(x) ? '—' : `${(x * 100).toFixed(digits).replace('.', ',')}%`;
export const signed = (c: number) => `${c > 0 ? '+' : c < 0 ? '−' : ''}${brl(Math.abs(c))}`;
export const addDaysISO = (d: string, n: number) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export const fmtDay = (d: string) => d.split('-').reverse().join('/');
export const minutesUntil = (d: string | null | undefined, now = Date.now()) => d ? Math.round((new Date(d).getTime() - now) / 60000) : null;
