import { and, eq, sql } from 'drizzle-orm';
import { closePools, db, runAsEmpresa, runAsSystem, waitForDatabase } from '../db/index.js';
import { configHistorico, configTravas, empresas } from '../db/schema.js';
import { aplicarConfiguracoes, defDe, CATALOGO } from '../services/configuracoes.js';
import { audit } from '../lib/audit.js';

/**
 * Ferramenta da ONE UP (até o Command Center ter tela):
 *   node dist/scripts/plataforma.js empresas
 *   node dist/scripts/plataforma.js travar    --empresa=<slug> --chave=<chave> --motivo="..."
 *   node dist/scripts/plataforma.js destravar --empresa=<slug> --chave=<chave>
 *   node dist/scripts/plataforma.js definir   --empresa=<slug> --chave=<chave> --valor=<json>
 *   node dist/scripts/plataforma.js catalogo
 * Toda ação fica no histórico de configurações e na auditoria da empresa (o Dono vê).
 */
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = Object.fromEntries(rest.map((x) => { const [k, ...v] = x.replace(/^--/, '').split('='); return [k, v.join('=')]; }));
  await waitForDatabase(5);

  if (cmd === 'catalogo') {
    for (const d of CATALOGO) console.log(`${d.quem === 'ONEUP' ? '[ONE UP]' : '[Dono]  '} ${d.secao.padEnd(17)} ${d.chave.padEnd(26)} ${d.rotulo}`);
    return;
  }
  if (cmd === 'empresas') {
    const rows = await runAsSystem(() => db.execute(sql`SELECT e.id, e.slug, e.nome, e.status,
      (SELECT count(*) FROM users u WHERE u.empresa_id = e.id) AS usuarios FROM empresas e ORDER BY e.id`));
    console.table(rows.rows);
    return;
  }
  if (!a.empresa) throw new Error('Informe --empresa=<slug>.');
  const [emp] = await runAsSystem(() => db.select().from(empresas).where(eq(empresas.slug, a.empresa)));
  if (!emp) throw new Error(`Empresa "${a.empresa}" não encontrada.`);
  const def = a.chave ? defDe(a.chave) : undefined;
  if (a.chave && !def) throw new Error(`Configuração "${a.chave}" não existe (veja: plataforma.js catalogo).`);

  if (cmd === 'travar') {
    if (!def || !a.motivo || a.motivo.length < 5) throw new Error('Informe --chave e --motivo (mínimo 5 caracteres).');
    await runAsSystem(() => db.insert(configTravas).values({ empresaId: emp.id, chave: a.chave, motivo: a.motivo })
      .onConflictDoUpdate({ target: [configTravas.empresaId, configTravas.chave], set: { motivo: a.motivo, createdAt: new Date() } }));
    await runAsEmpresa(emp.id, async () => {
      await db.insert(configHistorico).values({ chave: a.chave, antes: null, depois: { trava: a.motivo }, origem: 'ONEUP' });
      await audit(db, { action: 'config.trava', entityType: 'settings', message: `ONE UP travou "${def.rotulo}". Motivo: ${a.motivo}` });
    });
    console.log(`✔ "${def.rotulo}" travado em ${emp.nome}.`);
  } else if (cmd === 'destravar') {
    if (!def) throw new Error('Informe --chave.');
    await runAsSystem(() => db.delete(configTravas).where(and(eq(configTravas.empresaId, emp.id), eq(configTravas.chave, a.chave))));
    await runAsEmpresa(emp.id, async () => {
      await db.insert(configHistorico).values({ chave: a.chave, antes: { trava: true }, depois: null, origem: 'ONEUP' });
      await audit(db, { action: 'config.destrava', entityType: 'settings', message: `ONE UP destravou "${def.rotulo}".` });
    });
    console.log(`✔ "${def.rotulo}" destravado em ${emp.nome}.`);
  } else if (cmd === 'definir') {
    if (!def || a.valor === undefined) throw new Error('Informe --chave e --valor (JSON: true, 10, "texto").');
    let valor: unknown; try { valor = JSON.parse(a.valor); } catch { valor = a.valor; }
    const r = await runAsEmpresa(emp.id, () => aplicarConfiguracoes({ [a.chave]: valor }, null, 'ONEUP'));
    console.log(r.alteradas.length ? `✔ ${def.rotulo} = ${JSON.stringify(valor)} em ${emp.nome}.` : '- Já estava com esse valor.');
  } else {
    throw new Error('Comando desconhecido. Use: empresas | catalogo | travar | destravar | definir');
  }
}

main().then(closePools).catch(async (e) => { console.error('Erro:', e.message ?? e); await closePools(); process.exit(1); });
