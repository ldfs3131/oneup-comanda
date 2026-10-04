import { salvarImagem, validarIcone } from '../lib/imagem.js';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { configHistorico, paymentMethods } from '../db/schema.js';
import { me, requireRole } from '../auth.js';
import { bad, idParam, notFound, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { notify } from '../realtime.js';
import { aplicarConfiguracoes, historico, schemaPadrao, schemaPatch, telaConfiguracoes, voltarAoPadrao } from '../services/configuracoes.js';
const pct = (bp) => `${(bp / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
/** Personalização do restaurante pelo Dono (perfil ADMIN da empresa até a fase de perfis por pessoa). */
export async function configuracoesRoutes(app) {
    const dono = { preHandler: requireRole('ADMIN') };
    app.get('/api/configuracoes', dono, async (req) => telaConfiguracoes(me(req)));
    app.patch('/api/configuracoes', dono, async (req) => {
        const { valores } = parse(schemaPatch, req.body);
        const r = await aplicarConfiguracoes(valores, me(req));
        if (r.alteradas.length)
            notify.settingsChanged();
        return { ...r, tela: await telaConfiguracoes(me(req)) };
    });
    app.post('/api/configuracoes/padrao', dono, async (req) => {
        const { chaves } = parse(schemaPadrao, req.body);
        const r = await voltarAoPadrao(chaves, me(req));
        if (r.alteradas.length)
            notify.settingsChanged();
        return { ...r, tela: await telaConfiguracoes(me(req)) };
    });
    app.get('/api/configuracoes/historico', dono, async (req) => {
        const { chave } = parse(z.object({ chave: z.string().max(60).optional() }), req.query);
        return historico(chave, me(req));
    });
    /** Logotipo: gravado na pasta da própria empresa. */
    /** Imagens do catálogo (logotipo, ícone do app): cada uma com a sua regra. */
    app.post('/api/configuracoes/imagem/:chave', dono, async (req) => {
        const { chave } = parse(z.object({ chave: z.enum(['logo', 'icone_app']) }), req.params);
        const url = await salvarImagem(req, chave === 'logo' ? 'logo' : 'icone', 2 * 1024 * 1024, chave === 'icone_app' ? validarIcone : undefined);
        await aplicarConfiguracoes({ [chave]: url }, me(req));
        notify.settingsChanged();
        return { [chave]: url };
    });
    app.post('/api/configuracoes/logo', dono, async (req) => {
        const url = await salvarImagem(req, 'logo', 2 * 1024 * 1024);
        await aplicarConfiguracoes({ logo: url }, me(req));
        notify.settingsChanged();
        return { logo: url };
    });
    /** Formas de pagamento: ligar, desligar, renomear e ordenar (o tipo "dinheiro" não muda). */
    app.patch('/api/payment-methods/:id', dono, async (req) => {
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({
            name: z.string().trim().min(2).max(30).optional(),
            active: z.boolean().optional(),
            sortOrder: z.number().int().min(0).max(99).optional(),
            // taxa da maquininha em % (ex.: 4.28). Vale para os próximos recebimentos; o passado fica como foi.
            taxaPct: z.number().min(0).max(20).optional(),
        }), req.body);
        const user = me(req);
        await db.transaction(async (tx) => {
            const [m] = await tx.select().from(paymentMethods).where(eq(paymentMethods.id, id)).for('update');
            if (!m)
                throw notFound('Forma de pagamento não encontrada.');
            if (b.active === false) {
                const ativas = (await tx.select().from(paymentMethods)).filter((x) => x.active && x.id !== id);
                if (!ativas.length)
                    throw bad('Deixe pelo menos uma forma de pagamento ligada.');
            }
            const { taxaPct, ...resto } = b;
            const set = { ...resto, ...(taxaPct === undefined ? {} : { taxaBp: Math.round(taxaPct * 100) }) };
            await tx.update(paymentMethods).set(set).where(eq(paymentMethods.id, id));
            const antes = { name: m.name, active: m.active, sortOrder: m.sortOrder, taxaPct: m.taxaBp / 100 };
            const depois = { ...antes, ...resto, ...(taxaPct === undefined ? {} : { taxaPct: Math.round(taxaPct * 100) / 100 }) };
            await tx.insert(configHistorico).values({ chave: `forma_pagamento:${m.code}`, antes, depois, origem: 'EMPRESA', userId: user.id });
            await audit(tx, { userId: user.id, action: 'config.update', entityType: 'payment_method', entityId: id, message: `${user.name} alterou a forma de pagamento "${m.name}"${b.name && b.name !== m.name ? ` → "${b.name}"` : ''}${b.active === undefined ? '' : b.active ? ' (ligada)' : ' (desligada)'}${taxaPct !== undefined && Math.round(taxaPct * 100) !== m.taxaBp ? ` (taxa ${pct(m.taxaBp)} → ${pct(Math.round(taxaPct * 100))})` : ''}.` });
        });
        notify.settingsChanged();
        return db.select().from(paymentMethods).orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.id));
    });
}
