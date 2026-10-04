import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gravarImagem, validarIcone } from '../lib/imagem.js';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { closePools, db, runAsEmpresa, runAsSystem, waitForDatabase } from '../db/index.js';
import { categories, configHistorico, configTravas, empresas, orderItems, paymentMethods, productCosts, products, referenciasExternas, roles, sessions, users, } from '../db/schema.js';
import { hashPassword } from '../auth.js';
import { aplicarConfiguracoes, defDe, lerConfig, CATALOGO } from '../services/configuracoes.js';
import { audit } from '../lib/audit.js';
/**
 * Ferramenta da ONE UP (até o Command Center ter tela):
 *   node dist/scripts/plataforma.js empresas
 *   node dist/scripts/plataforma.js travar    --empresa=<slug> --chave=<chave> --motivo="..."
 *   node dist/scripts/plataforma.js destravar --empresa=<slug> --chave=<chave>
 *   node dist/scripts/plataforma.js definir   --empresa=<slug> --chave=<chave> --valor=<json>
 *   node dist/scripts/plataforma.js catalogo
 *   node dist/scripts/plataforma.js provisionar --arquivo=provisionamento/<empresa>.json   (custos, taxas, base de comparação)
 *   node dist/scripts/plataforma.js oneup-usuario --empresa=<slug> --login=<login> --nome="..." --senha=...
 * Toda ação fica no histórico de configurações e na auditoria da empresa (o Dono vê).
 */
async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    const a = Object.fromEntries(rest.map((x) => { const [k, ...v] = x.replace(/^--/, '').split('='); return [k, v.join('=')]; }));
    await waitForDatabase(5);
    if (cmd === 'catalogo') {
        for (const d of CATALOGO)
            console.log(`${d.quem === 'ONEUP' ? '[ONE UP]' : '[Dono]  '} ${d.secao.padEnd(17)} ${d.chave.padEnd(26)} ${d.rotulo}`);
        return;
    }
    if (cmd === 'empresas') {
        const rows = await runAsSystem(() => db.execute(sql `SELECT e.id, e.slug, e.nome, e.status,
      (SELECT count(*) FROM users u WHERE u.empresa_id = e.id) AS usuarios FROM empresas e ORDER BY e.id`));
        console.table(rows.rows);
        return;
    }
    if (cmd === 'provisionar') {
        if (!a.arquivo)
            throw new Error('Informe --arquivo=<caminho do .json>.');
        await provisionar(JSON.parse(readFileSync(a.arquivo, 'utf8')), dirname(resolve(a.arquivo)));
        return;
    }
    if (!a.empresa)
        throw new Error('Informe --empresa=<slug>.');
    const [emp] = await runAsSystem(() => db.select().from(empresas).where(eq(empresas.slug, a.empresa)));
    if (!emp)
        throw new Error(`Empresa "${a.empresa}" não encontrada.`);
    const def = a.chave ? defDe(a.chave) : undefined;
    if (a.chave && !def)
        throw new Error(`Configuração "${a.chave}" não existe (veja: plataforma.js catalogo).`);
    if (cmd === 'travar') {
        if (!def || !a.motivo || a.motivo.length < 5)
            throw new Error('Informe --chave e --motivo (mínimo 5 caracteres).');
        await runAsSystem(() => db.insert(configTravas).values({ empresaId: emp.id, chave: a.chave, motivo: a.motivo })
            .onConflictDoUpdate({ target: [configTravas.empresaId, configTravas.chave], set: { motivo: a.motivo, createdAt: new Date() } }));
        await runAsEmpresa(emp.id, async () => {
            await db.insert(configHistorico).values({ chave: a.chave, antes: null, depois: { trava: a.motivo }, origem: 'ONEUP' });
            await audit(db, { action: 'config.trava', entityType: 'settings', message: `ONE UP travou "${def.rotulo}". Motivo: ${a.motivo}` });
        });
        console.log(`✔ "${def.rotulo}" travado em ${emp.nome}.`);
    }
    else if (cmd === 'destravar') {
        if (!def)
            throw new Error('Informe --chave.');
        await runAsSystem(() => db.delete(configTravas).where(and(eq(configTravas.empresaId, emp.id), eq(configTravas.chave, a.chave))));
        await runAsEmpresa(emp.id, async () => {
            await db.insert(configHistorico).values({ chave: a.chave, antes: { trava: true }, depois: null, origem: 'ONEUP' });
            await audit(db, { action: 'config.destrava', entityType: 'settings', message: `ONE UP destravou "${def.rotulo}".` });
        });
        console.log(`✔ "${def.rotulo}" destravado em ${emp.nome}.`);
    }
    else if (cmd === 'definir') {
        if (!def || a.valor === undefined)
            throw new Error('Informe --chave e --valor (JSON: true, 10, "texto").');
        let valor;
        try {
            valor = JSON.parse(a.valor);
        }
        catch {
            valor = a.valor;
        }
        const r = await runAsEmpresa(emp.id, () => aplicarConfiguracoes({ [a.chave]: valor }, null, 'ONEUP'));
        console.log(r.alteradas.length ? `✔ ${def.rotulo} = ${JSON.stringify(valor)} em ${emp.nome}.` : '- Já estava com esse valor.');
    }
    else if (cmd === 'oneup-usuario') {
        if (!a.login || !/^[a-z0-9._-]{2,30}$/.test(a.login))
            throw new Error('Informe --login (letras minúsculas, números, ponto ou traço).');
        if (!a.senha || a.senha.length < 8)
            throw new Error('Informe --senha com pelo menos 8 caracteres.');
        const nome = a.nome || 'ONE UP';
        await runAsEmpresa(emp.id, async () => {
            const [adm] = await db.select().from(roles).where(eq(roles.code, 'ADMIN'));
            const hash = await hashPassword(a.senha);
            const [u] = await db.select().from(users).where(eq(users.username, a.login));
            if (u && !u.oneup)
                throw new Error(`O login "${a.login}" já é de uma pessoa do restaurante. Escolha outro.`);
            if (u)
                await db.update(users).set({ name: nome, passwordHash: hash, roleId: adm.id, active: true }).where(eq(users.id, u.id));
            else
                await db.insert(users).values({ name: nome, username: a.login, passwordHash: hash, roleId: adm.id, oneup: true });
            await audit(db, { action: 'oneup.usuario', entityType: 'user', message: `ONE UP ${u ? 'atualizou' : 'criou'} o acesso de suporte "${nome}".` });
        });
        console.log(`✔ Acesso ONE UP "${a.login}" pronto em ${emp.nome}.`);
    }
    else if (cmd === 'senha') {
        if (!a.login || !a.senha || a.senha.length < 4)
            throw new Error('Informe --login e --senha (mínimo 4 caracteres).');
        const ok = await runAsEmpresa(emp.id, async () => {
            const [u] = await db.select().from(users).where(eq(users.username, a.login.toLowerCase()));
            if (!u)
                return null;
            await db.update(users).set({ passwordHash: await hashPassword(a.senha), active: true }).where(eq(users.id, u.id));
            await db.delete(sessions).where(eq(sessions.userId, u.id)); // aparelhos conectados com a senha antiga saem
            await audit(db, { action: 'user.password', entityType: 'user', entityId: u.id, message: `ONE UP redefiniu a senha de ${u.name} (pedido de suporte).` });
            return u.name;
        });
        if (!ok)
            throw new Error(`Login "${a.login}" não existe em ${emp.nome}.`);
        console.log(`✔ Senha de ${ok} redefinida em ${emp.nome}.`);
    }
    else {
        throw new Error('Comando desconhecido. Use: empresas | catalogo | travar | destravar | definir | provisionar | oneup-usuario | senha');
    }
}
const norm = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const centavos = (v) => Math.round(v * 100);
const reais = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
async function provisionar(p, pasta) {
    const [emp] = await runAsSystem(() => db.select().from(empresas).where(eq(empresas.slug, p.empresa)));
    if (!emp)
        throw new Error(`Empresa "${p.empresa}" não encontrada (rode o setup antes).`);
    console.log(`\n=== Provisionando ${emp.nome} (${emp.slug}) ===`);
    const avisos = [];
    await runAsEmpresa(emp.id, () => db.transaction(async (tx) => {
        const todos = await tx.select().from(products);
        const porNome = new Map(todos.map((x) => [norm(x.name), x]));
        const registrarCusto = async (prod, custo, rotulo) => {
            if (prod.costCents === custo)
                return `  = ${prod.name}: ${reais(custo)} (já estava)`;
            await tx.insert(productCosts).values({ productId: prod.id, costCents: custo });
            await tx.update(products).set({ costCents: custo, updatedAt: new Date() }).where(eq(products.id, prod.id));
            // vendas antigas sem custo passam a ter este custo (margem do período fica completa)
            const r = await tx.update(orderItems).set({ unitCostCents: custo })
                .where(and(eq(orderItems.productId, prod.id), isNull(orderItems.unitCostCents))).returning({ id: orderItems.id });
            await audit(tx, { action: 'product.cost', entityType: 'product', entityId: prod.id,
                message: `ONE UP registrou o custo de ${prod.name}: ${prod.costCents == null ? 'não informado' : reais(prod.costCents)} → ${reais(custo)} (informado como "${rotulo}")${r.length ? `; aplicado a ${r.length} venda(s) anteriores sem custo` : ''}.` });
            return `  ✔ ${prod.name}: ${reais(custo)}${rotulo !== prod.name ? ` (${rotulo})` : ''}`;
        };
        for (const c of p.custos ?? []) {
            for (const nome of c.produtos) {
                const prod = porNome.get(norm(nome));
                if (!prod) {
                    avisos.push(`Produto "${nome}" (custo de "${c.rotulo}") não existe no cardápio — não aplicado.`);
                    continue;
                }
                console.log(await registrarCusto(prod, centavos(c.custo), c.rotulo));
            }
        }
        for (const np of p.novosProdutos ?? []) {
            const existente = porNome.get(norm(np.nome));
            if (existente) {
                console.log(await registrarCusto(existente, centavos(np.custo), np.nome));
                continue;
            }
            let [cat] = await tx.select().from(categories).where(eq(categories.name, np.categoria));
            if (!cat)
                [cat] = await tx.insert(categories).values({ name: np.categoria, sendsToKitchen: false }).returning();
            // entra DESLIGADO e marcado para revisar: nunca aparece para o cliente sem preço de venda
            const [novo] = await tx.insert(products).values({
                categoryId: cat.id, name: np.nome, priceCents: 0, costCents: centavos(np.custo), active: false, available: false,
                sendsToKitchen: cat.sendsToKitchen, trackStock: !!np.estoque, needsReview: true, reviewNote: np.nota ?? 'Defina o preço de venda e ative.',
            }).returning();
            await tx.insert(productCosts).values({ productId: novo.id, costCents: centavos(np.custo) });
            await audit(tx, { action: 'product.create', entityType: 'product', entityId: novo.id,
                message: `ONE UP cadastrou ${np.nome} (desligado, aguardando preço de venda) com custo ${reais(centavos(np.custo))}.` });
            console.log(`  ✨ ${np.nome}: custo ${reais(centavos(np.custo))} — criado DESLIGADO, falta o preço de venda`);
            avisos.push(`"${np.nome}" foi criado desligado: defina o preço em Cardápio e ative.`);
        }
        for (const [code, pct] of Object.entries(p.taxas ?? {})) {
            const [m] = await tx.select().from(paymentMethods).where(eq(paymentMethods.code, code));
            if (!m) {
                avisos.push(`Forma de pagamento "${code}" não existe — taxa não aplicada.`);
                continue;
            }
            const bp = Math.round(pct * 100);
            if (m.taxaBp === bp) {
                console.log(`  = Taxa ${m.name}: ${pct}% (já estava)`);
                continue;
            }
            await tx.update(paymentMethods).set({ taxaBp: bp }).where(eq(paymentMethods.id, m.id));
            await tx.insert(configHistorico).values({ chave: `forma_pagamento:${m.code}`, antes: { taxaPct: m.taxaBp / 100 }, depois: { taxaPct: pct }, origem: 'ONEUP' });
            await audit(tx, { action: 'config.update', entityType: 'payment_method', entityId: m.id, message: `ONE UP definiu a taxa da maquininha de ${m.name}: ${(m.taxaBp / 100).toFixed(2)}% → ${pct.toFixed(2)}%.` });
            console.log(`  ✔ Taxa ${m.name}: ${pct}%`);
        }
    }));
    await runAsEmpresa(emp.id, async () => {
        if (p.logo && !(await lerConfig('logo'))) {
            const url = await gravarImagem(readFileSync(resolve(pasta, p.logo)), 'logo');
            await aplicarConfiguracoes({ logo: url }, null, 'ONEUP');
            console.log(`  ✔ Logotipo aplicado (${url})`);
        }
        if (p.icone && !(await lerConfig('icone_app'))) {
            const buf = readFileSync(resolve(pasta, p.icone));
            validarIcone(buf);
            const url = await gravarImagem(buf, 'icone');
            await aplicarConfiguracoes({ icone_app: url }, null, 'ONEUP');
            console.log(`  ✔ Ícone do aplicativo aplicado (${url})`);
        }
        const iniciais = {};
        for (const [k, v] of Object.entries(p.configuracoes ?? {})) {
            const def = defDe(k);
            if (!def) {
                avisos.push(`Configuração "${k}" não existe — ignorada.`);
                continue;
            }
            if (JSON.stringify(await lerConfig(k)) === JSON.stringify(def.padrao))
                iniciais[k] = v; // não sobrescreve o que o Dono já mudou
        }
        if (Object.keys(iniciais).length) {
            const r = await aplicarConfiguracoes(iniciais, null, 'ONEUP');
            if (r.alteradas.length)
                console.log(`  ✔ Configurações iniciais: ${r.alteradas.join(', ')}`);
        }
    });
    // base de comparação: tabela só da plataforma (o restaurante só lê, e só o usuário ONE UP vê)
    for (const r of p.referencias ?? []) {
        await runAsSystem(() => db.insert(referenciasExternas).values({
            empresaId: emp.id, titulo: r.titulo, origem: r.origem, inicio: r.inicio, fim: r.fim,
            totalCents: centavos(r.total), vendas: r.vendas, taxasCents: centavos(r.taxas ?? 0),
            porForma: (r.porForma ?? []).map((f) => ({ forma: f.forma, vendas: f.vendas, cents: centavos(f.valor) })), observacao: r.observacao ?? null,
        }).onConflictDoUpdate({
            target: [referenciasExternas.empresaId, referenciasExternas.origem, referenciasExternas.inicio, referenciasExternas.fim],
            set: { titulo: r.titulo, totalCents: centavos(r.total), vendas: r.vendas, taxasCents: centavos(r.taxas ?? 0),
                porForma: (r.porForma ?? []).map((f) => ({ forma: f.forma, vendas: f.vendas, cents: centavos(f.valor) })), observacao: r.observacao ?? null },
        }));
        console.log(`  ✔ Base de comparação: ${r.titulo} (${reais(centavos(r.total))}, ${r.vendas} vendas)`);
    }
    if (avisos.length)
        console.log(`\nAtenção:\n${avisos.map((x) => `  ! ${x}`).join('\n')}`);
    console.log('\nPronto.\n');
}
main().then(closePools).catch(async (e) => { console.error('Erro:', e.message ?? e); await closePools(); process.exit(1); });
