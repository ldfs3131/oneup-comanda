import { db } from '../db/index.js';
import { categories, optionGroups, options, products } from '../db/schema.js';
/**
 * Cardápio oficial informado pelo proprietário (27/09/2026).
 * Bebidas: categoria criada vazia — preços ainda não informados (não inventar).
 */
const ESPETOS = ['Contra-filé', 'Frango', 'Medalhão de Frango', 'Coração', 'Lombinho', 'Kafta', 'Queijo Coalho'];
export const MENU = [
    {
        name: 'Petiscos', sendsToKitchen: true, products: [
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
        name: 'Espetos', sendsToKitchen: true, products: [
            ...ESPETOS.map((e) => ({
                name: `Espeto de ${e}`, priceCents: 1300,
                groups: [{ name: 'Acompanhamento', required: false, options: [['Com farofa e vinagrete', 500]] }],
            })),
            {
                name: 'Jantinha Completa', priceCents: 3000,
                description: 'Arroz, feijão tropeiro, mandioca, vinagrete e 1 espeto à escolha',
                groups: [{ name: 'Espeto', required: true, options: ESPETOS.map((e) => [e, 0]) }],
            },
        ],
    },
    {
        name: 'Pratos', sendsToKitchen: true, products: [
            { name: 'Filé de Frango à Milanesa', priceCents: 3499 },
            { name: 'Filé de Frango Grelhado', priceCents: 2599 },
            {
                name: 'Strogonoff de Frango', priceCents: 2599,
                groups: [{ name: 'Acompanhamento', required: true, options: [['Batata palha', 0], ['Batata frita', 300]] }],
            },
            { name: 'Filé de Frango à Parmegiana', priceCents: 3990 },
            { name: 'Filé Mignon à Parmegiana', priceCents: 4299 },
            { name: 'Contra-Filé', priceCents: 3990 },
            { name: 'Filé de Tilápia', priceCents: 3990 },
            { name: 'Feijoada Completa', priceCents: 3000 },
        ],
    },
    { name: 'Bebidas', sendsToKitchen: false, products: [] },
];
/** Cadastra o cardápio se ainda não houver nenhuma categoria. */
export async function seedMenu(tx = db) {
    const existing = await tx.select().from(categories).limit(1);
    if (existing.length)
        return false;
    for (const [ci, c] of MENU.entries()) {
        const [cat] = await tx.insert(categories).values({ name: c.name, sendsToKitchen: c.sendsToKitchen, sortOrder: ci }).returning();
        for (const [pi, p] of c.products.entries()) {
            const [prod] = await tx.insert(products).values({
                categoryId: cat.id, name: p.name, priceCents: p.priceCents, description: p.description ?? '',
                sendsToKitchen: c.sendsToKitchen, sortOrder: pi,
            }).returning();
            for (const [gi, g] of (p.groups ?? []).entries()) {
                const [grp] = await tx.insert(optionGroups).values({ productId: prod.id, name: g.name, required: g.required, multiple: false, sortOrder: gi }).returning();
                await tx.insert(options).values(g.options.map(([name, delta], oi) => ({ groupId: grp.id, name, priceDeltaCents: delta, sortOrder: oi })));
            }
        }
    }
    return true;
}
