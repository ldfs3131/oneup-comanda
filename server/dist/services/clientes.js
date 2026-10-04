/**
 * Clientes e LGPD. O restaurante é o controlador dos dados; a ONE UP é a operadora.
 * - Cliente identificado pelo telefone normalizado: mesmo telefone = mesmo cliente (o nome é só um atributo).
 * - Telefone que não é celular/fixo válido vira contato livre (campo "contato").
 * - Parar ofertas, juntar duplicados, apagar dados (anonimizar: as vendas continuam) e exportar os dados de um cliente.
 * - Retenção: cliente sem pedido há 24 meses (e sem saldo) é anonimizado por uma rotina diária.
 * A auditoria cita só "cliente #id" / "conta #N" — nunca nome, telefone ou casa.
 */
import { sql } from 'drizzle-orm';
import { db, runAsEmpresa, runAsSystem } from '../db/index.js';
import { empresas } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { conflict, notFound } from '../lib/http.js';
import { normalizarWhatsapp } from '../lib/telefone.js';
export const RETENCAO_MESES = 24;
export const STATUS_VIVOS = ['OPEN', 'PARTIALLY_PAID', 'PAID', 'PENDING'];
const linhas = async (tx, q) => (await tx.execute(q)).rows;
/** Segue "juntado em" até o cliente que ficou (no máximo 5 saltos). */
export async function clienteFinal(tx, id) {
    let atual = id;
    for (let i = 0; i < 5; i++) {
        const [c] = await linhas(tx, sql `SELECT id, juntado_em, anonimizado_em FROM customers WHERE id = ${atual}`);
        if (!c)
            return null;
        if (!c.juntado_em)
            return { id: c.id, anonimizado: !!c.anonimizado_em };
        atual = c.juntado_em;
    }
    return null;
}
/** Cliente (não anonimizado) com este telefone — aceita cadastros antigos gravados com máscara "(61) 9...". */
async function porTelefone(tx, tel) {
    const [c] = await linhas(tx, sql `
    SELECT id, phone FROM customers
    WHERE anonimizado_em IS NULL
      AND (phone = ${tel} OR regexp_replace(coalesce(phone, ''), '\\D', '', 'g') IN (${tel}, ${'55' + tel}))
    ORDER BY (juntado_em IS NOT NULL), id LIMIT 1`);
    if (!c)
        return null;
    const fim = await clienteFinal(tx, c.id);
    if (!fim || fim.anonimizado)
        return null;
    // cadastro antigo com máscara: grava só os dígitos
    if (fim.id === c.id && c.phone !== tel)
        await tx.execute(sql `UPDATE customers SET phone = ${tel}, updated_at = now() WHERE id = ${c.id}`);
    return fim.id;
}
/** O texto do campo "contato" é um telefone (só números, espaços, parênteses, +, - e .)? */
function contatoEhTelefone(contato) {
    return /^[\d\s()+.-]+$/.test(contato) ? normalizarWhatsapp(contato) : null;
}
/**
 * Acha ou cria o cliente de uma conta.
 *  - telefone válido: mesmo telefone = mesmo cliente (atualiza o nome se vier diferente);
 *  - `atual` (cliente que a conta já tinha) + telefone novo que ninguém tem: CORRIGE o telefone desse cliente (não cria outro);
 *  - sem telefone válido: o que foi digitado vai para "contato" e o cliente é achado por nome + contato (como antes).
 * Devolve o id do cliente ou null (sem dados suficientes para identificar).
 */
export async function identificarCliente(tx, p) {
    const nome = p.nome?.trim() || null;
    let contato = p.contato?.trim() || null;
    const bruto = p.telefone?.trim() || null;
    let tel = normalizarWhatsapp(bruto);
    if (!tel && bruto)
        contato = contato && contato.toLowerCase().includes(bruto.toLowerCase()) ? contato : [contato, bruto].filter(Boolean).join(' · ');
    if (!tel && contato) {
        const t2 = contatoEhTelefone(contato);
        if (t2) {
            tel = t2;
            contato = null;
        }
    }
    let atual = null;
    if (p.atual) {
        const fim = await clienteFinal(tx, p.atual);
        if (fim && !fim.anonimizado)
            atual = fim.id;
    }
    let id = null;
    if (tel) {
        id = await porTelefone(tx, tel);
        if (!id && atual) {
            // correção do telefone da conta: corrige o cliente
            await tx.execute(sql `UPDATE customers SET phone = ${tel}, updated_at = now() WHERE id = ${atual}`);
            id = atual;
        }
        if (!id) {
            if (!nome)
                return null;
            const [c] = await linhas(tx, sql `INSERT INTO customers (name, phone, contact) VALUES (${nome}, ${tel}, ${contato}) RETURNING id`);
            return c.id;
        }
    }
    else if (atual) {
        id = atual;
    }
    else {
        if (!nome || !contato)
            return null;
        const [c] = await linhas(tx, sql `
      SELECT id FROM customers
      WHERE anonimizado_em IS NULL AND juntado_em IS NULL
        AND lower(name) = lower(${nome}) AND lower(coalesce(contact, '')) = lower(${contato})
      ORDER BY id LIMIT 1`);
        if (c)
            return c.id;
        const [n] = await linhas(tx, sql `INSERT INTO customers (name, contact) VALUES (${nome}, ${contato}) RETURNING id`);
        return n.id;
    }
    // o nome é atributo: atualiza se veio diferente; contato só se veio preenchido
    await tx.execute(sql `UPDATE customers SET
      name = COALESCE(${nome}::text, name),
      contact = COALESCE(${contato}::text, contact),
      updated_at = now()
    WHERE id = ${id} AND (name IS DISTINCT FROM COALESCE(${nome}::text, name) OR contact IS DISTINCT FROM COALESCE(${contato}::text, contact))`);
    return id;
}
/** O cliente e os que foram juntados a ele (mesma pessoa). */
async function idsDaPessoa(tx, id) {
    const r = await linhas(tx, sql `SELECT id FROM customers WHERE id = ${id} OR juntado_em = ${id}`);
    return r.map((x) => x.id);
}
const arr = (ids) => sql `ARRAY[${sql.join(ids.map((i) => sql `${i}`), sql `, `)}]::int[]`;
export async function buscarCliente(tx, id) {
    const [c] = await linhas(tx, sql `SELECT id, name, phone, contact, anonimizado_em, juntado_em, aceita_ofertas FROM customers WHERE id = ${id} FOR UPDATE`);
    if (!c)
        throw notFound('Cliente não encontrado.');
    return c;
}
/** Parar ofertas: zera o aceite e grava quando (quem fez fica na auditoria). */
export async function revogarOfertas(tx, id, userId, origem = 'pelo Dono') {
    const c = await buscarCliente(tx, id);
    if (c.anonimizado_em)
        throw conflict('Os dados deste cliente já foram apagados.');
    await tx.execute(sql `UPDATE customers SET aceita_ofertas = false, ofertas_revogadas_em = now(), updated_at = now() WHERE id = ${id}`);
    await audit(tx, { userId, action: 'cliente.ofertas_revogadas', entityType: 'customer', entityId: id, message: `cliente #${id}: ofertas revogadas (${origem}).` });
}
/**
 * Apagar dados (anonimizar). As vendas continuam; somem nome, telefone, contato e observação do cliente e
 * nome/telefone/contato das contas ENCERRADAS, CANCELADAS ou JUNTADAS dele. Conta aberta ou a receber impede.
 */
export async function anonimizarCliente(tx, id, userId, motivo = 'pedido') {
    const c = await buscarCliente(tx, id);
    if (c.anonimizado_em)
        throw conflict('Os dados deste cliente já foram apagados.');
    if (c.juntado_em)
        throw conflict(`Este cadastro foi juntado ao cliente #${c.juntado_em}. Apague os dados por lá.`);
    const ids = await idsDaPessoa(tx, id);
    const vivas = await linhas(tx, sql `
    SELECT number, status FROM accounts WHERE customer_id = ANY(${arr(ids)}) AND status IN ('OPEN', 'PARTIALLY_PAID', 'PAID', 'PENDING') ORDER BY number LIMIT 5`);
    if (vivas.length) {
        const lista = vivas.map((v) => `#${v.number}`).join(', ');
        throw conflict(`Este cliente tem conta aberta ou a receber (${lista}). Os dados só podem ser apagados depois que a conta for encerrada ou cancelada — as vendas e o fiado precisam do nome para a cobrança.`);
    }
    for (const i of ids) {
        await tx.execute(sql `UPDATE customers SET name = ${'Cliente anonimizado #' + i}, phone = NULL, contact = NULL, note = NULL,
        aceita_ofertas = false, ofertas_revogadas_em = COALESCE(ofertas_revogadas_em, CASE WHEN aceita_ofertas_em IS NOT NULL THEN now() END),
        anonimizado_em = now(), updated_at = now()
      WHERE id = ${i}`);
    }
    // contas terminadas: tira nome/telefone/contato; no delivery a observação é o endereço, então sai também
    const r = await tx.execute(sql `UPDATE accounts SET customer_name = NULL, phone = NULL, contact = NULL,
      note = CASE WHEN origin = 'DELIVERY' THEN NULL ELSE note END
    WHERE customer_id = ANY(${arr(ids)}) AND status IN ('CLOSED', 'CANCELLED', 'MERGED')`);
    await audit(tx, {
        userId, action: motivo === 'retencao' ? 'cliente.retencao' : 'cliente.anonimizado', entityType: 'customer', entityId: id,
        message: motivo === 'retencao'
            ? `cliente #${id}: dados apagados automaticamente (${RETENCAO_MESES} meses sem pedidos); ${r.rowCount ?? 0} conta(s) sem identificação. As vendas continuam.`
            : `cliente #${id}: dados apagados a pedido (anonimizado); ${r.rowCount ?? 0} conta(s) sem identificação. As vendas continuam.`,
    });
    return { contas: r.rowCount ?? 0 };
}
/** Juntar duplicados: `ficaId` fica; as contas de `saiId` passam para ele; `saiId` fica marcado e some das listas. */
export async function juntarClientes(tx, ficaId, saiId, userId) {
    if (ficaId === saiId)
        throw conflict('Escolha dois cadastros diferentes.');
    // trava os dois sempre na mesma ordem (sem impasse se duas pessoas juntarem ao mesmo tempo)
    const primeiro = await buscarCliente(tx, Math.min(ficaId, saiId));
    const segundo = await buscarCliente(tx, Math.max(ficaId, saiId));
    const fica = primeiro.id === ficaId ? primeiro : segundo;
    const sai = primeiro.id === saiId ? primeiro : segundo;
    if (fica.anonimizado_em || sai.anonimizado_em)
        throw conflict('Cadastro anonimizado não pode ser juntado.');
    if (fica.juntado_em || sai.juntado_em)
        throw conflict('Um dos cadastros já foi juntado a outro.');
    const contas = await tx.execute(sql `UPDATE accounts SET customer_id = ${ficaId} WHERE customer_id = ${saiId}`);
    await tx.execute(sql `UPDATE customers SET juntado_em = ${ficaId}, updated_at = now() WHERE juntado_em = ${saiId}`);
    // o que fica herda o telefone/contato que não tinha e o aceite de ofertas (se ele nunca aceitou nem revogou)
    await tx.execute(sql `UPDATE customers f SET
      phone = COALESCE(f.phone, s.phone),
      contact = COALESCE(f.contact, s.contact),
      aceita_ofertas = CASE WHEN f.aceita_ofertas_em IS NULL AND f.ofertas_revogadas_em IS NULL THEN s.aceita_ofertas ELSE f.aceita_ofertas END,
      aceita_ofertas_em = CASE WHEN f.aceita_ofertas_em IS NULL AND f.ofertas_revogadas_em IS NULL THEN s.aceita_ofertas_em ELSE f.aceita_ofertas_em END,
      aceita_ofertas_texto = CASE WHEN f.aceita_ofertas_em IS NULL AND f.ofertas_revogadas_em IS NULL THEN s.aceita_ofertas_texto ELSE f.aceita_ofertas_texto END,
      ofertas_revogadas_em = CASE WHEN f.aceita_ofertas_em IS NULL AND f.ofertas_revogadas_em IS NULL THEN s.ofertas_revogadas_em ELSE f.ofertas_revogadas_em END,
      updated_at = now()
    FROM customers s WHERE f.id = ${ficaId} AND s.id = ${saiId}`);
    await tx.execute(sql `UPDATE customers SET juntado_em = ${ficaId}, updated_at = now() WHERE id = ${saiId}`);
    await audit(tx, {
        userId, action: 'cliente.juntado', entityType: 'customer', entityId: ficaId,
        message: `cliente #${saiId} juntado ao cliente #${ficaId} (${contas.rowCount ?? 0} conta(s) passaram para o #${ficaId}).`,
    });
    return { contas: contas.rowCount ?? 0 };
}
/** Corrigir nome/telefone. Telefone que já é de outro cliente: recusa e sugere juntar. */
export async function corrigirCliente(tx, id, b, userId) {
    const c = await buscarCliente(tx, id);
    if (c.anonimizado_em)
        throw conflict('Os dados deste cliente já foram apagados.');
    if (c.juntado_em)
        throw conflict(`Este cadastro foi juntado ao cliente #${c.juntado_em}.`);
    const mudou = [];
    let tel;
    let contato = b.contato === undefined ? undefined : (b.contato?.trim() || null);
    if (b.telefone !== undefined) {
        const bruto = b.telefone?.trim() || null;
        tel = normalizarWhatsapp(bruto);
        if (bruto && !tel)
            throw conflict('Telefone inválido: use DDD + número, por exemplo (61) 99999-1111. Para casa/apartamento, use o campo contato.');
        if (tel) {
            const [outro] = await linhas(tx, sql `SELECT id FROM customers WHERE id <> ${id} AND anonimizado_em IS NULL AND juntado_em IS NULL
        AND (phone = ${tel} OR regexp_replace(coalesce(phone, ''), '\\D', '', 'g') IN (${tel}, ${'55' + tel})) LIMIT 1`);
            if (outro)
                throw conflict(`Este telefone já é do cliente #${outro.id}. Use "Juntar duplicados" para unir os dois cadastros.`);
        }
        if (tel !== c.phone)
            mudou.push('telefone');
    }
    if (b.nome !== undefined && b.nome.trim() !== c.name)
        mudou.push('nome');
    if (contato !== undefined && contato !== c.contact)
        mudou.push('contato');
    if (!mudou.length)
        return { mudou };
    await tx.execute(sql `UPDATE customers SET
      name = COALESCE(${b.nome?.trim() || null}::text, name),
      phone = CASE WHEN ${tel !== undefined} THEN ${tel ?? null}::text ELSE phone END,
      contact = CASE WHEN ${contato !== undefined} THEN ${contato ?? null}::text ELSE contact END,
      updated_at = now()
    WHERE id = ${id}`);
    await audit(tx, { userId, action: 'cliente.corrigido', entityType: 'customer', entityId: id, message: `cliente #${id}: ${mudou.join(', ')} corrigido(s).` });
    return { mudou };
}
/** Tudo o que o sistema guarda sobre um cliente (para atender o pedido do titular). */
export async function dadosDoCliente(tx, id) {
    const [c] = await linhas(tx, sql `SELECT id, name AS nome, phone AS telefone, contact AS contato, note AS observacao,
      aceita_ofertas AS "aceitaOfertas", aceita_ofertas_em AS "aceiteEm", aceita_ofertas_texto AS "textoDoAceite",
      ofertas_revogadas_em AS "ofertasRevogadasEm", anonimizado_em AS "anonimizadoEm", created_at AS "cadastradoEm"
    FROM customers WHERE id = ${id} AND juntado_em IS NULL`);
    if (!c)
        throw notFound('Cliente não encontrado.');
    const ids = await idsDaPessoa(tx, id);
    const contas = await linhas(tx, sql `
    SELECT a.number AS conta, a.opened_at AS "abertaEm", a.status, a.origin AS origem, a.customer_name AS "nomeNaConta",
      a.phone AS "telefoneNaConta", a.contact AS "contatoNaConta",
      COALESCE((SELECT SUM(oi.unit_price_cents * oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.account_id = a.id AND oi.status = 'ACTIVE' AND o.status <> 'AWAITING_CONFIRMATION'), 0)::int
        - COALESCE((SELECT SUM(amount_cents) FROM discounts WHERE account_id = a.id), 0)::int AS "totalCentavos",
      COALESCE((SELECT string_agg(oi.quantity || 'x ' || oi.product_name, '; ' ORDER BY oi.id) FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.account_id = a.id AND oi.status = 'ACTIVE'), '') AS itens
    FROM accounts a WHERE a.customer_id = ANY(${arr(ids)}) ORDER BY a.opened_at`);
    return { geradoEm: new Date().toISOString(), cliente: c, contas };
}
const csvCel = (v) => {
    const s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function dadosEmCsv(d) {
    const linhasCsv = ['campo;valor'];
    for (const [k, v] of Object.entries(d.cliente))
        linhasCsv.push(`${k};${csvCel(v)}`);
    linhasCsv.push('', 'conta;abertaEm;status;origem;nomeNaConta;telefoneNaConta;contatoNaConta;totalCentavos;itens');
    for (const c of d.contas)
        linhasCsv.push([c.conta, c.abertaEm, c.status, c.origem, c.nomeNaConta, c.telefoneNaConta, c.contatoNaConta, c.totalCentavos, c.itens].map(csvCel).join(';'));
    return '﻿' + linhasCsv.join('\r\n') + '\r\n';
}
/** Retenção: anonimiza quem não pede nada há 24 meses e não tem conta aberta/a receber. */
export async function aplicarRetencao(tx = db) {
    const alvos = await linhas(tx, sql `
    SELECT c.id FROM customers c
    WHERE c.anonimizado_em IS NULL AND c.juntado_em IS NULL
      AND c.created_at < now() - make_interval(months => ${RETENCAO_MESES})
      AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.customer_id IN (SELECT x.id FROM customers x WHERE x.id = c.id OR x.juntado_em = c.id)
        AND (a.opened_at >= now() - make_interval(months => ${RETENCAO_MESES}) OR a.status IN ('OPEN', 'PARTIALLY_PAID', 'PAID', 'PENDING')))
    ORDER BY c.id LIMIT 500`);
    let n = 0;
    for (const a of alvos) {
        await anonimizarCliente(tx, a.id, null, 'retencao');
        n++;
    }
    return n;
}
/** Rotina diária (primeira passada 1 min depois de subir). Cada empresa no seu contexto (RLS). */
export function iniciarRetencaoClientes(intervaloMs = 24 * 3600_000) {
    const rodar = async () => {
        try {
            const lista = await runAsSystem(() => db.select({ id: empresas.id, status: empresas.status }).from(empresas));
            for (const e of lista.filter((x) => x.status !== 'CANCELADA')) {
                await runAsEmpresa(e.id, () => db.transaction((tx) => aplicarRetencao(tx)))
                    .catch((err) => console.warn(`  Retenção de clientes (empresa ${e.id}): ${err.message}`));
            }
        }
        catch (err) {
            console.warn('  Retenção de clientes: ' + err.message);
        }
    };
    setTimeout(rodar, 60_000).unref();
    setInterval(rodar, intervaloMs).unref();
}
