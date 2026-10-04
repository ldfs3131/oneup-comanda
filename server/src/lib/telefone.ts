/**
 * Telefone brasileiro (celular ou fixo) — usado para identificar o cliente: mesmo telefone = mesmo cliente,
 * não importa se foi digitado "(61) 99999-1111", "61999991111" ou "+55 61 99999-1111".
 */

/** DDD + número (10 ou 11 dígitos), aceita +55. Devolve só os dígitos ou null (não é celular/fixo válido). */
export function normalizarWhatsapp(bruto: string | null | undefined): string | null {
  if (!bruto) return null;
  let d = bruto.replace(/\D/g, '');
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return null;
  if (Number(d.slice(0, 2)) < 11) return null;
  if (d.length === 11 && d[2] !== '9') return null;
  return d;
}

/** "61999991111" → "(61) 99999-1111"; outro texto volta como veio. */
export function formatarTelefone(t: string | null | undefined): string | null {
  if (!t) return null;
  const d = normalizarWhatsapp(t);
  if (!d) return t;
  return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
}

/** Telefone mascarado para o Caixa: "(61) 9****-1111" (celular) ou "(61) ****-1111" (fixo). */
export function mascararTelefone(t: string | null | undefined): string | null {
  if (!t) return null;
  const d = normalizarWhatsapp(t) ?? t.replace(/\D/g, '');
  if (d.length < 4) return '****';
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d[2]}****-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ****-${d.slice(6)}`;
  return `****${d.slice(-4)}`;
}
