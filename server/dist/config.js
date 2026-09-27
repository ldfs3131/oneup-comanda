import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
// raiz do servidor (server/) — funciona tanto em src/ (tsx) quanto em dist/
export const SERVER_ROOT = resolve(here, '..');
export const PROJECT_ROOT = resolve(SERVER_ROOT, '..');
const envFile = process.env.ENV_FILE ?? resolve(PROJECT_ROOT, '.env');
if (existsSync(envFile))
    process.loadEnvFile(envFile);
function num(v, d) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
}
export const config = {
    port: num(process.env.PORT, 3000),
    host: process.env.HOST ?? '0.0.0.0',
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/happy_alpha',
    demoMode: process.env.DEMO_MODE === 'true',
    // pastas de backup separadas por ";" (ex.: E:\\Backups;G:\\Meu Drive\\HappyAlpha)
    backupDirs: (process.env.BACKUP_DIRS ?? '').split(';').map((s) => s.trim()).filter(Boolean),
    pgDumpPath: process.env.PG_DUMP_PATH ?? 'pg_dump',
    uploadsDir: process.env.UPLOADS_DIR ?? resolve(PROJECT_ROOT, 'data', 'uploads'),
    webDist: resolve(PROJECT_ROOT, 'web', 'dist'),
    migrationsDir: resolve(SERVER_ROOT, 'drizzle'),
    sessionDays: 30,
    timezone: 'America/Sao_Paulo',
};
