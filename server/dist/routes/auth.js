import { z } from 'zod';
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { aparelhos, roles, users, restaurantSettings } from '../db/schema.js';
import { COOKIE, COOKIE_APARELHO, HASH_FALSO, PIN_BLOQUEIO_MIN, PIN_MAX_ERROS, aparelhoValido, conferirPin, hashPin, lembrarAparelho, checkLoginRate, checkPassword, clearLoginRate, createSession, derrubarSessoes, destroySession, esquecerSessoesDoUsuario, hashPassword, me, registerLoginFailure, requireRole, userFromToken, } from '../auth.js';
import { HttpError, bad, conflict, idParam, notFound, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { config } from '../config.js';
import { configuracoesPublicas } from '../services/configuracoes.js';
export async function authRoutes(app) {
    app.get('/api/meta', async (req) => {
        const [s] = await db.select().from(restaurantSettings).limit(1);
        const pub = await configuracoesPublicas();
        return { demoMode: config.demoMode, restaurantName: s?.name ?? 'Meu restaurante', tagline: s?.tagline ?? '', product: config.productName, empresa: req.empresa?.slug ?? null, logo: pub.logo ?? null, accent: pub.cor_destaque ?? null, tema: pub.tema ?? 'escuro', nomeApp: pub.nome_app || null, icone: pub.icone_app || null };
    });
    app.post('/api/auth/login', async (req, reply) => {
        const body = parse(z.object({ username: z.string().trim().toLowerCase().min(1).max(60), password: z.string().min(1).max(200), remember: z.boolean().default(true) }), req.body);
        const empId = req.empresa?.id ?? 0;
        checkLoginRate(empId, req.ip, body.username);
        const rows = await db.select({ u: users, role: roles.code }).from(users)
            .innerJoin(roles, eq(roles.id, users.roleId)).where(eq(users.username, body.username)).limit(1);
        const row = rows[0];
        // sempre confere uma senha (mesmo sem usuário), para o tempo de resposta não revelar quem existe
        const senhaOk = await checkPassword(body.password, row?.u.passwordHash ?? HASH_FALSO);
        if (!row || !row.u.active || !senhaOk) {
            registerLoginFailure(empId, req.ip, body.username);
            throw bad('Usuário ou senha incorretos.');
        }
        clearLoginRate(empId, req.ip, body.username);
        const s = await createSession(row.u.id, body.remember);
        reply.setCookie(COOKIE, s.token, {
            path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, ...(body.remember ? { expires: s.expiresAt } : {}),
        });
        await lembrarAparelho(req, reply, row.u.id);
        await audit(db, { userId: row.u.id, action: 'auth.login', entityType: 'user', entityId: row.u.id, message: `${row.u.name} entrou no sistema.` });
        return { user: { id: row.u.id, name: row.u.name, username: row.u.username, role: row.role, oneup: row.u.oneup } };
    });
    // ---------- Entrar com PIN (só em aparelho da equipe) ----------
    app.get('/api/auth/pin/pessoas', async (req) => {
        const ap = await aparelhoValido(req.cookies[COOKIE_APARELHO]);
        if (!ap)
            return { aparelho: false, pessoas: [] };
        const pessoas = await db.select({ id: users.id, name: users.name, role: roles.code }).from(users).innerJoin(roles, eq(roles.id, users.roleId))
            .where(and(eq(users.active, true), eq(users.oneup, false), isNotNull(users.pinHash), inArray(roles.code, ['CAIXA', 'COZINHA']))).orderBy(asc(users.name));
        return { aparelho: true, pessoas };
    });
    app.post('/api/auth/pin', async (req, reply) => {
        const b = parse(z.object({ userId: z.number().int().positive(), pin: z.string().regex(/^\d{4}$/, 'o PIN tem 4 números') }), req.body);
        const ap = await aparelhoValido(req.cookies[COOKIE_APARELHO]);
        if (!ap)
            throw new HttpError(403, 'Este aparelho ainda não é da equipe: entre uma vez com usuário e senha.', 'APARELHO_DESCONHECIDO');
        const empId = req.empresa?.id ?? 0;
        checkLoginRate(empId, req.ip, `pin:${b.userId}`);
        const [row] = await db.select({ u: users, role: roles.code }).from(users).innerJoin(roles, eq(roles.id, users.roleId)).where(eq(users.id, b.userId));
        const permitido = row && row.u.active && !row.u.oneup && row.u.pinHash && ['CAIXA', 'COZINHA'].includes(row.role);
        if (permitido && row.u.pinBloqueadoAte && row.u.pinBloqueadoAte > new Date()) {
            const min = Math.ceil((row.u.pinBloqueadoAte.getTime() - Date.now()) / 60_000);
            throw new HttpError(429, `PIN bloqueado por erros seguidos. Tente de novo em ${min} min ou entre com usuário e senha.`, 'PIN_BLOQUEADO');
        }
        const ok = await conferirPin(b.pin, (permitido && row.u.pinHash) || HASH_FALSO);
        if (!permitido || !ok) {
            registerLoginFailure(empId, req.ip, `pin:${b.userId}`);
            if (permitido) {
                const falhas = row.u.pinFalhas + 1;
                await db.update(users).set(falhas >= PIN_MAX_ERROS
                    ? { pinFalhas: 0, pinBloqueadoAte: new Date(Date.now() + PIN_BLOQUEIO_MIN * 60_000) }
                    : { pinFalhas: falhas }).where(eq(users.id, row.u.id));
                if (falhas >= PIN_MAX_ERROS)
                    await audit(db, { userId: row.u.id, action: 'auth.pin_bloqueado', entityType: 'user', entityId: row.u.id, message: `PIN de ${row.u.name} bloqueado por ${PIN_BLOQUEIO_MIN} min depois de ${PIN_MAX_ERROS} erros (aparelho: ${ap.nome ?? '—'}).` });
            }
            throw bad('PIN incorreto.');
        }
        clearLoginRate(empId, req.ip, `pin:${b.userId}`);
        await db.update(users).set({ pinFalhas: 0, pinBloqueadoAte: null }).where(eq(users.id, row.u.id));
        await db.update(aparelhos).set({ ultimoUso: new Date() }).where(eq(aparelhos.id, ap.id));
        const s = await createSession(row.u.id, true);
        reply.setCookie(COOKIE, s.token, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, expires: s.expiresAt });
        await audit(db, { userId: row.u.id, action: 'auth.login', entityType: 'user', entityId: row.u.id, message: `${row.u.name} entrou com PIN (${ap.nome ?? 'aparelho da equipe'}).` });
        return { user: { id: row.u.id, name: row.u.name, username: row.u.username, role: row.role, oneup: false } };
    });
    // Aparelhos da equipe (Dono vê e tira o acesso de um aparelho perdido)
    app.get('/api/aparelhos', { preHandler: requireRole('ADMIN') }, async () => db.select({ id: aparelhos.id, nome: aparelhos.nome, createdAt: aparelhos.createdAt, ultimoUso: aparelhos.ultimoUso, criadoPor: users.name })
        .from(aparelhos).leftJoin(users, eq(users.id, aparelhos.criadoPor)).where(isNull(aparelhos.revogadoEm)).orderBy(desc(aparelhos.ultimoUso)));
    app.post('/api/aparelhos/:id/revogar', { preHandler: requireRole('ADMIN') }, async (req) => {
        const { id } = parse(idParam, req.params);
        const [a] = await db.update(aparelhos).set({ revogadoEm: new Date() }).where(and(eq(aparelhos.id, id), isNull(aparelhos.revogadoEm))).returning();
        if (!a)
            throw notFound('Aparelho não encontrado.');
        await audit(db, { userId: me(req).id, action: 'aparelho.revogar', entityType: 'aparelho', entityId: id, message: `${me(req).name} tirou o acesso por PIN do aparelho "${a.nome ?? id}".` });
        return { ok: true };
    });
    app.post('/api/auth/logout', async (req, reply) => {
        const u = await userFromToken(req.cookies[COOKIE]);
        if (u)
            await audit(db, { userId: u.id, action: 'auth.logout', entityType: 'user', entityId: u.id, message: `${u.name} saiu do sistema.` });
        await destroySession(req.cookies[COOKIE]);
        reply.clearCookie(COOKIE, { path: '/' });
        return { ok: true };
    });
    app.get('/api/auth/me', { preHandler: requireRole() }, async (req) => ({ user: me(req) }));
    app.post('/api/auth/password', { preHandler: requireRole() }, async (req) => {
        const b = parse(z.object({ current: z.string().min(1), next: z.string().min(4, 'A nova senha precisa de 4 caracteres ou mais') }), req.body);
        const [u] = await db.select().from(users).where(eq(users.id, me(req).id));
        if (!(await checkPassword(b.current, u.passwordHash)))
            throw bad('Senha atual incorreta.');
        await db.update(users).set({ passwordHash: await hashPassword(b.next) }).where(eq(users.id, u.id));
        await derrubarSessoes(u.id, req.cookies[COOKIE]); // outros aparelhos com a senha antiga saem
        await audit(db, { userId: u.id, action: 'user.password', entityType: 'user', entityId: u.id, message: `${u.name} alterou a própria senha.` });
        return { ok: true };
    });
    // ---------- Gestão de usuários (admin) ----------
    const admin = { preHandler: requireRole('ADMIN') };
    // O usuário da ONE UP não aparece para o Dono e não pode ser alterado por ele (só pela ferramenta da plataforma).
    app.get('/api/users', admin, async (req) => {
        return db.select({ id: users.id, name: users.name, username: users.username, role: roles.code, active: users.active, oneup: users.oneup, createdAt: users.createdAt, temPin: sql `${users.pinHash} IS NOT NULL` })
            .from(users).innerJoin(roles, eq(roles.id, users.roleId)).where(me(req).oneup ? undefined : eq(users.oneup, false)).orderBy(asc(users.name));
    });
    const roleSchema = z.enum(['ADMIN', 'CAIXA', 'COZINHA']);
    const roleId = async (code) => (await db.select().from(roles).where(eq(roles.code, code)))[0].id;
    app.post('/api/users', admin, async (req) => {
        const b = parse(z.object({
            name: z.string().trim().min(2),
            username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{2,30}$/, 'use letras minúsculas, números, ponto ou traço'),
            password: z.string().min(4, 'mínimo 4 caracteres'),
            role: roleSchema,
            pin: z.string().regex(/^\d{4}$/, 'o PIN tem 4 números').optional(),
        }), req.body);
        if (b.pin && b.role === 'ADMIN')
            throw bad('PIN é para Caixa e Cozinha. O Dono entra com usuário e senha.');
        const exists = await db.select().from(users).where(eq(users.username, b.username));
        if (exists.length)
            throw conflict('Já existe um usuário com esse login.');
        const [u] = await db.insert(users).values({
            name: b.name, username: b.username, passwordHash: await hashPassword(b.password), roleId: await roleId(b.role),
            pinHash: b.pin ? await hashPin(b.pin) : null,
        }).returning();
        await audit(db, { userId: me(req).id, action: 'user.create', entityType: 'user', entityId: u.id, message: `${me(req).name} criou o usuário ${u.name} (${b.role}).` });
        return { id: u.id };
    });
    app.patch('/api/users/:id', admin, async (req) => {
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({
            name: z.string().trim().min(2).optional(),
            role: roleSchema.optional(),
            active: z.boolean().optional(),
            password: z.string().min(4, 'mínimo 4 caracteres').optional(),
            pin: z.string().regex(/^\d{4}$/, 'o PIN tem 4 números').nullable().optional(),
        }), req.body);
        const [u] = await db.select().from(users).where(eq(users.id, id));
        if (!u || (u.oneup && !me(req).oneup))
            throw notFound('Usuário não encontrado.');
        if (id === me(req).id && (b.active === false || (b.role && b.role !== 'ADMIN'))) {
            throw conflict('Você não pode desativar nem rebaixar o seu próprio usuário.');
        }
        if (b.active === false || (b.role && b.role !== 'ADMIN')) {
            const adminRole = await roleId('ADMIN');
            if (u.roleId === adminRole) {
                // o administrador da ONE UP não conta: o restaurante precisa manter o próprio Dono ativo
                const others = await db.select().from(users).where(and(eq(users.roleId, adminRole), eq(users.active, true), eq(users.oneup, false), ne(users.id, id)));
                if (!others.length)
                    throw conflict('É preciso manter ao menos um usuário Dono ativo.');
            }
        }
        const set = {};
        if (b.name)
            set.name = b.name;
        if (b.role)
            set.roleId = await roleId(b.role);
        if (b.active !== undefined)
            set.active = b.active;
        if (b.password)
            set.passwordHash = await hashPassword(b.password);
        if (b.pin !== undefined) {
            const papel = b.role ?? (await db.select({ c: roles.code }).from(roles).where(eq(roles.id, u.roleId)))[0].c;
            if (b.pin && papel === 'ADMIN')
                throw bad('PIN é para Caixa e Cozinha. O Dono entra com usuário e senha.');
            set.pinHash = b.pin ? await hashPin(b.pin) : null;
            set.pinFalhas = 0;
            set.pinBloqueadoAte = null;
        }
        if (Object.keys(set).length)
            await db.update(users).set(set).where(eq(users.id, id));
        // senha redefinida, PIN trocado/removido ou pessoa desativada: os aparelhos dela saem na hora; mudança de perfil vale já.
        // Definir o PRIMEIRO PIN não derruba ninguém (o caixa não cai no meio do serviço).
        if (b.password || (b.pin !== undefined && u.pinHash) || b.active === false)
            await derrubarSessoes(id);
        else
            esquecerSessoesDoUsuario(id);
        const what = [b.name && 'nome', b.role && `perfil → ${b.role}`, b.active !== undefined && (b.active ? 'ativado' : 'desativado'), b.password && 'senha redefinida', b.pin !== undefined && (b.pin ? 'PIN definido' : 'PIN removido')]
            .filter(Boolean).join(', ');
        await audit(db, { userId: me(req).id, action: 'user.update', entityType: 'user', entityId: id, message: `${me(req).name} alterou o usuário ${u.name}: ${what}.` });
        return { ok: true };
    });
}
