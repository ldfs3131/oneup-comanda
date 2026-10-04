import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, eq, gt, isNull, lt, ne } from 'drizzle-orm';
import { currentContext, db } from './db/index.js';
import { aparelhos, roles, sessions, users } from './db/schema.js';
import { HttpError } from './lib/http.js';
import { config } from './config.js';
import { erroSuspenso } from './lib/licenca.js';
export const COOKIE = 'oneup_sessao';
const sha = (t) => createHash('sha256').update(t).digest('hex');
export const hashPassword = (p) => bcrypt.hash(p, 10);
export const checkPassword = (p, h) => bcrypt.compare(p, h);
export async function createSession(userId, remember = true, aparelhoId = null) {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + (remember ? config.sessionDays * 86400_000 : 14 * 3600_000));
    await db.insert(sessions).values({ tokenHash: sha(token), userId, expiresAt, aparelhoId });
    // limpeza oportunista de sessões vencidas
    await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
    return { token, expiresAt };
}
export async function destroySession(token) {
    if (!token)
        return;
    cacheSessao.delete(chaveCache(sha(token)));
    await db.delete(sessions).where(eq(sessions.tokenHash, sha(token)));
}
/*
 * Sessão conferida a cada chamada. Para não ir ao banco em toda requisição (o caixa e a cozinha fazem
 * dezenas por minuto), o resultado fica guardado por 10 s. Sair do sistema, trocar a senha ou desativar a
 * pessoa apagam a lembrança na hora (esquecerSessoesDoUsuario).
 */
const cacheSessao = new Map();
const chaveCache = (hash) => `${currentContext()?.empresaId ?? 0}:${hash}`;
/** Avisados quando as sessões de alguém são esquecidas (o tempo real desconecta os aparelhos dessa pessoa). */
export const aoEsquecerUsuario = [];
export function esquecerSessoesDoUsuario(userId) {
    for (const f of aoEsquecerUsuario)
        f(currentContext()?.empresaId ?? 0, userId);
    const e = `${currentContext()?.empresaId ?? 0}:`;
    for (const [k, v] of cacheSessao)
        if (k.startsWith(e) && v.user.id === userId)
            cacheSessao.delete(k);
}
/** Derruba todas as sessões da pessoa (troca de senha), menos a atual se informada. */
export async function derrubarSessoes(userId, manterToken) {
    esquecerSessoesDoUsuario(userId);
    const manter = manterToken ? sha(manterToken) : null;
    await db.delete(sessions).where(manter ? and(eq(sessions.userId, userId), ne(sessions.tokenHash, manter)) : eq(sessions.userId, userId));
}
setInterval(() => { const now = Date.now(); for (const [k, v] of cacheSessao)
    if (v.ate < now)
        cacheSessao.delete(k); }, 60_000).unref();
export async function userFromToken(token) {
    if (!token)
        return null;
    const hash = sha(token);
    const ck = chaveCache(hash);
    const hit = cacheSessao.get(ck);
    if (hit && hit.ate > Date.now())
        return hit.user;
    const rows = await db
        .select({ id: users.id, name: users.name, username: users.username, role: roles.code, active: users.active, oneup: users.oneup, expiresAt: sessions.expiresAt })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .innerJoin(roles, eq(roles.id, users.roleId))
        .where(and(eq(sessions.tokenHash, hash), gt(sessions.expiresAt, new Date())))
        .limit(1);
    const u = rows[0];
    if (!u || !u.active) {
        cacheSessao.delete(ck);
        return null;
    }
    // sessão deslizante: quem usa todo dia (tablet da cozinha) não é deslogado (só grava quando precisa)
    const exp = +new Date(u.expiresAt);
    const half = Date.now() + (config.sessionDays / 2) * 86400_000;
    if (exp < half && exp > Date.now() + 86400_000) {
        await db.update(sessions).set({ expiresAt: new Date(Date.now() + config.sessionDays * 86400_000) }).where(eq(sessions.tokenHash, hash));
    }
    const user = { id: u.id, name: u.name, username: u.username, role: u.role, oneup: u.oneup };
    if (cacheSessao.size < 50_000)
        cacheSessao.set(ck, { user, ate: Math.min(Date.now() + 10_000, exp) });
    return user;
}
/** Lê o cookie de sessão a partir de um header Cookie bruto (usado no Socket.IO). */
export function tokenFromCookieHeader(header) {
    if (!header)
        return undefined;
    for (const part of header.split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k === COOKIE)
            return decodeURIComponent(v.join('='));
    }
    return undefined;
}
/** Guard: exige login e (opcionalmente) um dos perfis. ADMIN passa sempre. */
export function requireRole(...allowed) {
    return async (req, _reply) => {
        const user = await userFromToken(req.cookies[COOKIE]);
        if (!user)
            throw new HttpError(401, 'Sessão expirada. Faça login novamente.');
        // licença SUSPENSA pela ONE UP: a equipe do restaurante não usa o sistema (o acesso ONE UP continua)
        if (!user.oneup && req.empresa?.licencaStatus === 'SUSPENSO')
            throw erroSuspenso();
        if (allowed.length && user.role !== 'ADMIN' && !allowed.includes(user.role)) {
            throw new HttpError(403, 'Seu perfil não tem acesso a esta função.');
        }
        req.user = user;
    };
}
export const me = (req) => req.user;
/** Guard: só o usuário da ONE UP (Administrador da plataforma). Para os demais a rota "não existe" (404). */
export function requireOneup() {
    return async (req, reply) => {
        // Caixa e Cozinha também recebem 404 (não 403): para quem não é da ONE UP, a rota não existe
        await requireRole()(req, reply);
        const u = req.user;
        if (!u.oneup || u.role !== 'ADMIN')
            throw new HttpError(404, 'Recurso não disponível.');
    };
}
export async function vincularSessaoAoAparelho(token, aparelhoId) {
    await db.update(sessions).set({ aparelhoId }).where(eq(sessions.tokenHash, sha(token)));
}
/** Tirar o acesso de um aparelho: quem já está logado nele sai na hora. */
export async function derrubarSessoesDoAparelho(aparelhoId) {
    const r = await db.delete(sessions).where(eq(sessions.aparelhoId, aparelhoId)).returning({ userId: sessions.userId });
    for (const u of new Set(r.map((x) => x.userId)))
        esquecerSessoesDoUsuario(u);
    return r.length;
}
/*
 * Tentativas de senha errada. Conta só os ERROS, separado por pessoa e por aparelho (IP):
 * a cozinha errando a senha não trava o login do caixa nem do dono.
 *  - mesmo aparelho + mesmo usuário: 8 erros em 5 min
 *  - mesmo aparelho (qualquer usuário): 40 erros em 5 min
 *  - mesmo usuário (de qualquer lugar): 50 erros em 15 min (força bruta espalhada)
 */
const attempts = new Map();
const LIMITES = [
    { k: (e, ip, u) => `iu:${e}:${ip}:${u}`, max: 8, janela: 5 * 60_000 },
    { k: (e, ip) => `i:${e}:${ip}`, max: 40, janela: 5 * 60_000 },
    { k: (e, _ip, u) => `u:${e}:${u}`, max: 50, janela: 15 * 60_000 },
];
/**
 * Reserva a tentativa ANTES de conferir a senha (o bcrypt demora ~90 ms): uma rajada de requisições simultâneas
 * não passa toda pela checagem antes de o primeiro erro ser contado. Senha certa devolve a reserva.
 */
export function checkLoginRate(empresaId, ip, username) {
    const now = Date.now();
    for (const l of LIMITES) {
        const a = attempts.get(l.k(empresaId, ip, username));
        if (a && a.until > now && a.n >= l.max)
            throw new HttpError(429, 'Muitas tentativas com senha errada. Aguarde alguns minutos.');
    }
    if (attempts.size > 100_000)
        attempts.clear();
    for (const l of LIMITES) {
        const k = l.k(empresaId, ip, username);
        const a = attempts.get(k);
        if (!a || a.until < now)
            attempts.set(k, { n: 1, until: now + l.janela });
        else
            a.n++;
    }
}
/** Erro de senha: a tentativa já foi contada na reserva (mantido para deixar claro no fluxo). */
export function registerLoginFailure(_empresaId, _ip, _username) { }
/** Senha certa: zera o par aparelho+usuário e devolve a reserva dos outros contadores. */
export function clearLoginRate(empresaId, ip, username) {
    attempts.delete(`iu:${empresaId}:${ip}:${username}`);
    for (const l of LIMITES.slice(1)) {
        const a = attempts.get(l.k(empresaId, ip, username));
        if (a && a.n > 0)
            a.n--;
    }
}
/*
 * No máximo 4 conferências de senha/PIN ao mesmo tempo, com fila curta. Quem chega com a fila cheia recebe 429
 * na hora, sem segurar conexão do banco: uma rajada no login não trava os outros restaurantes.
 */
const BCRYPT_MAX = 4, FILA_MAX = 24;
let bcryptAtivos = 0;
const filaBcrypt = [];
export async function comVagaDeLogin(fn) {
    if (bcryptAtivos >= BCRYPT_MAX) {
        if (filaBcrypt.length >= FILA_MAX)
            throw new HttpError(429, 'Muitas tentativas de entrar agora. Aguarde alguns segundos e tente de novo.');
        await new Promise((r) => filaBcrypt.push(r));
    }
    bcryptAtivos++;
    try {
        return await fn();
    }
    finally {
        bcryptAtivos--;
        filaBcrypt.shift()?.();
    }
}
// para igualar o tempo de resposta quando o usuário não existe (não revela quais logins existem)
export const HASH_FALSO = bcrypt.hashSync('senha-que-nao-existe-' + randomBytes(8).toString('hex'), 10);
setInterval(() => { const now = Date.now(); for (const [k, a] of attempts)
    if (a.until < now)
        attempts.delete(k); }, 10 * 60_000).unref();
// ---------------------------------------------------------------------------------------------
// APARELHO DA EQUIPE + PIN
// O PIN de 4 dígitos é curto: por isso só funciona num aparelho onde alguém da equipe já entrou com usuário e
// senha (cookie próprio, guardado em hash) e trava a pessoa por 5 min depois de 5 erros seguidos.
export const COOKIE_APARELHO = 'oneup_aparelho';
const DIAS_APARELHO = 400;
export async function aparelhoValido(token) {
    if (!token || !/^[a-f0-9]{64}$/.test(token))
        return null;
    const [a] = await db.select().from(aparelhos).where(and(eq(aparelhos.tokenHash, sha(token)), isNull(aparelhos.revogadoEm)));
    return a ?? null;
}
/** Depois de um login com senha: marca este aparelho como da equipe (ou só atualiza o último uso). */
export async function lembrarAparelho(req, reply, userId) {
    const atual = await aparelhoValido(req.cookies[COOKIE_APARELHO]);
    if (atual) {
        await db.update(aparelhos).set({ ultimoUso: new Date() }).where(eq(aparelhos.id, atual.id));
        return atual.id;
    }
    const token = randomBytes(32).toString('hex');
    const ua = String(req.headers['user-agent'] ?? '');
    const nome = /iphone/i.test(ua) ? 'iPhone' : /ipad/i.test(ua) ? 'iPad' : /android/i.test(ua) ? (/mobile/i.test(ua) ? 'Celular Android' : 'Tablet Android') : /windows/i.test(ua) ? 'Computador Windows' : /mac os/i.test(ua) ? 'Mac' : 'Navegador';
    const [novo] = await db.insert(aparelhos).values({ tokenHash: sha(token), nome, criadoPor: userId, ultimoUso: new Date() }).returning({ id: aparelhos.id });
    reply.setCookie(COOKIE_APARELHO, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: DIAS_APARELHO * 86400 });
    return novo.id;
}
export const PIN_MAX_ERROS = 5;
export const PIN_BLOQUEIO_MIN = 5;
export const pinValido = (p) => /^\d{4}$/.test(p);
export const hashPin = (p) => bcrypt.hash(p, 10);
export const conferirPin = (p, h) => bcrypt.compare(p, h);
const autorizacoes = new Map();
setInterval(() => { const now = Date.now(); for (const [k, a] of autorizacoes)
    if (a.ate < now)
        autorizacoes.delete(k); }, 60_000).unref();
export function criarAutorizacao(donoId, donoNome, usuarioId) {
    const token = randomBytes(24).toString('hex');
    autorizacoes.set(token, { empresaId: currentContext()?.empresaId ?? 0, donoId, donoNome, usuarioId, ate: Date.now() + 120_000 });
    return token;
}
/** Dono que autorizou esta requisição (consome o código), ou null. */
export function autorizadoPeloDono(req) {
    const cache = req._autorizacao;
    if (cache !== undefined)
        return cache;
    const h = req.headers['x-autorizacao-dono'];
    let r = null;
    if (typeof h === 'string') {
        const a = autorizacoes.get(h);
        if (a && a.ate > Date.now() && a.empresaId === (currentContext()?.empresaId ?? 0) && a.usuarioId === req.user?.id) {
            autorizacoes.delete(h);
            r = { id: a.donoId, name: a.donoNome };
        }
    }
    req._autorizacao = r;
    return r;
}
