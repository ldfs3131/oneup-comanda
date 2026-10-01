import { z } from 'zod';
import { and, asc, eq, isNull, max, sql } from 'drizzle-orm';
import { createWriteStream, mkdirSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { db, empresaAtual } from '../db/index.js';
import { categories, optionGroups, options, orderItems, productCosts, products } from '../db/schema.js';
import { me, requireRole } from '../auth.js';
import { bad, brl, conflict, idParam, notFound, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { notify } from '../realtime.js';
import { config } from '../config.js';
export async function loadMenu(tx, f) {
    const cats = await tx.select().from(categories).orderBy(asc(categories.sortOrder), asc(categories.id));
    const prods = await tx.select().from(products).orderBy(asc(products.sortOrder), asc(products.id));
    const groups = await tx.select().from(optionGroups).orderBy(asc(optionGroups.sortOrder), asc(optionGroups.id));
    const opts = await tx.select().from(options).orderBy(asc(options.sortOrder), asc(options.id));
    const show = (active, available = true) => (f.includeInactive || active) && (!f.onlyAvailable || available);
    // ranking de mais vendidos (últimos 30 dias) para ordenar o caixa
    const sold = (await tx.execute(sql `
    SELECT oi.product_id, SUM(oi.quantity)::int AS q FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE oi.status = 'ACTIVE' AND oi.product_id IS NOT NULL AND o.created_at > now() - interval '30 days'
    GROUP BY oi.product_id`)).rows;
    const soldMap = new Map(sold.map((r) => [Number(r.product_id), Number(r.q)]));
    return cats
        .filter((c) => show(c.active))
        .map((c) => ({
        ...c,
        products: prods.filter((p) => p.categoryId === c.id && show(p.active, p.available)).map((p) => ({
            ...p,
            sold30: soldMap.get(p.id) ?? 0,
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
        stockProductId: z.number().int().positive().nullable().optional(),
    })).min(1, 'cada grupo precisa de ao menos uma opção'),
});
const productSchema = z.object({
    categoryId: z.number().int().positive(),
    name: z.string().trim().min(2),
    description: z.string().trim().max(500).default(''),
    priceCents: z.number().int().min(0).max(100_000_00),
    costCents: z.number().int().min(0).max(100_000_00).nullable().optional(),
    applyCostToPast: z.boolean().optional(),
    trackStock: z.boolean().default(false),
    lowStockAt: z.number().int().min(0).max(10000).default(3),
    prepMinutes: z.number().int().min(1).max(240).default(15),
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
                await tx.update(options).set({ name: o.name, priceDeltaCents: o.priceDeltaCents, available: o.available, sortOrder: oi, active: true, stockProductId: o.stockProductId ?? null })
                    .where(eq(options.id, o.id));
                keepOpt.push(o.id);
            }
            else {
                const [n] = await tx.insert(options).values({ groupId: gid, name: o.name, priceDeltaCents: o.priceDeltaCents, available: o.available, sortOrder: oi, stockProductId: o.stockProductId ?? null })
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
async function validateStockLinks(tx, groups) {
    for (const g of groups)
        for (const o of g.options) {
            if (!o.stockProductId)
                continue;
            const [p] = await tx.select().from(products).where(eq(products.id, o.stockProductId));
            if (!p || !p.trackStock)
                throw bad(`A opção "${o.name}" aponta para um produto sem controle de estoque.`);
        }
}
/** Registra custo com histórico; opcionalmente aplica às vendas anteriores que não tinham custo. */
async function recordCost(tx, productId, costCents, oldCost, applyPast, userId) {
    if (costCents === undefined || costCents === oldCost)
        return '';
    if (costCents !== null)
        await tx.insert(productCosts).values({ productId, costCents, userId });
    let applied = 0;
    if (costCents !== null && applyPast) {
        const r = await tx.update(orderItems).set({ unitCostCents: costCents })
            .where(and(eq(orderItems.productId, productId), isNull(orderItems.unitCostCents))).returning({ id: orderItems.id });
        applied = r.length;
    }
    return `custo ${oldCost == null ? 'não informado' : brl(oldCost)} → ${costCents == null ? 'não informado' : brl(costCents)}${applied ? ` (aplicado a ${applied} venda(s) anteriores sem custo)` : ''}`;
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
    app.delete('/api/categories/:id', admin, async (req) => {
        const { id } = parse(idParam, req.params);
        const [c] = await db.select().from(categories).where(eq(categories.id, id));
        if (!c)
            throw notFound();
        const used = await db.select({ id: products.id }).from(products).where(eq(products.categoryId, id)).limit(1);
        if (used.length)
            throw conflict('Esta categoria já teve produtos. Desative-a em vez de excluir (o histórico precisa dela).');
        await db.delete(categories).where(eq(categories.id, id));
        await audit(db, { userId: me(req).id, action: 'menu.category.delete', entityType: 'category', entityId: id, message: `${me(req).name} excluiu a categoria vazia "${c.name}".` });
        notify.menuChanged();
        return { ok: true };
    });
    // Aprovar tempo de preparo sugerido (admin)
    app.post('/api/products/:id/prep', admin, async (req) => {
        const { id } = parse(idParam, req.params);
        const { minutes } = parse(z.object({ minutes: z.number().int().min(1).max(240) }), req.body);
        const [p] = await db.select().from(products).where(eq(products.id, id));
        if (!p)
            throw notFound();
        await db.update(products).set({ prepMinutes: minutes, updatedAt: new Date() }).where(eq(products.id, id));
        await audit(db, { userId: me(req).id, action: 'menu.product.prep', entityType: 'product', entityId: id, message: `${me(req).name} ajustou o tempo de preparo de "${p.name}": ${p.prepMinutes} → ${minutes} min.` });
        notify.menuChanged();
        return { ok: true };
    });
    // ----- Produtos -----
    app.post('/api/products', admin, async (req) => {
        const b = parse(productSchema, req.body);
        const p = await db.transaction(async (tx) => {
            const [{ m }] = await tx.select({ m: max(products.sortOrder) }).from(products).where(eq(products.categoryId, b.categoryId));
            const { groups, applyCostToPast, ...data } = b;
            if (data.active && data.priceCents <= 0)
                throw bad('Produto ativo precisa de preço maior que zero.');
            await validateStockLinks(tx, groups);
            const [p] = await tx.insert(products).values({ ...data, costCents: data.costCents ?? null, sortOrder: (m ?? 0) + 1 }).returning();
            await saveGroups(tx, p.id, groups);
            await recordCost(tx, p.id, data.costCents, null, applyCostToPast, me(req).id);
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
            const { groups, applyCostToPast, ...data } = b;
            if (data.active && data.priceCents <= 0)
                throw bad('Produto ativo precisa de preço maior que zero.');
            await validateStockLinks(tx, groups);
            if (data.categoryId !== old.categoryId) {
                const [{ m }] = await tx.select({ m: max(products.sortOrder) }).from(products).where(eq(products.categoryId, data.categoryId));
                Object.assign(data, { sortOrder: (m ?? 0) + 1 });
            }
            await tx.update(products).set({ ...data, updatedAt: new Date() }).where(eq(products.id, id));
            await saveGroups(tx, id, groups);
            const changes = [];
            const costMsg = await recordCost(tx, id, data.costCents, old.costCents, applyCostToPast, me(req).id);
            if (costMsg)
                changes.push(costMsg);
            if (old.trackStock !== data.trackStock)
                changes.push(data.trackStock ? 'passou a controlar estoque' : 'deixou de controlar estoque');
            if (old.sendsToKitchen !== data.sendsToKitchen)
                changes.push(data.sendsToKitchen ? 'vai para a cozinha' : 'não vai para a cozinha');
            if (old.prepMinutes !== data.prepMinutes)
                changes.push(`tempo de preparo ${old.prepMinutes} → ${data.prepMinutes} min`);
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
        // fotos na pasta da própria empresa
        const pasta = join(config.uploadsDir, String(empresaAtual()));
        mkdirSync(pasta, { recursive: true });
        const name = `p${id}-${randomBytes(4).toString('hex')}${ext}`;
        await pipeline(file.file, createWriteStream(join(pasta, name)));
        if (file.file.truncated)
            throw bad('Imagem muito grande (máximo 5 MB).');
        const url = `/uploads/${empresaAtual()}/${name}`;
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
