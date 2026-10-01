/**
 * RITMO DO MÊS — testes. Cria a empresa "ritmo" no banco de duas empresas (EMPRESA_HEADER=true, veja testes.sh),
 * grava um histórico conhecido e confere cada número contra um cálculo independente.
 *   BASE_URL=http://localhost:3200 DATABASE_URL=... node dist/scripts/ritmo-test.js
 */
import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePools, db, runAsEmpresa } from '../db/index.js';
import { curvaAcumulada, diasNoMes, mediaDiaADia, projetar, ritmoDoMes } from '../services/ritmo.js';
const BASE = process.env.BASE_URL ?? 'http://localhost:3200';
const DB_URL = process.env.DATABASE_URL;
const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
let passed = 0;
const failures = [];
function check(label, cond, extra) {
    if (cond) {
        passed++;
        console.log(`  ✔ ${label}`);
    }
    else {
        failures.push(label);
        console.log(`  ✘ ${label}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 500));
    }
}
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
// ---------- dados conhecidos ----------
// receita do dia = base do mês × peso do dia da semana (segunda fechado); centavos inteiros
const PESO = [180, 0, 100, 100, 100, 150, 200]; // dom, seg, ter, qua, qui, sex, sáb (em %)
const BASEMES = { '2025-08': 9000, '2026-02': 10000, '2026-03': 11000, '2026-04': 9500, '2026-05': 12000, '2026-06': 10500, '2026-07': 13000, '2026-08': 12500 };
const dow = (k, d) => new Date(Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, d)).getUTCDay();
const valorDia = (k, d) => Math.round((BASEMES[k] * PESO[dow(k, d)]) / 100);
const curvaEsperada = (k, ate) => {
    const n = diasNoMes(Number(k.slice(0, 4)), Number(k.slice(5, 7)));
    const mp = new Map();
    for (let d = 1; d <= Math.min(n, ate ?? n); d++)
        mp.set(d, valorDia(k, d));
    return curvaAcumulada(mp, n);
};
async function main() {
    console.log('\n[0] Funções puras');
    {
        const c = curvaAcumulada(new Map([[1, 100], [2, 50], [28, 10]]), 28);
        check('Mês de 28 dias: dias 29, 30 e 31 repetem o último acumulado', c.length === 31 && c[27] === 160 && c[28] === 160 && c[30] === 160, c.slice(25));
        check('Dia sem venda mantém o acumulado (não zera)', c[2] === 150 && c[26] === 150);
        check('Média dia a dia de curvas acumuladas (arredonda centavos)', eq(mediaDiaADia([[100, 200], [101, 300]]).slice(0, 2), [101, 250]));
        check('Sem curvas: média vazia', mediaDiaADia([]).length === 0);
        const base = [Array.from({ length: 31 }, (_, i) => (i + 1) * 100)];
        const p = projetar(1800, 18, base);
        check('Projeção pelo formato: até o dia 18 vende 18/31 do mês → atual ÷ fração', p.ok && p.centro === Math.round((1800 * 3100) / 1800), p);
        check('Projeção escondida antes do dia 5', !projetar(500, 4, base).ok);
        check('Projeção sem meses de referência: explica o motivo', !projetar(500, 10, []).ok);
    }
    // ---------- empresa "ritmo" ----------
    const pgc = new pg.Client({ connectionString: DB_URL });
    await pgc.connect();
    execFileSync('node', ['dist/scripts/setup.js', '--empresa=ritmo', '--nome=Ritmo', '--admin-pass=ritmo-admin', '--caixa-pass=ritmo-caixa', '--cozinha-pass=ritmo-coz', '--cardapio=exemplo'], { cwd: SERVER, env: { ...process.env, DATABASE_URL: DB_URL }, stdio: 'ignore' });
    const [{ id: EMP }] = (await pgc.query(`SELECT id FROM empresas WHERE slug='ritmo'`)).rows;
    const ja = (await pgc.query(`SELECT count(*)::int n FROM payments WHERE empresa_id=$1`, [EMP])).rows[0].n;
    const login = async (u, p) => {
        const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-empresa': 'ritmo' }, body: JSON.stringify({ username: u, password: p }) });
        return (r.headers.get('set-cookie') ?? '').split(';')[0];
    };
    const get = async (cookie, path) => { const r = await fetch(BASE + path, { headers: { 'x-empresa': 'ritmo', cookie } }); return { status: r.status, data: await r.json().catch(() => null) }; };
    const dono = await login('admin', 'ritmo-admin');
    const caixa = await login('caixa', 'ritmo-caixa');
    if (!ja) {
        // ids válidos para as chaves estrangeiras
        const [{ id: uid }] = (await pgc.query(`SELECT id FROM users WHERE empresa_id=$1 AND username='admin'`, [EMP])).rows;
        const [{ id: mid }] = (await pgc.query(`SELECT id FROM payment_methods WHERE empresa_id=$1 AND code='PIX'`, [EMP])).rows;
        const [{ id: rid }] = (await pgc.query(`INSERT INTO cash_registers (empresa_id, opened_by, opened_at, opening_cash_cents, status, closed_at, closed_by)
      VALUES ($1, $2, '2025-07-01 12:00-03', 0, 'CLOSED', '2025-07-01 13:00-03', $2) RETURNING id`, [EMP, uid])).rows;
        const [{ id: aid }] = (await pgc.query(`INSERT INTO accounts (empresa_id, number, status, opened_at) VALUES ($1, 9000, 'CLOSED', '2025-08-01 12:00-03') RETURNING id`, [EMP])).rows;
        const [{ id: cancelada }] = (await pgc.query(`INSERT INTO accounts (empresa_id, number, status, opened_at) VALUES ($1, 9001, 'CANCELLED', '2026-08-16 12:00-03') RETURNING id`, [EMP])).rows;
        const pagar = (cents, quando, estornado = false) => pgc.query(`INSERT INTO payments (empresa_id, account_id, method_id, amount_cents, cash_register_id, user_id, created_at, reversed_at, reversed_by, reversal_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [EMP, aid, mid, cents, rid, uid, quando, estornado ? quando : null, estornado ? uid : null, estornado ? 'teste' : null]);
        for (const k of Object.keys(BASEMES)) {
            const n = diasNoMes(Number(k.slice(0, 4)), Number(k.slice(5, 7)));
            const ate = k === '2026-08' ? 18 : n;
            for (let d = 1; d <= ate; d++) {
                const v = valorDia(k, d);
                if (v > 0)
                    await pagar(v, `${k}-${String(d).padStart(2, '0')} 14:00-03`);
            }
        }
        await pagar(777, '2026-08-11 23:50-03'); // 23h50 de Brasília = dia 12 em UTC → conta no dia 11
        await pagar(99999, '2026-08-12 15:00-03', true); // estornado: não conta
        await pgc.query(`INSERT INTO discounts (empresa_id, account_id, kind, amount_cents, reason, user_id, created_at) VALUES ($1,$2,'DISCOUNT',5000,'teste',$3,'2026-08-15 15:00-03')`, [EMP, aid, uid]);
        await pgc.query(`INSERT INTO discounts (empresa_id, account_id, kind, amount_cents, reason, user_id, created_at) VALUES ($1,$2,'DISCOUNT',7000,'teste',$3,'2026-08-16 15:00-03')`, [EMP, cancelada, uid]);
    }
    const calc = (mes, modo = 'liquido', hoje = '2026-08-18') => runAsEmpresa(EMP, () => ritmoDoMes(db, { mes, modo, hoje }));
    console.log('\n[1] Curvas, médias dia a dia e fuso horário');
    const r = await calc('2026-08');
    const atualEsp = curvaEsperada('2026-08', 18).map((v, i) => v + (i >= 10 ? 777 : 0)).slice(0, 18);
    check('Mês atual PARA no dia de hoje (18 pontos)', r.linhas.atual.pontos.length === 18);
    check('Venda às 23h50 (horário de Brasília) conta no dia 11, não no 12', r.linhas.atual.pontos[10] - r.linhas.atual.pontos[9] === valorDia('2026-08', 11) + 777 && r.linhas.atual.pontos[11] - r.linhas.atual.pontos[10] === valorDia('2026-08', 12), { d10: r.linhas.atual.pontos[9], d11: r.linhas.atual.pontos[10], d12: r.linhas.atual.pontos[11] });
    check('Pagamento estornado não conta (curva do mês atual idêntica ao esperado)', eq(r.linhas.atual.pontos, atualEsp), { got: r.linhas.atual.pontos.slice(10, 13), esp: atualEsp.slice(10, 13) });
    check('Mês passado = julho completo, até o dia 31', r.linhas.passado?.mes === '2026-07' && eq(r.linhas.passado.pontos, curvaEsperada('2026-07')));
    const m3 = ['2026-07', '2026-06', '2026-05'];
    const media3Esp = Array.from({ length: 31 }, (_, i) => Math.round(m3.reduce((s, k) => s + curvaEsperada(k)[i], 0) / 3));
    check('Média 3 meses = média DIA A DIA das curvas acumuladas de jul, jun e mai (mês atual fora)', eq(r.linhas.media3.pontos, media3Esp) && !r.linhas.media3.meses.includes('2026-08'));
    const m6 = ['2026-07', '2026-06', '2026-05', '2026-04', '2026-03', '2026-02'];
    const media6Esp = Array.from({ length: 31 }, (_, i) => Math.round(m6.reduce((s, k) => s + curvaEsperada(k)[i], 0) / 6));
    check('Média 6 meses dia a dia (inclui fevereiro de 28 dias, repetido até o 31)', eq(r.linhas.media6.pontos, media6Esp));
    check('Faixa da média 6: pior e melhor mês em cada dia', r.linhas.media6.max[30] === Math.max(...m6.map((k) => curvaEsperada(k)[30])) && r.linhas.media6.min[30] === Math.min(...m6.map((k) => curvaEsperada(k)[30])));
    check('Mesmo mês do ano anterior (agosto de 2025) aparece quando há dados', r.linhas.anoAnterior?.mes === '2025-08' && eq(r.linhas.anoAnterior.pontos, curvaEsperada('2025-08')));
    check('Segunda-feira reconhecida como dia em que o restaurante fecha', r.diaSemanaFechado.includes(1));
    check('Segundas do mês (3, 10, 17) marcadas como fechadas, não como ritmo ruim', [3, 10, 17].every((d) => r.fechados.some((f) => f.dia === d)), r.fechados);
    console.log('\n[2] Resumo e projeção pelo formato da curva');
    const v18 = atualEsp[17];
    check('Resumo: valor até o dia 18', r.resumo.dia === 18 && r.resumo.valor === v18);
    const vsPass = Math.round(((v18 - curvaEsperada('2026-07')[17]) / curvaEsperada('2026-07')[17]) * 1000) / 10;
    check('Variação vs mês passado no MESMO dia do mês', r.resumo.vsPassado === vsPass, { got: r.resumo.vsPassado, esp: vsPass });
    check('Variação vs média 3 meses no mesmo dia', r.resumo.vsMedia3 === Math.round(((v18 - media3Esp[17]) / media3Esp[17]) * 1000) / 10);
    const centroEsp = Math.round((v18 * media3Esp[30]) / media3Esp[17]);
    const porMes = m3.map((k) => Math.round((v18 * curvaEsperada(k)[30]) / curvaEsperada(k)[17]));
    check('Projeção = valor até hoje ÷ fração que a média costuma ter vendido até o dia 18 (não regra de três)', r.projecao.ok && r.projecao.centro === centroEsp && r.projecao.centro !== Math.round((v18 / 18) * 31), r.projecao);
    check('Faixa da projeção: pior e melhor dos 3 meses', r.projecao.ok && r.projecao.min === Math.min(...porMes) && r.projecao.max === Math.max(...porMes));
    console.log('\n[3] Bruto × líquido');
    const b = await calc('2026-08', 'bruto');
    check('Bruto = líquido + desconto do dia 15', b.linhas.atual.pontos[14] - r.linhas.atual.pontos[14] === 5000);
    check('Desconto de conta CANCELADA não entra no bruto', b.linhas.atual.pontos[17] - r.linhas.atual.pontos[17] === 5000);
    check('Padrão do endpoint é líquido', (await get(dono, '/api/finance/ritmo')).data?.modo === 'liquido');
    console.log('\n[4] Pouco histórico e mês sem dados');
    const vazio = await calc('2025-07', 'liquido', '2026-08-18');
    check('Mês sem vendas e sem meses anteriores: nenhuma linha de comparação', !vazio.linhas.passado && !vazio.linhas.media3 && !vazio.linhas.media6 && vazio.linhas.atual.pontos.every((v) => v === 0));
    check('Mês sem dados: projeção explica o motivo', !vazio.projecao.ok && 'motivo' in vazio.projecao);
    check('Avisa o que falta para cada linha aparecer', vazio.faltam.some((f) => f.linha === 'media6' && /aparece em/.test(f.texto)));
    const marco = await calc('2026-03', 'liquido', '2026-08-18');
    check('Com 1 mês completo: mês passado aparece; média 3 não duplica a mesma linha', !!marco.linhas.passado && !marco.linhas.media3 && marco.faltam.some((f) => f.linha === 'media3'));
    const abril = await calc('2026-04', 'liquido', '2026-08-18');
    check('Com 2 meses: "média de 2 meses" com aviso', abril.linhas.media3?.meses.length === 2 && abril.faltam.some((f) => /Média de 2 meses/.test(f.texto)));
    check('Mês curto (fevereiro) no histórico de março: dias 29–31 repetem o dia 28', eq(marco.linhas.passado.pontos.slice(27), [0, 0, 0, 0].map(() => marco.linhas.passado.pontos[27])));
    console.log('\n[5] Permissão');
    const rc = await get(caixa, '/api/finance/ritmo');
    check('Caixa NÃO acessa o Ritmo do mês', rc.status === 403, rc.status);
    check('Sem login: 401', (await get('', '/api/finance/ritmo')).status === 401);
    const rd = await get(dono, '/api/finance/ritmo?modo=bruto');
    check('Dono acessa (mesma permissão do financeiro)', rd.status === 200 && rd.data.modo === 'bruto');
    check('Parâmetro inválido é recusado', (await get(dono, '/api/finance/ritmo?mes=2026-13')).status === 400);
    await pgc.end();
    await closePools();
    console.log(`\nResultado ritmo: ${passed} verificações OK, ${failures.length} falhas.`);
    if (failures.length) {
        console.log(failures.map((f) => ` - ${f}`).join('\n'));
        process.exit(1);
    }
}
main().catch(async (e) => { console.error(e); await closePools(); process.exit(1); });
