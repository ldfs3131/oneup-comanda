import { respostaCompartilhada } from '../lib/cacheRota.js';
import { idempotent } from '../lib/idempotency.js';
import { z } from 'zod';
import { currentContext, db, nextNumber } from '../db/index.js';
import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { accounts, cancellations, customers, deliverySettings, orderItems, orders, restaurantSettings } from '../db/schema.js';
import { HttpError, bad, brl, conflict, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { notify } from '../realtime.js';
import { currentRegister, insertOrder, upsertCustomer } from '../services/accounts.js';
import { loadMenu } from './menu.js';
import { configuracoesPublicas, lerConfig } from '../services/configuracoes.js';
import { licencaAtual } from '../lib/licenca.js';
import { normalizarWhatsapp } from '../lib/telefone.js';
/**
 * Cardápio online no ar? Licença ATIVA: sim. SUSPENSA: não. SÓ CONSULTA: só enquanto durar um dia que já estava
 * aberto (nunca trava no meio do serviço); encerrado o dia, sai do ar.
 */
async function cardapioOnlineNoAr() {
    const lic = await licencaAtual();
    if (lic.efetivo === 'ATIVO')
        return true;
    if (lic.efetivo === 'SUSPENSO')
        return false;
    const reg = await currentRegister(db);
    return !!reg && !reg.somenteReceber;
}
const MSG_FORA_DO_AR = 'O cardápio online deste restaurante está fora do ar no momento. Peça direto no balcão.';
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
// WhatsApp brasileiro normalizado: fica em lib/telefone.ts (o caixa usa a mesma regra para identificar o cliente)
export { normalizarWhatsapp };
export const textoConsentimento = (restaurante) => `Aceito receber ofertas e novidades do ${restaurante} pelo WhatsApp. Posso pedir para parar quando quiser.`;
/** Horas que o link de acompanhamento continua respondendo depois de o pedido terminar (LGPD: dado só enquanto precisa). */
export const ACOMPANHAMENTO_HORAS = 48;
async function settings() {
    const [r] = await db.select().from(restaurantSettings).limit(1);
    const [d] = await db.select().from(deliverySettings).limit(1);
    return { r, d };
}
export async function publicRoutes(app) {
    app.get('/api/public/menu', { preHandler: respostaCompartilhada('cardapio-publico', 'menu', 30000) }, async () => {
        const { r, d } = await settings();
        const cfg = await configuracoesPublicas();
        if (!(await cardapioOnlineNoAr()))
            return { enabled: false, foraDoAr: true, motivo: MSG_FORA_DO_AR, name: r.name, whatsappNumber: null, config: cfg };
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
        if (!(await cardapioOnlineNoAr()))
            throw new HttpError(403, MSG_FORA_DO_AR, 'CARDAPIO_FORA_DO_AR');
        if (!r.qrEnabled)
            throw new HttpError(403, 'Pedidos pelo QR Code não estão disponíveis.');
        if (!r.isOpen)
            throw conflict('O restaurante está fechado no momento.');
        const b = parse(z.object({
            customerName: z.string().trim().min(2, 'informe o seu nome').max(60),
            phone: z.string().trim().min(8, 'informe o seu WhatsApp com DDD').max(30),
            aceitaOfertas: z.boolean().default(false),
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
        const phone = normalizarWhatsapp(b.phone);
        if (!phone)
            throw bad('WhatsApp inválido: use DDD + número, por exemplo (11) 91234-5678.');
        if (b.mode === 'ENTREGA' && !d.isOpen)
            throw conflict('O delivery está fechado no momento.');
        if (b.mode === 'ENTREGA' && !b.location)
            throw bad('Informe o endereço/local da entrega.');
        const modeLabel = { BALCAO: 'Retirar no balcão', LOCAL: 'Consumo no local', ENTREGA: 'Entrega' }[b.mode];
        const res = await db.transaction(async (tx) => {
            const reg = await currentRegister(tx);
            const number = await nextNumber(tx, 'account');
            const accNote = [modeLabel, b.location].filter(Boolean).join(' — ');
            const customerId = await upsertCustomer(tx, b.customerName, null, phone);
            // Consentimento: só grava quando o cliente marca a caixinha (texto exato e momento). Desmarcar num pedido não apaga um "sim" anterior.
            if (customerId && b.aceitaOfertas) {
                await tx.update(customers).set({ aceitaOfertas: true, aceitaOfertasEm: new Date(), aceitaOfertasTexto: textoConsentimento(r.name), ofertasRevogadasEm: null }).where(eq(customers.id, customerId));
            }
            const [acc] = await tx.insert(accounts).values({
                number, customerName: b.customerName, phone, customerId, note: accNote, origin: b.mode === 'ENTREGA' ? 'DELIVERY' : 'QR_CODE',
                cashRegisterId: reg?.id ?? null,
            }).returning();
            const o = await insertOrder(tx, { accountId: acc.id, items: b.items, note: b.note, userId: null, origin: 'QR_CODE', cashRegisterId: reg?.id ?? null, consumptionType: b.mode === 'ENTREGA' ? 'VIAGEM' : 'LOCAL' });
            // Código aleatório para o cliente acompanhar o pedido (não dá para adivinhar o de outra pessoa)
            const token = randomBytes(12).toString('base64url');
            await tx.update(orders).set({ publicToken: token }).where(eq(orders.id, o.order.id));
            await audit(tx, { action: 'qr.order', entityType: 'order', entityId: o.order.id, message: `Cliente${customerId ? ` #${customerId}` : ''} enviou pelo QR Code o pedido #${o.order.number} da conta #${acc.number} (${brl(o.totalCents)}, ${modeLabel}). Aguardando confirmação do caixa.` });
            return { acc, o, token };
        });
        notify.qrNew({ orderNumber: res.o.order.number, accountNumber: res.acc.number, customerName: res.acc.customerName });
        notify.ordersChanged();
        notify.accountsChanged(res.acc.id);
        return { orderNumber: res.o.order.number, totalCents: res.o.totalCents, token: res.token };
    }
    // Acompanhamento do pedido pelo código: só etapas e itens (sem nome, telefone nem estimativa)
    app.get('/api/public/pedido/:token', async (req, reply) => {
        const { token } = parse(z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{12,40}$/) }), req.params);
        const [o] = await db.select({ id: orders.id, number: orders.number, status: orders.status, origin: orders.origin, goesToKitchen: orders.goesToKitchen, createdAt: orders.createdAt, confirmedAt: orders.confirmedAt, startedAt: orders.startedAt, readyAt: orders.readyAt, deliveredAt: orders.deliveredAt })
            .from(orders).where(eq(orders.publicToken, token));
        if (!o)
            return reply.code(404).send({ error: 'Pedido não encontrado.' });
        // o código de acompanhamento vale até 48 h depois de o pedido ser entregue ou recusado
        if (o.status === 'DELIVERED' || o.status === 'CANCELLED') {
            let fim = o.deliveredAt;
            if (o.status === 'CANCELLED') {
                const [c] = await db.select({ em: cancellations.createdAt }).from(cancellations).where(eq(cancellations.orderId, o.id)).orderBy(sql `id DESC`).limit(1);
                fim = c?.em ?? o.createdAt;
            }
            if (fim && Date.now() - new Date(fim).getTime() > ACOMPANHAMENTO_HORAS * 3600_000) {
                reply.header('Cache-Control', 'no-store');
                return reply.code(410).send({ error: 'Acompanhamento encerrado. Este link vale até 48 horas depois de o pedido ser entregue.', encerrado: true });
            }
        }
        const itens = await db.select({ nome: orderItems.productName, quantidade: orderItems.quantity, preco: orderItems.unitPriceCents, opcoes: orderItems.optionsSnapshot, status: orderItems.status })
            .from(orderItems).where(eq(orderItems.orderId, o.id));
        let motivo = null;
        if (o.status === 'CANCELLED') {
            const [c] = await db.select({ reason: cancellations.reason }).from(cancellations).where(and(eq(cancellations.orderId, o.id), eq(cancellations.target, 'ORDER'))).orderBy(sql `id DESC`).limit(1);
            motivo = c?.reason ?? null;
        }
        const etapa = o.status === 'CANCELLED' ? 'recusado'
            : o.status === 'AWAITING_CONFIRMATION' ? 'aguardando'
                : o.status === 'DELIVERED' ? 'entregue'
                    : o.status === 'READY' ? 'pronto'
                        : o.status === 'IN_PREPARATION' ? 'preparo'
                            : 'confirmado';
        const ativos = itens.filter((i) => i.status === 'ACTIVE' || o.status === 'CANCELLED');
        reply.header('Cache-Control', 'no-store');
        return {
            numero: o.number, etapa, motivo, cozinha: o.goesToKitchen,
            horarios: { enviado: o.createdAt, confirmado: o.confirmedAt, preparo: o.startedAt, pronto: o.readyAt, entregue: o.deliveredAt },
            itens: ativos.map((i) => ({ nome: i.nome, quantidade: i.quantidade, opcoes: (i.opcoes ?? []).map((x) => x.name) })),
            totalCents: ativos.reduce((t, i) => t + i.preco * i.quantidade, 0),
        };
    });
}
