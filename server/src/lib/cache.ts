import { currentContext } from '../db/index.js';

/*
 * VERSÕES E RESPOSTAS GUARDADAS, POR EMPRESA
 * - dataVersion: muda a cada pedido/pagamento/caixa (contas, cozinha, painel).
 * - menuVersion: muda quando o cardápio, o estoque ou as configurações mudam.
 * Telas iguais pedindo a mesma coisa (6 caixas, 3 cozinhas, 40 celulares) recebem a MESMA resposta,
 * calculada uma vez por versão. Qualquer mudança gera versão nova, e a próxima consulta recalcula.
 * Um servidor só (uma instância). Com mais instâncias, trocar por cache compartilhado.
 */
const versions = new Map<number, number>();
const menuVersions = new Map<number, number>();
const key = () => currentContext()?.empresaId ?? 0;
export const bumpDataVersion = () => { const k = key(); versions.set(k, (versions.get(k) ?? 0) + 1); };
export const dataVersion = () => versions.get(key()) ?? 0;
export const bumpMenuVersion = () => { const k = key(); menuVersions.set(k, (menuVersions.get(k) ?? 0) + 1); };
export const menuVersion = () => menuVersions.get(key()) ?? 0;

/** Marca que esta requisição mexeu no estoque (para avisar as telas do cardápio só quando precisa). */
export const marcarEstoqueMudou = () => { const c = currentContext(); if (c) c.estoqueMudou = true; };
export const estoqueMudou = () => !!currentContext()?.estoqueMudou;

type Entrada = { versao: string; ate: number; valor?: unknown; promessa?: Promise<unknown> };
const respostas = new Map<string, Entrada>();

/**
 * Resposta guardada por (empresa, nome, versão) durante ttlMs. Pedidos iguais ao mesmo tempo esperam
 * o mesmo cálculo. Se o cálculo falhar (aparelho caiu no meio), quem esperava calcula por conta própria.
 * O valor devolvido é compartilhado: NÃO altere o objeto depois.
 */
export async function emCache<T>(nome: string, versao: string | number, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const k = `${key()}:${nome}`;
  const v = String(versao);
  const e = respostas.get(k);
  if (e && e.versao === v) {
    if (e.valor !== undefined && e.ate > Date.now()) return e.valor as T;
    if (e.promessa) { try { return (await e.promessa) as T; } catch { /* calcula abaixo */ } }
  }
  const promessa = fn();
  if (respostas.size > 20_000) respostas.clear();
  respostas.set(k, { versao: v, ate: 0, promessa });
  try {
    const valor = await promessa;
    if (respostas.get(k)?.promessa === promessa) respostas.set(k, { versao: v, ate: Date.now() + ttlMs, valor });
    return valor;
  } catch (err) {
    if (respostas.get(k)?.promessa === promessa) respostas.delete(k);
    throw err;
  }
}
