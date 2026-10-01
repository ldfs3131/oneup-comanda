import { empresaAtual } from '../db/index.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join, parse, resolve } from 'node:path';
import { config } from '../config.js';
const KEEP = 30;
function stamp() {
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: config.timezone }));
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
const DUMP_TIMEOUT_MS = 10 * 60_000;
const MKDIR_TIMEOUT_MS = 15_000;
function dumpTo(file) {
    return new Promise((resolve, reject) => {
        const child = spawn(config.pgDumpPath, ['--format=custom', `--file=${file}`, `--dbname=${config.databaseUrl}`], { windowsHide: true });
        let err = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error('pg_dump demorou mais de 10 minutos e foi interrompido.')); }, DUMP_TIMEOUT_MS);
        child.stderr.on('data', (d) => (err += d));
        child.on('error', (e) => { clearTimeout(timer); reject(new Error(`pg_dump não encontrado (${e.message}). Configure PG_DUMP_PATH no .env.`)); });
        child.on('close', (code) => { clearTimeout(timer); if (code === 0)
            resolve();
        else
            reject(new Error(err.trim() || `pg_dump saiu com código ${code}`)); });
    });
}
/**
 * Prepara a pasta sem nunca travar o servidor: confere se a unidade existe (pendrive desconectado
 * falha na hora) e cria a pasta de forma assíncrona, com tempo-limite.
 */
async function ensureDir(dir) {
    const root = parse(resolve(dir)).root;
    if (root && !existsSync(root))
        throw new Error(`Unidade ${root} não encontrada (pendrive desconectado?).`);
    if (existsSync(dir))
        return;
    let timer;
    await Promise.race([
        mkdir(dir, { recursive: true }),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('Não foi possível criar a pasta (tempo esgotado).')), MKDIR_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
}
/** Gera um backup em cada pasta configurada. Nunca lança erro: devolve o resultado por pasta. */
export async function runBackup() {
    if (!config.backupDirs.length)
        return [{ dir: '(nenhuma)', ok: false, error: 'Nenhuma pasta de backup configurada (BACKUP_DIRS no .env).' }];
    // o pg_dump copia o banco INTEIRO: com mais de uma empresa, backup local por pasta fica desligado
    const { runAsSystem, db } = await import('../db/index.js');
    const { sql } = await import('drizzle-orm');
    const n = await runAsSystem(async () => Number((await db.execute(sql `SELECT count(*)::int AS n FROM empresas`)).rows[0].n));
    if (n > 1)
        return [{ dir: '(plataforma)', ok: false, error: 'Com várias empresas no servidor, o backup é feito pela plataforma (banco inteiro, fora da aplicação).' }];
    const name = `happy-alpha-${config.demoMode ? 'demo-' : ''}${stamp()}.dump`;
    const results = [];
    for (const dir of config.backupDirs) {
        try {
            await ensureDir(dir);
            const file = join(dir, name);
            await dumpTo(file);
            // mantém só os últimos 30 backups
            const names = (await readdir(dir)).filter((f) => f.startsWith('happy-alpha-') && f.endsWith('.dump'));
            const withTime = await Promise.all(names.map(async (f) => ({ f, t: (await stat(join(dir, f))).mtimeMs })));
            for (const o of withTime.sort((a, b) => b.t - a.t).slice(KEEP))
                await unlink(join(dir, o.f)).catch(() => undefined);
            results.push({ dir, ok: true, file });
        }
        catch (e) {
            results.push({ dir, ok: false, error: e.message });
        }
    }
    return results;
}
/** Executa o backup e grava o resultado (aparece no painel e no histórico). */
export async function runBackupAndRecord(userId, action) {
    const { db } = await import('../db/index.js');
    const { restaurantSettings } = await import('../db/schema.js');
    const { audit } = await import('../lib/audit.js');
    const { eq } = await import('drizzle-orm');
    const results = await runBackup();
    const okCount = results.filter((r) => r.ok).length;
    // "OK" só quando TODAS as pastas receberam a cópia: uma pasta falhando (pendrive fora, unidade do
    // Google Drive invisível para o serviço do Windows) precisa aparecer no aviso do painel.
    const allOk = okCount > 0 && okCount === results.length;
    const saved = results.filter((r) => r.ok).map((r) => r.file);
    const failed = results.filter((r) => !r.ok).map((r) => `${r.dir}: ${r.error}`);
    const info = [saved.length ? `Salvo em: ${saved.join(' · ')}` : '', failed.length ? `FALHOU em: ${failed.join('; ')}` : ''].filter(Boolean).join(' | ');
    await db.update(restaurantSettings).set({ lastBackupAt: new Date(), lastBackupOk: allOk, lastBackupInfo: info }).where(eq(restaurantSettings.id, empresaAtual()));
    const kind = action === 'backup.auto' ? 'automático' : 'manual';
    await audit(db, {
        userId, action,
        message: allOk ? `Backup ${kind} salvo em ${okCount} pasta(s).`
            : okCount ? `Backup ${kind} salvo em ${okCount} de ${results.length} pasta(s). ${info}`
                : `Backup ${kind} FALHOU: ${info}`,
        data: results,
    });
    return results;
}
