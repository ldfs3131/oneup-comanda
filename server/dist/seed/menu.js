import { eq, sql } from 'drizzle-orm';
import { db, empresaAtual } from '../db/index.js';
import { categories, optionGroups, options, products, restaurantSettings } from '../db/schema.js';
/**
 * CARDÁPIO DO RESTAURANTE PILOTO (informado pelo proprietário em 27/09/2026) — usado SÓ pelas suítes de teste,
 * pela demonstração e pela instalação do próprio piloto (`--cardapio=piloto`). Restaurante novo NÃO recebe este
 * cardápio: o exemplo genérico fica em `cardapio-exemplo.ts` (`--cardapio=exemplo` e tela da Plataforma ONE UP).
 * Monster: sabores vendidos no Brasil, cadastrados INATIVOS até o proprietário ativar os que tem. Custos: não informados.
 */
const ESPETOS = ['Contra-filé', 'Frango', 'Medalhão de Frango', 'Coração', 'Lombinho', 'Kafta', 'Queijo Coalho'];
const MONSTER = [
    'Energy Green', 'Green Zero Açúcar', 'Absolutely Zero', 'The Doctor', 'Ultra', 'Ultra Peachy Keen', 'Ultra Violet',
    'Ultra Watermelon', 'Ultra Fiesta Mango', 'Ultra Strawberry Dreams', 'Khaotic', 'Mango Loco', 'Rio Punch', 'Pacific Punch', 'Pipeline Punch',
];
export const MENU = [
    {
        name: 'Petiscos', kitchen: true, products: [
            { name: 'Batata Simples', priceCents: 2500 },
            { name: 'Batata Cheddar e Bacon', priceCents: 3500 },
            { name: 'Carne de Sol com Mandioca', priceCents: 6500 },
            { name: 'Frango à Passarinho', priceCents: 4800 },
            { name: 'Calabresa Acebolada', priceCents: 3800 },
            { name: 'Isca de Tilápia', priceCents: 6500 },
            { name: 'Filé com Fritas', priceCents: 6500 },
        ],
    },
    {
        name: 'Espetos', kitchen: true, products: [
            ...ESPETOS.map((e) => ({
                name: `Espeto de ${e}`, priceCents: 1300,
                groups: [{ name: 'Acompanhamento', required: false, options: [{ name: 'Com farofa e vinagrete', delta: 500 }] }],
            })),
            {
                name: 'Jantinha Completa', priceCents: 3000,
                description: 'Arroz, feijão tropeiro, mandioca, vinagrete e 1 espeto à escolha',
                groups: [{ name: 'Espeto', required: true, options: ESPETOS.map((e) => ({ name: e, delta: 0 })) }],
            },
        ],
    },
    {
        name: 'Pratos', kitchen: true, products: [
            { name: 'Filé de Frango à Milanesa', priceCents: 3499 },
            { name: 'Filé de Frango Grelhado', priceCents: 2599 },
            {
                name: 'Strogonoff de Frango', priceCents: 2599,
                groups: [{ name: 'Acompanhamento', required: true, options: [{ name: 'Batata palha', delta: 0 }, { name: 'Batata frita', delta: 300 }] }],
            },
            { name: 'Filé de Frango à Parmegiana', priceCents: 3990 },
            { name: 'Filé Mignon à Parmegiana', priceCents: 4299 },
            { name: 'Contra-Filé', priceCents: 3990 },
            { name: 'Filé de Tilápia', priceCents: 3990 },
            { name: 'Feijoada Completa', priceCents: 3000 },
        ],
    },
    {
        name: 'Hambúrguer', kitchen: true, products: [
            { name: 'Hambúrguer', priceCents: 2500, groups: [{ name: 'Acompanhamento', required: false, options: [{ name: '+ Batata frita', delta: 500 }] }] },
        ],
    },
    {
        name: 'Bebidas', kitchen: false, products: [
            ...['Coca-Cola lata', 'Coca-Cola Zero lata', 'Guaraná Antarctica lata', 'Fanta Laranja lata', 'Sprite lata']
                .map((n) => ({ name: n, priceCents: 600, trackStock: true })),
            { name: 'Limoneto', priceCents: 800, trackStock: true },
            { name: 'Powerade', priceCents: 800, trackStock: true },
            { name: 'Água sem gás', priceCents: 400, trackStock: true },
            { name: 'Água com gás', priceCents: 500, trackStock: true },
            { name: 'Água de coco caixinha', priceCents: 500, trackStock: true },
            ...['Maracujá', 'Morango', 'Uva'].map((s) => ({ name: `Suco Kapo ${s}`, priceCents: 500, trackStock: true })),
            ...['Uva', 'Pêssego', 'Goiaba'].map((s) => ({ name: `Suco Del Valle lata ${s}`, priceCents: 800, trackStock: true })),
            ...MONSTER.map((s) => ({ name: `Monster ${s}`, priceCents: 1400, trackStock: true, active: false })),
        ],
    },
    {
        name: 'Cervejas', kitchen: false, products: [
            { name: 'Heineken', priceCents: 1400, trackStock: true },
            { name: 'Corona', priceCents: 1400, trackStock: true },
            { name: 'Baden Baden', priceCents: 1400, trackStock: true },
        ],
    },
    {
        name: 'Chope', kitchen: false, products: [
            { name: 'Chope 300 ml', priceCents: 700 },
            { name: 'Chope 500 ml', priceCents: 1000 },
            { name: 'Chope IPA 300 ml', priceCents: 1000 },
            { name: 'Chope IPA 500 ml', priceCents: 1500 },
        ],
    },
    {
        name: 'Drinks', kitchen: true, products: [
            { name: 'Caipirinha', priceCents: 2000, groups: [{ name: 'Sabor', required: true, options: [{ name: 'Limão', delta: 0 }, { name: 'Morango', delta: 0 }] }] },
            { name: 'Caipirosca', priceCents: 2500, groups: [{ name: 'Sabor', required: true, options: [{ name: 'Limão', delta: 0 }, { name: 'Morango', delta: 0 }] }] },
            { name: 'Cozumel com chope', priceCents: 1500 },
            {
                name: 'Cozumel com cerveja', priceCents: 2000,
                groups: [{ name: 'Cerveja', required: true, options: ['Heineken', 'Corona', 'Baden Baden'].map((b) => ({ name: b, delta: 0, stockOf: b })) }],
            },
            { name: 'Preparo de Cozumel', priceCents: 700 },
            { name: 'Campari (dose)', priceCents: 1800, kitchen: false },
            { name: 'Whisky Red (dose)', priceCents: 2000, kitchen: false },
        ],
    },
    { name: 'Outros', kitchen: false, products: [] },
];
/**
 * Cadastra o que falta do cardápio do piloto (por nome), sem mexer no que o administrador já editou.
 * Usado pelos testes, pela demonstração e na atualização da V1 → R2 do piloto.
 */
export const seedMenu = (tx = db) => semearCardapio(MENU, tx);
/** Cadastra o que falta de um cardápio (por nome), sem mexer no que o administrador já editou. */
export async function semearCardapio(cardapio, tx = db) {
    let added = 0;
    const catsNow = await tx.select().from(categories);
    let maxCatOrder = Math.max(0, ...catsNow.map((c) => c.sortOrder));
    const created = new Map();
    const pending = [];
    for (const c of cardapio) {
        let cat = catsNow.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
        if (!cat) {
            [cat] = await tx.insert(categories).values({ name: c.name, sendsToKitchen: c.kitchen, sortOrder: ++maxCatOrder }).returning();
        }
        const existing = await tx.select().from(products).where(eq(products.categoryId, cat.id));
        const all = await tx.execute(sql `SELECT lower(name) AS n FROM products`);
        const names = new Set(all.rows.map((r) => r.n));
        let order = Math.max(0, ...existing.map((p) => p.sortOrder));
        for (const p of c.products) {
            if (names.has(p.name.toLowerCase()))
                continue;
            const [prod] = await tx.insert(products).values({
                categoryId: cat.id, name: p.name, priceCents: p.priceCents, description: p.description ?? '',
                sendsToKitchen: p.kitchen ?? c.kitchen, sortOrder: ++order, trackStock: p.trackStock ?? false,
                active: p.active ?? true, prepMinutes: 15,
            }).returning();
            created.set(p.name, prod.id);
            added++;
            for (const [gi, g] of (p.groups ?? []).entries()) {
                const [grp] = await tx.insert(optionGroups).values({ productId: prod.id, name: g.name, required: g.required, multiple: false, sortOrder: gi }).returning();
                for (const [oi, o] of g.options.entries()) {
                    if (o.stockOf)
                        pending.push({ groupId: grp.id, name: o.name, delta: o.delta, stockOf: o.stockOf, sortOrder: oi });
                    else
                        await tx.insert(options).values({ groupId: grp.id, name: o.name, priceDeltaCents: o.delta, sortOrder: oi });
                }
            }
        }
    }
    // opções que baixam estoque de outro produto (ex.: cerveja do cozumel)
    for (const o of pending) {
        const [target] = await tx.select().from(products).where(sql `lower(${products.name}) = lower(${o.stockOf})`);
        await tx.insert(options).values({ groupId: o.groupId, name: o.name, priceDeltaCents: o.delta, sortOrder: o.sortOrder, stockProductId: target?.trackStock ? target.id : null });
    }
    await tx.update(restaurantSettings).set({ menuSeedVersion: 2 }).where(eq(restaurantSettings.id, empresaAtual()));
    return added;
}
/** Atualização automática V1 → R2: roda uma única vez. */
export async function upgradeMenuIfNeeded() {
    const [s] = await db.select().from(restaurantSettings).limit(1);
    if (!s || s.menuSeedVersion >= 2)
        return 0;
    const anyCategory = await db.select({ id: categories.id }).from(categories).limit(1);
    if (!anyCategory.length)
        return 0; // instalação nova: o setup cadastra
    return db.transaction((tx) => seedMenu(tx));
}
