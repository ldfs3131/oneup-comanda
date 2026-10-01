import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { and, eq, gt, lt, ne } from 'drizzle-orm';
import { currentContext, db } from './db/index.js';
import { roles, sessions, users } from './db/schema.js';
import { HttpError } from './lib/http.js';
import { config } from './config.js';

export type Role = 'ADMIN' | 'CAIXA' | 'COZINHA';
export type AuthUser = { id: number; name: string; username: string; role: Role };

declare module 'fastify' {
  interface FastifyRequest { user?: AuthUser }
}

export const COOKIE = 'oneup_sessao';
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

export const hashPassword = (p: string) => bcrypt.hash(p, 10);
export const checkPassword = (p: string, h: string) => bcrypt.compare(p, h);

export async function createSession(userId: number, remember = true) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + (remember ? config.sessionDays * 86400_000 : 14 * 3600_000));
  await db.insert(sessions).values({ tokenHash: sha(token), userId, expiresAt });
  // limpeza oportunista de sessões vencidas
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  return { token, expiresAt };
}

export async function destroySession(token: string | undefined) {
  if (!token) return;
  cacheSessao.delete(chaveCache(sha(token)));
  await db.delete(sessions).where(eq(sessions.tokenHash, sha(token)));
}

/*
 * Sessão conferida a cada chamada. Para não ir ao banco em toda requisição (o caixa e a cozinha fazem
 * dezenas por minuto), o resultado fica guardado por 10 s. Sair do sistema, trocar a senha ou desativar a
 * pessoa apagam a lembrança na hora (esquecerSessoesDoUsuario).
 */
const cacheSessao = new Map<string, { user: AuthUser; ate: number }>();
const chaveCache = (hash: string) => `${currentContext()?.empresaId ?? 0}:${hash}`;
export function esquecerSessoesDoUsuario(userId: number) {
  const e = `${currentContext()?.empresaId ?? 0}:`;
  for (const [k, v] of cacheSessao) if (k.startsWith(e) && v.user.id === userId) cacheSessao.delete(k);
}
/** Derruba todas as sessões da pessoa (troca de senha), menos a atual se informada. */
export async function derrubarSessoes(userId: number, manterToken?: string) {
  esquecerSessoesDoUsuario(userId);
  const manter = manterToken ? sha(manterToken) : null;
  await db.delete(sessions).where(manter ? and(eq(sessions.userId, userId), ne(sessions.tokenHash, manter)) : eq(sessions.userId, userId));
}
setInterval(() => { const now = Date.now(); for (const [k, v] of cacheSessao) if (v.ate < now) cacheSessao.delete(k); }, 60_000).unref();

export async function userFromToken(token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  const hash = sha(token);
  const ck = chaveCache(hash);
  const hit = cacheSessao.get(ck);
  if (hit && hit.ate > Date.now()) return hit.user;
  const rows = await db
    .select({ id: users.id, name: users.name, username: users.username, role: roles.code, active: users.active, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(and(eq(sessions.tokenHash, hash), gt(sessions.expiresAt, new Date())))
    .limit(1);
  const u = rows[0];
  if (!u || !u.active) { cacheSessao.delete(ck); return null; }
  // sessão deslizante: quem usa todo dia (tablet da cozinha) não é deslogado (só grava quando precisa)
  const exp = +new Date(u.expiresAt);
  const half = Date.now() + (config.sessionDays / 2) * 86400_000;
  if (exp < half && exp > Date.now() + 86400_000) {
    await db.update(sessions).set({ expiresAt: new Date(Date.now() + config.sessionDays * 86400_000) }).where(eq(sessions.tokenHash, hash));
  }
  const user: AuthUser = { id: u.id, name: u.name, username: u.username, role: u.role };
  if (cacheSessao.size < 50_000) cacheSessao.set(ck, { user, ate: Math.min(Date.now() + 10_000, exp) });
  return user;
}

/** Lê o cookie de sessão a partir de um header Cookie bruto (usado no Socket.IO). */
export function tokenFromCookieHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/** Guard: exige login e (opcionalmente) um dos perfis. ADMIN passa sempre. */
export function requireRole(...allowed: Role[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const user = await userFromToken(req.cookies[COOKIE]);
    if (!user) throw new HttpError(401, 'Sessão expirada. Faça login novamente.');
    if (allowed.length && user.role !== 'ADMIN' && !allowed.includes(user.role)) {
      throw new HttpError(403, 'Seu perfil não tem acesso a esta função.');
    }
    req.user = user;
  };
}

export const me = (req: FastifyRequest) => req.user as AuthUser;

/*
 * Tentativas de senha errada. Conta só os ERROS, separado por pessoa e por aparelho (IP):
 * a cozinha errando a senha não trava o login do caixa nem do dono.
 *  - mesmo aparelho + mesmo usuário: 8 erros em 5 min
 *  - mesmo aparelho (qualquer usuário): 40 erros em 5 min
 *  - mesmo usuário (de qualquer lugar): 50 erros em 15 min (força bruta espalhada)
 */
const attempts = new Map<string, { n: number; until: number }>();
const LIMITES = [
  { k: (e: number, ip: string, u: string) => `iu:${e}:${ip}:${u}`, max: 8, janela: 5 * 60_000 },
  { k: (e: number, ip: string) => `i:${e}:${ip}`, max: 40, janela: 5 * 60_000 },
  { k: (e: number, _ip: string, u: string) => `u:${e}:${u}`, max: 50, janela: 15 * 60_000 },
];
export function checkLoginRate(empresaId: number, ip: string, username: string) {
  const now = Date.now();
  for (const l of LIMITES) {
    const a = attempts.get(l.k(empresaId, ip, username));
    if (a && a.until > now && a.n >= l.max) throw new HttpError(429, 'Muitas tentativas com senha errada. Aguarde alguns minutos.');
  }
}
export function registerLoginFailure(empresaId: number, ip: string, username: string) {
  const now = Date.now();
  if (attempts.size > 100_000) attempts.clear();
  for (const l of LIMITES) {
    const k = l.k(empresaId, ip, username);
    const a = attempts.get(k);
    if (!a || a.until < now) attempts.set(k, { n: 1, until: now + l.janela }); else a.n++;
  }
}
export const clearLoginRate = (empresaId: number, ip: string, username: string) => attempts.delete(`iu:${empresaId}:${ip}:${username}`);
// para igualar o tempo de resposta quando o usuário não existe (não revela quais logins existem)
export const HASH_FALSO = bcrypt.hashSync('senha-que-nao-existe-' + randomBytes(8).toString('hex'), 10);
setInterval(() => { const now = Date.now(); for (const [k, a] of attempts) if (a.until < now) attempts.delete(k); }, 10 * 60_000).unref();
