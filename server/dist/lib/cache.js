import { currentContext } from '../db/index.js';
/** Versão dos dados operacionais POR EMPRESA: muda a cada pedido/pagamento. Usada para invalidar caches. */
const versions = new Map();
const key = () => currentContext()?.empresaId ?? 0;
export const bumpDataVersion = () => { const k = key(); versions.set(k, (versions.get(k) ?? 0) + 1); };
export const dataVersion = () => versions.get(key()) ?? 0;
