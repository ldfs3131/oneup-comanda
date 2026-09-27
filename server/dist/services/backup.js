import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
const KEEP = 30;
function stamp() {
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: config.timezone }));
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
function dumpTo(file) {
    return new Promise((resolve, reject) => {
        const child = spawn(config.pgDumpPath, ['--format=custom', `--file=${file}`, `--dbname=${config.databaseUrl}`], { windowsHide: true });
        let err = '';
        child.stderr.on('data', (d) => (err += d));
        child.on('error', (e) => reject(new Error(`pg_dump não encontrado (${e.message}). Configure PG_DUMP_PATH no .env.`)));
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `pg_dump saiu com código ${code}`))));
    });
}
/** Gera um backup em cada pasta configurada. Nunca lança erro: devolve o resultado por pasta. */
export async function runBackup() {
    if (!config.backupDirs.length)
        return [{ dir: '(nenhuma)', ok: false, error: 'Nenhuma pasta de backup configurada (BACKUP_DIRS no .env).' }];
    const name = `happy-alpha-${config.demoMode ? 'demo-' : ''}${stamp()}.dump`;
    const results = [];
    for (const dir of config.backupDirs) {
        try {
            mkdirSync(dir, { recursive: true });
            const file = join(dir, name);
            await dumpTo(file);
            // mantém só os últimos 30 backups
            const old = readdirSync(dir).filter((f) => f.startsWith('happy-alpha-') && f.endsWith('.dump'))
                .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(KEEP);
            for (const o of old)
                unlinkSync(join(dir, o.f));
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
    const info = okCount ? results.filter((r) => r.ok).map((r) => r.file).join(' · ') : results.map((r) => r.error).join('; ');
    await db.update(restaurantSettings).set({ lastBackupAt: new Date(), lastBackupOk: okCount > 0, lastBackupInfo: info }).where(eq(restaurantSettings.id, 1));
    await audit(db, {
        userId, action,
        message: okCount ? `Backup ${action === 'backup.auto' ? 'automático' : 'manual'} salvo em ${okCount} pasta(s).` : `Backup ${action === 'backup.auto' ? 'automático' : 'manual'} FALHOU: ${info}`,
        data: results,
    });
    return results;
}
