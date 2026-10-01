import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { and, eq, gt, lt } from 'drizzle-orm';
import { db } from './db/index.js';
import { roles, sessions, users } from './db/schema.js';
import { HttpError } from './lib/http.js';
import { config } from './config.js';

export type Role = 'ADMIN' | 'CAIXA' | 'COZINHA';
export type AuthUser = { id: number; name: string; username: string; role: Role };

declare module 'fastify' {
  interface FastifyRequest { user?: AuthUser }
}

export const COOKIE = 'onefood_sessao';
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
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, sha(token)));
}

export async function userFromToken(token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  const rows = await db
    .select({ id: users.id, name: users.name, username: users.username, role: roles.code, active: users.active })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(and(eq(sessions.tokenHash, sha(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  const u = rows[0];
  if (!u || !u.active) return null;
  // sessão deslizante: quem usa todo dia (tablet da cozinha) não é deslogado
  const half = Date.now() + (config.sessionDays / 2) * 86400_000;
  const dayAhead = Date.now() + 86400_000;
  await db.update(sessions).set({ expiresAt: new Date(Date.now() + config.sessionDays * 86400_000) })
    .where(and(eq(sessions.tokenHash, sha(token)), lt(sessions.expiresAt, new Date(half)), gt(sessions.expiresAt, new Date(dayAhead))));
  return { id: u.id, name: u.name, username: u.username, role: u.role };
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

// Limite simples de tentativas de login por IP
const attempts = new Map<string, { n: number; until: number }>();
export function checkLoginRate(ip: string) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (a && a.until > now && a.n >= 10) throw new HttpError(429, 'Muitas tentativas. Aguarde 5 minutos.');
  if (!a || a.until < now) attempts.set(ip, { n: 1, until: now + 5 * 60_000 });
  else a.n++;
}
export const clearLoginRate = (ip: string) => attempts.delete(ip);
