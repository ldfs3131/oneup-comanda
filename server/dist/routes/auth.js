import { z } from 'zod';
import { and, asc, eq, ne } from 'drizzle-orm';
import { db } from '../db/index.js';
import { roles, users, restaurantSettings } from '../db/schema.js';
import { COOKIE, checkLoginRate, checkPassword, clearLoginRate, createSession, destroySession, hashPassword, me, requireRole, } from '../auth.js';
import { bad, conflict, idParam, notFound, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { config } from '../config.js';
export async function authRoutes(app) {
    app.get('/api/meta', async () => {
        const [s] = await db.select().from(restaurantSettings).limit(1);
        return { demoMode: config.demoMode, restaurantName: s?.name ?? 'Happy Alpha' };
    });
    app.post('/api/auth/login', async (req, reply) => {
        checkLoginRate(req.ip);
        const body = parse(z.object({ username: z.string().trim().toLowerCase().min(1), password: z.string().min(1) }), req.body);
        const rows = await db.select({ u: users, role: roles.code }).from(users)
            .innerJoin(roles, eq(roles.id, users.roleId)).where(eq(users.username, body.username)).limit(1);
        const row = rows[0];
        if (!row || !row.u.active || !(await checkPassword(body.password, row.u.passwordHash))) {
            throw bad('Usuário ou senha incorretos.');
        }
        clearLoginRate(req.ip);
        const s = await createSession(row.u.id);
        reply.setCookie(COOKIE, s.token, {
            path: '/', httpOnly: true, sameSite: 'lax', secure: false, expires: s.expiresAt,
        });
        await audit(db, { userId: row.u.id, action: 'auth.login', entityType: 'user', entityId: row.u.id, message: `${row.u.name} entrou no sistema.` });
        return { user: { id: row.u.id, name: row.u.name, username: row.u.username, role: row.role } };
    });
    app.post('/api/auth/logout', async (req, reply) => {
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
        await audit(db, { userId: u.id, action: 'user.password', entityType: 'user', entityId: u.id, message: `${u.name} alterou a própria senha.` });
        return { ok: true };
    });
    // ---------- Gestão de usuários (admin) ----------
    const admin = { preHandler: requireRole('ADMIN') };
    app.get('/api/users', admin, async () => {
        return db.select({ id: users.id, name: users.name, username: users.username, role: roles.code, active: users.active, createdAt: users.createdAt })
            .from(users).innerJoin(roles, eq(roles.id, users.roleId)).orderBy(asc(users.name));
    });
    const roleSchema = z.enum(['ADMIN', 'CAIXA', 'COZINHA']);
    const roleId = async (code) => (await db.select().from(roles).where(eq(roles.code, code)))[0].id;
    app.post('/api/users', admin, async (req) => {
        const b = parse(z.object({
            name: z.string().trim().min(2),
            username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{2,30}$/, 'use letras minúsculas, números, ponto ou traço'),
            password: z.string().min(4, 'mínimo 4 caracteres'),
            role: roleSchema,
        }), req.body);
        const exists = await db.select().from(users).where(eq(users.username, b.username));
        if (exists.length)
            throw conflict('Já existe um usuário com esse login.');
        const [u] = await db.insert(users).values({
            name: b.name, username: b.username, passwordHash: await hashPassword(b.password), roleId: await roleId(b.role),
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
        }), req.body);
        const [u] = await db.select().from(users).where(eq(users.id, id));
        if (!u)
            throw notFound('Usuário não encontrado.');
        if (id === me(req).id && (b.active === false || (b.role && b.role !== 'ADMIN'))) {
            throw conflict('Você não pode desativar nem rebaixar o seu próprio usuário.');
        }
        if (b.active === false || (b.role && b.role !== 'ADMIN')) {
            const adminRole = await roleId('ADMIN');
            if (u.roleId === adminRole) {
                const others = await db.select().from(users).where(and(eq(users.roleId, adminRole), eq(users.active, true), ne(users.id, id)));
                if (!others.length)
                    throw conflict('É preciso manter ao menos um administrador ativo.');
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
        if (Object.keys(set).length)
            await db.update(users).set(set).where(eq(users.id, id));
        const what = [b.name && 'nome', b.role && `perfil → ${b.role}`, b.active !== undefined && (b.active ? 'ativado' : 'desativado'), b.password && 'senha redefinida']
            .filter(Boolean).join(', ');
        await audit(db, { userId: me(req).id, action: 'user.update', entityType: 'user', entityId: id, message: `${me(req).name} alterou o usuário ${u.name}: ${what}.` });
        return { ok: true };
    });
}
