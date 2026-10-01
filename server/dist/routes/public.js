import { respostaCompartilhada } from '../lib/cacheRota.js';
import { idempotent } from '../lib/idempotency.js';
import { z } from 'zod';
import { currentContext, db, nextNumber } from '../db/index.js';
import { accounts, deliverySettings, restaurantSettings } from '../db/schema.js';
import { HttpError, bad, brl, conflict, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { notify } from '../realtime.js';
import { currentRegister, insertOrder } from '../services/accounts.js';
import { loadMenu } from './menu.js';
import { configuracoesPublicas, lerConfig } from '../services/configuracoes.js';
/*
 * Limites do canal público (sem login). Todos os clientes no Wi-Fi do restaurante saem pelo MESMO IP,
 * então o limite principal é por APARELHO (identificador aleatório guardado no navegador do cliente):
 *  - por aparelho: 6 pedidos ENVIADOS em 10 min (erros não contam)
 *  - por IP (proteção contra robô): 150 tentativas por minuto
 */
const hits = new Map();
setInterval(() => { const now = Date.now(); for (const [k, l] of hits)
    if (!l.some((t) => now - t < 3_600_000))
        hits.delete(k); }, 10 * 60_000).unref();
function excedeu(chave, max, janelaMs) {
    const now = Date.now();
    const list = (hits.get(chave) ?? []).filter((t) => now - t < janelaMs);
    hits.set(chave, list);
    return list.length >= max;
}
function registrar(chave) {
    if (hits.size > 200_000)
        hits.clear();
    (hits.get(chave) ?? hits.set(chave, []).get(chave)).push(Date.now());
}
const LIMITE_APARELHO = { max: 6, janela: 10 * 60_000 };
const LIMITE_IP = { max: 150, janela: 60_000 };
async function settings() {
    const [r] = await db.select().from(restaurantSettings).limit(1);
    const [d] = await db.select().from(deliverySettings).limit(1);
    return { r, d };
}
export async function publicRoutes(app) {
    app.get('/api/public/menu', { preHandler: respostaCompartilhada('cardapio-publico', 'menu', 30000) }, async () => {
        const { r, d } = await settings();
        const cfg = await configuracoesPublicas();
        if (!r.qrEnabled)
            return { enabled: false, name: r.name, whatsappNumber: r.whatsappNumber, config: cfg };
        const menu = await loadMenu(db, { includeInactive: false, onlyAvailable: true, semMaisVendidos: true });
        const marcaAcabou = await lerConfig('esconder_sem_estoque');
        return {
            enabled: true, name: r.name, isOpen: r.isOpen, deliveryOpen: d.isOpen, whatsappNumber: r.whatsappNumber, config: cfg,
            categories: menu.filter((c) => c.products.length).map((c) => ({
                id: c.id, name: c.name,
                products: c.products.map((p) => ({
                    id: p.id, name: p.name, description: p.description, priceCents: p.priceCents, imageUrl: p.imageUrl, soldOut: marcaAcabou && p.trackStock && p.stockQty <= 0,
                    groups: p.groups.map((g) => ({ id: g.id, name: g.name, required: g.required, multiple: g.multiple, options: g.options.map((o) => ({ id: o.id, name: o.name, priceDeltaCents: o.priceDeltaCents })) })),
                })),
            })),
        };
    });
    app.post('/api/public/orders', async (req) => {
        const emp = currentContext()?.empresaId ?? 0;
        const chaveIp = `ip:${emp}:${req.ip}`;
        if (excedeu(chaveIp, LIMITE_IP.max, LIMITE_IP.janela))
            throw new HttpError(429, 'Muitos pedidos em pouco tempo. Aguarde um instante ou peça no balcão.');
        registrar(chaveIp);
        const ap = req.headers['x-aparelho'];
        const chaveAparelho = `ap:${emp}:${typeof ap === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(ap) ? ap : req.ip}`;
        if (excedeu(chaveAparelho, LIMITE_APARELHO.max, LIMITE_APARELHO.janela))
            throw new HttpError(429, 'Você já enviou vários pedidos agora há pouco. Aguarde a confirmação ou chame um atendente.');
        return idempotent(req, 'public.order', async () => {
            const r = await criarPedidoPublico(req);
            registrar(chaveAparelho);
            return r;
        });
    });
    async function criarPedidoPublico(req) {
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
    }
}
