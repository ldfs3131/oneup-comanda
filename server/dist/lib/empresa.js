import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, runAsSystem } from '../db/index.js';
import { empresas } from '../db/schema.js';
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const cache = new Map();
const TTL_MS = 30_000;
/** Descobre o slug da empresa a partir do endereço (e, só em teste, do cabeçalho x-empresa). */
export function slugDaRequisicao(hostHeader, empresaHeader) {
    if (config.allowEmpresaHeader && typeof empresaHeader === 'string' && empresaHeader)
        return empresaHeader.toLowerCase();
    const host = (hostHeader ?? '').toLowerCase().split(':')[0];
    const sufixos = [config.baseDomain, 'localhost'].filter(Boolean);
    for (const base of sufixos) {
        if (host.endsWith('.' + base)) {
            const label = host.slice(0, -(base.length + 1));
            if (label && !label.includes('.'))
                return label;
        }
    }
    return config.defaultEmpresa;
}
/** Busca a empresa pelo slug (cache curto). Empresa cancelada não abre. */
export async function empresaPorSlug(slug) {
    if (!slug || !SLUG_RE.test(slug))
        return null;
    const hit = cache.get(slug);
    if (hit && Date.now() - hit.at < TTL_MS)
        return hit.info;
    const [row] = await runAsSystem(() => db.select().from(empresas).where(eq(empresas.slug, slug)).limit(1));
    const info = row && row.status !== 'CANCELADA' ? { id: row.id, slug: row.slug, nome: row.nome, status: row.status } : null;
    cache.set(slug, { at: Date.now(), info });
    return info;
}
export const limparCacheEmpresas = () => cache.clear();
export const slugValido = (s) => SLUG_RE.test(s);
