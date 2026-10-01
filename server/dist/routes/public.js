import { z } from 'zod';
import { currentContext, db, nextNumber } from '../db/index.js';
import { accounts, deliverySettings, restaurantSettings } from '../db/schema.js';
import { HttpError, bad, brl, conflict, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { notify } from '../realtime.js';
import { currentRegister, insertOrder } from '../services/accounts.js';
import { loadMenu } from './menu.js';
// Limite simples por IP para o canal público
const hits = new Map();
function rateLimit(ip, max, windowMs) {
    const now = Date.now();
    ip = `${currentContext()?.empresaId ?? 0}:${ip}`; // limite por empresa + aparelho
    const list = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= max)
        throw new HttpError(429, 'Muitos pedidos em pouco tempo. Aguarde um instante ou peça no balcão.');
    list.push(now);
    hits.set(ip, list);
}
async function settings() {
    const [r] = await db.select().from(restaurantSettings).limit(1);
    const [d] = await db.select().from(deliverySettings).limit(1);
    return { r, d };
}
export async function publicRoutes(app) {
    app.get('/api/public/menu', async () => {
        const { r, d } = await settings();
        if (!r.qrEnabled)
            return { enabled: false, name: r.name, whatsappNumber: r.whatsappNumber };
        const menu = await loadMenu(db, { includeInactive: false, onlyAvailable: true });
        return {
            enabled: true, name: r.name, isOpen: r.isOpen, deliveryOpen: d.isOpen, whatsappNumber: r.whatsappNumber,
            categories: menu.filter((c) => c.products.length).map((c) => ({
                id: c.id, name: c.name,
                products: c.products.map((p) => ({
                    id: p.id, name: p.name, description: p.description, priceCents: p.priceCents, imageUrl: p.imageUrl, soldOut: p.trackStock && p.stockQty <= 0,
                    groups: p.groups.map((g) => ({ id: g.id, name: g.name, required: g.required, multiple: g.multiple, options: g.options.map((o) => ({ id: o.id, name: o.name, priceDeltaCents: o.priceDeltaCents })) })),
                })),
            })),
        };
    });
    app.post('/api/public/orders', async (req) => {
        rateLimit(req.ip, 5, 60_000);
        const { r, d } = await settings();
        if (!r.qrEnabled)
            throw new HttpError(403, 'Pedidos pelo QR Code não estão disponíveis.');
        if (!r.isOpen)
            throw conflict('O restaurante está fechado no momento.');
        const b = parse(z.object({
            customerName: z.string().trim().max(60).optional().transform((v) => v || null),
            location: z.string().trim().max(120).optional().transform((v) => v || null),
            mode: z.enum(['BALCAO', 'LOCAL', 'ENTREGA']),
            note: z.string().trim().max(200).optional().transform((v) => v || null),
            items: z.array(z.object({
                productId: z.number().int().positive(),
                quantity: z.number().int().min(1).max(20),
                optionIds: z.array(z.number().int().positive()).max(20).default([]),
                note: z.string().trim().max(120).nullable().optional(),
            })).min(1).max(30),
        }), req.body);
        if (b.mode === 'ENTREGA' && !d.isOpen)
            throw conflict('O delivery está fechado no momento.');
        if (b.mode === 'ENTREGA' && !b.location)
            throw bad('Informe o endereço/local da entrega.');
        const modeLabel = { BALCAO: 'Retirar no balcão', LOCAL: 'Consumo no local', ENTREGA: 'Entrega' }[b.mode];
        const res = await db.transaction(async (tx) => {
            const reg = await currentRegister(tx);
            const number = await nextNumber(tx, 'account');
            const accNote = [modeLabel, b.location].filter(Boolean).join(' — ');
            const [acc] = await tx.insert(accounts).values({
                number, customerName: b.customerName, note: accNote, origin: b.mode === 'ENTREGA' ? 'DELIVERY' : 'QR_CODE',
                cashRegisterId: reg?.id ?? null,
            }).returning();
            const o = await insertOrder(tx, { accountId: acc.id, items: b.items, note: b.note, userId: null, origin: 'QR_CODE', cashRegisterId: reg?.id ?? null, consumptionType: b.mode === 'ENTREGA' ? 'VIAGEM' : 'LOCAL' });
            await audit(tx, { action: 'qr.order', entityType: 'order', entityId: o.order.id, message: `Cliente${b.customerName ? ` ${b.customerName}` : ''} enviou pelo QR Code o pedido #${o.order.number} (${brl(o.totalCents)}, ${modeLabel}). Aguardando confirmação do caixa.` });
            return { acc, o };
        });
        notify.qrNew({ orderNumber: res.o.order.number, accountNumber: res.acc.number, customerName: res.acc.customerName });
        notify.ordersChanged();
        notify.accountsChanged(res.acc.id);
        return { orderNumber: res.o.order.number, totalCents: res.o.totalCents };
    });
}
