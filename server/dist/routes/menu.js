import { z } from 'zod';
import { asc, eq, max } from 'drizzle-orm';
import { createWriteStream, mkdirSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { db } from '../db/index.js';
import { categories, optionGroups, options, products } from '../db/schema.js';
import { me, requireRole } from '../auth.js';
import { bad, brl, idParam, notFound, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { notify } from '../realtime.js';
import { config } from '../config.js';
export async function loadMenu(tx, f) {
    const cats = await tx.select().from(categories).orderBy(asc(categories.sortOrder), asc(categories.id));
    const prods = await tx.select().from(products).orderBy(asc(products.sortOrder), asc(products.id));
    const groups = await tx.select().from(optionGroups).orderBy(asc(optionGroups.sortOrder), asc(optionGroups.id));
    const opts = await tx.select().from(options).orderBy(asc(options.sortOrder), asc(options.id));
    const show = (active, available = true) => (f.includeInactive || active) && (!f.onlyAvailable || available);
    return cats
        .filter((c) => show(c.active))
        .map((c) => ({
        ...c,
        products: prods.filter((p) => p.categoryId === c.id && show(p.active, p.available)).map((p) => ({
            ...p,
            groups: groups.filter((g) => g.productId === p.id && show(g.active)).map((g) => ({
                ...g,
                options: opts.filter((o) => o.groupId === g.id && show(o.active, o.available)),
            })),
        })),
    }));
}
const groupSchema = z.object({
    id: z.number().int().positive().optional(),
    name: z.string().trim().min(1),
    required: z.boolean(),
    multiple: z.boolean(),
    options: z.array(z.object({
        id: z.number().int().positive().optional(),
        name: z.string().trim().min(1),
        priceDeltaCents: z.number().int().min(0).max(100_000_00),
        available: z.boolean().default(true),
    })).min(1, 'cada grupo precisa de ao menos uma opção'),
});
const productSchema = z.object({
    categoryId: z.number().int().positive(),
    name: z.string().trim().min(2),
    description: z.string().trim().max(500).default(''),
    priceCents: z.number().int().min(0).max(100_000_00),
    sendsToKitchen: z.boolean(),
    active: z.boolean().default(true),
    available: z.boolean().default(true),
    needsReview: z.boolean().default(false),
    reviewNote: z.string().trim().max(300).nullable().optional(),
    groups: z.array(groupSchema).default([]),
});
async function saveGroups(tx, productId, groups) {
    const existing = await tx.select().from(optionGroups).where(eq(optionGroups.productId, productId));
    const keepGroupIds = [];
    for (const [gi, g] of groups.entries()) {
        let gid = g.id;
        if (gid && existing.some((e) => e.id === gid)) {
            await tx.update(optionGroups).set({ name: g.name, required: g.required, multiple: g.multiple, sortOrder: gi, active: true })
                .where(eq(optionGroups.id, gid));
        }
        else {
            [{ id: gid }] = await tx.insert(optionGroups).values({ productId, name: g.name, required: g.required, multiple: g.multiple, sortOrder: gi })
                .returning({ id: optionGroups.id });
        }
        keepGroupIds.push(gid);
        const exOpts = await tx.select().from(options).where(eq(options.groupId, gid));
        const keepOpt = [];
        for (const [oi, o] of g.options.entries()) {
            if (o.id && exOpts.some((e) => e.id === o.id)) {
                await tx.update(options).set({ name: o.name, priceDeltaCents: o.priceDeltaCents, available: o.available, sortOrder: oi, active: true })
                    .where(eq(options.id, o.id));
                keepOpt.push(o.id);
            }
            else {
                const [n] = await tx.insert(options).values({ groupId: gid, name: o.name, priceDeltaCents: o.priceDeltaCents, available: o.available, sortOrder: oi })
                    .returning({ id: options.id });
                keepOpt.push(n.id);
            }
        }
        // opções removidas ficam inativas (nunca apagadas)
        for (const e of exOpts)
            if (!keepOpt.includes(e.id))
                await tx.update(options).set({ active: false }).where(eq(options.id, e.id));
    }
    for (const e of existing)
        if (!keepGroupIds.includes(e.id))
            await tx.update(optionGroups).set({ active: false }).where(eq(optionGroups.id, e.id));
}
export async function menuRoutes(app) {
    const anyUser = { preHandler: requireRole() };
    const admin = { preHandler: requireRole('ADMIN') };
    const ops = { preHandler: requireRole('CAIXA') };
    app.get('/api/menu', anyUser, async (req) => {
        return loadMenu(db, { includeInactive: me(req).role === 'ADMIN' && req.query.all === '1' });
    });
    // ----- Categorias -----
    app.post('/api/categories', admin, async (req) => {
        const b = parse(z.object({ name: z.string().trim().min(2), sendsToKitchen: z.boolean().default(true) }), req.body);
        const [{ m }] = await db.select({ m: max(categories.sortOrder) }).from(categories);
        const [c] = await db.insert(categories).values({ name: b.name, sendsToKitchen: b.sendsToKitchen, sortOrder: (m ?? 0) + 1 }).returning();
        await audit(db, { userId: me(req).id, action: 'menu.category.create', entityType: 'category', entityId: c.id, message: `${me(req).name} criou a categoria "${c.name}".` });
        notify.menuChanged();
        return c;
    });
    app.patch('/api/categories/:id', admin, async (req) => {
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({
            name: z.string().trim().min(2).optional(), active: z.boolean().optional(),
            sendsToKitchen: z.boolean().optional(), move: z.enum(['up', 'down']).optional(),
        }), req.body);
        const [c] = await db.select().from(categories).where(eq(categories.id, id));
        if (!c)
            throw notFound();
        await db.transaction(async (tx) => {
            const { move, ...rest } = b;
            if (Object.keys(rest).length)
                await tx.update(categories).set(rest).where(eq(categories.id, id));
            if (move)
                await swapOrder(tx, 'category', id, move);
        });
        await audit(db, { userId: me(req).id, action: 'menu.category.update', entityType: 'category', entityId: id, message: `${me(req).name} alterou a categoria "${c.name}".`, data: b });
        notify.menuChanged();
        return { ok: true };
    });
    // ----- Produtos -----
    app.post('/api/products', admin, async (req) => {
        const b = parse(productSchema, req.body);
        const p = await db.transaction(async (tx) => {
            const [{ m }] = await tx.select({ m: max(products.sortOrder) }).from(products).where(eq(products.categoryId, b.categoryId));
            const { groups, ...data } = b;
            const [p] = await tx.insert(products).values({ ...data, sortOrder: (m ?? 0) + 1 }).returning();
            await saveGroups(tx, p.id, groups);
            await audit(tx, { userId: me(req).id, action: 'menu.product.create', entityType: 'product', entityId: p.id, message: `${me(req).name} cadastrou "${p.name}" por ${brl(p.priceCents)}.` });
            return p;
        });
        notify.menuChanged();
        return p;
    });
    app.put('/api/products/:id', admin, async (req) => {
        const { id } = parse(idParam, req.params);
        const b = parse(productSchema, req.body);
        await db.transaction(async (tx) => {
            const [old] = await tx.select().from(products).where(eq(products.id, id));
            if (!old)
                throw notFound('Produto não encontrado.');
            const { groups, ...data } = b;
            if (data.categoryId !== old.categoryId) {
                const [{ m }] = await tx.select({ m: max(products.sortOrder) }).from(products).where(eq(products.categoryId, data.categoryId));
                Object.assign(data, { sortOrder: (m ?? 0) + 1 });
            }
            await tx.update(products).set({ ...data, updatedAt: new Date() }).where(eq(products.id, id));
            await saveGroups(tx, id, groups);
            const changes = [];
            if (old.priceCents !== data.priceCents)
                changes.push(`preço ${brl(old.priceCents)} → ${brl(data.priceCents)}`);
            if (old.name !== data.name)
                changes.push(`nome "${old.name}" → "${data.name}"`);
            if (old.active !== data.active)
                changes.push(data.active ? 'reativado' : 'desativado');
            if (old.available !== data.available)
                changes.push(data.available ? 'disponível' : 'indisponível');
            await audit(tx, {
                userId: me(req).id, action: 'menu.product.update', entityType: 'product', entityId: id,
                message: `${me(req).name} editou "${data.name}"${changes.length ? `: ${changes.join(', ')}` : ''}.`,
                data: { before: { priceCents: old.priceCents, name: old.name }, after: { priceCents: data.priceCents, name: data.name } },
            });
        });
        notify.menuChanged();
        return { ok: true };
    });
    // Disponibilidade rápida: caixa e admin ("acabou" / "voltou")
    app.patch('/api/products/:id/availability', ops, async (req) => {
        const { id } = parse(idParam, req.params);
        const { available } = parse(z.object({ available: z.boolean() }), req.body);
        const [p] = await db.update(products).set({ available, updatedAt: new Date() }).where(eq(products.id, id)).returning();
        if (!p)
            throw notFound();
        await audit(db, { userId: me(req).id, action: 'menu.availability', entityType: 'product', entityId: id, message: `${me(req).name} marcou "${p.name}" como ${available ? 'DISPONÍVEL' : 'INDISPONÍVEL'}.` });
        notify.menuChanged();
        return { ok: true };
    });
    app.patch('/api/options/:id/availability', ops, async (req) => {
        const { id } = parse(idParam, req.params);
        const { available } = parse(z.object({ available: z.boolean() }), req.body);
        const [o] = await db.update(options).set({ available }).where(eq(options.id, id)).returning();
        if (!o)
            throw notFound();
        await audit(db, { userId: me(req).id, action: 'menu.availability', entityType: 'option', entityId: id, message: `${me(req).name} marcou a opção "${o.name}" como ${available ? 'DISPONÍVEL' : 'INDISPONÍVEL'}.` });
        notify.menuChanged();
        return { ok: true };
    });
    app.post('/api/products/:id/move', admin, async (req) => {
        const { id } = parse(idParam, req.params);
        const { direction } = parse(z.object({ direction: z.enum(['up', 'down']) }), req.body);
        await db.transaction((tx) => swapOrder(tx, 'product', id, direction));
        notify.menuChanged();
        return { ok: true };
    });
    app.post('/api/products/:id/image', admin, async (req) => {
        const { id } = parse(idParam, req.params);
        const [p] = await db.select().from(products).where(eq(products.id, id));
        if (!p)
            throw notFound();
        const file = await req.file({ limits: { fileSize: 5 * 1024 * 1024 } });
        if (!file)
            throw bad('Envie uma imagem.');
        const ext = extname(file.filename).toLowerCase();
        if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext))
            throw bad('Use JPG, PNG ou WEBP.');
        mkdirSync(config.uploadsDir, { recursive: true });
        const name = `p${id}-${randomBytes(4).toString('hex')}${ext}`;
        await pipeline(file.file, createWriteStream(join(config.uploadsDir, name)));
        if (file.file.truncated)
            throw bad('Imagem muito grande (máximo 5 MB).');
        const url = `/uploads/${name}`;
        await db.update(products).set({ imageUrl: url, updatedAt: new Date() }).where(eq(products.id, id));
        await audit(db, { userId: me(req).id, action: 'menu.product.image', entityType: 'product', entityId: id, message: `${me(req).name} trocou a foto de "${p.name}".` });
        notify.menuChanged();
        return { imageUrl: url };
    });
}
async function swapOrder(tx, kind, id, dir) {
    if (kind === 'category') {
        const all = await tx.select().from(categories).orderBy(asc(categories.sortOrder), asc(categories.id));
        await reorder(all.map((c) => c.id), id, dir, async (cid, i) => { await tx.update(categories).set({ sortOrder: i }).where(eq(categories.id, cid)); });
    }
    else {
        const [p] = await tx.select().from(products).where(eq(products.id, id));
        if (!p)
            throw notFound();
        const all = await tx.select().from(products).where(eq(products.categoryId, p.categoryId)).orderBy(asc(products.sortOrder), asc(products.id));
        await reorder(all.map((x) => x.id), id, dir, async (pid, i) => { await tx.update(products).set({ sortOrder: i }).where(eq(products.id, pid)); });
    }
}
async function reorder(ids, id, dir, save) {
    const i = ids.indexOf(id);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= ids.length)
        return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    for (const [k, v] of ids.entries())
        await save(v, k);
}
