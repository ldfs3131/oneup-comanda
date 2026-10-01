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
import { readFileSync } from 'node:fs';
const pkgVersion = (() => { try {
    return JSON.parse(readFileSync(resolve(SERVER_ROOT, 'package.json'), 'utf8')).version;
}
catch {
    return '2.0.0';
} })();
export const config = {
    version: pkgVersion,
    port: num(process.env.PORT, 3010),
    // Porta pública opcional, só com o cardápio do cliente (para Tailscale Funnel / internet). 0 = desligada.
    publicPort: Number(process.env.PUBLIC_PORT ?? 0) || 0,
    cookieSecure: process.env.COOKIE_SECURE === 'true',
    // TRUST_PROXY: número de proxies na frente (ex.: 2 = Cloudflare + Coolify). 0 = acesso direto.
    trustProxy: Number(process.env.TRUST_PROXY ?? 0) || 0,
    host: process.env.HOST ?? '0.0.0.0',
    // Banco: DATABASE_URL = dono do banco (migrações e plataforma; precisa ser superusuário ou ter BYPASSRLS).
    // A aplicação usa o papel APP_DB_ROLE (sem BYPASSRLS) — por padrão na mesma conexão, ou em APP_DATABASE_URL.
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/onefood',
    appDatabaseUrl: process.env.APP_DATABASE_URL || undefined,
    appDbRole: (process.env.APP_DB_ROLE ?? 'onefood_app').replace(/[^a-z0-9_]/g, ''),
    dbPoolSize: num(process.env.DB_POOL_SIZE, 20),
    // Empresa da requisição: <slug>.BASE_DOMAIN (online). DEFAULT_EMPRESA = instalação de uma empresa só.
    // EMPRESA_HEADER=true aceita o cabeçalho x-empresa (somente desenvolvimento e testes).
    baseDomain: (process.env.BASE_DOMAIN ?? '').toLowerCase().replace(/^\./, ''),
    defaultEmpresa: (process.env.DEFAULT_EMPRESA ?? '').toLowerCase() || undefined,
    allowEmpresaHeader: process.env.EMPRESA_HEADER === 'true',
    productName: 'ONE Food',
    demoMode: process.env.DEMO_MODE === 'true',
    // Tela de Insights (leitura/interpretação dos números). Desligada por padrão: a interpretação é serviço
    // do Administrador (ONE UP) e não aparece para o restaurante. Os dados continuam sendo gravados.
    insightsEnabled: process.env.INSIGHTS_ENABLED === 'true',
    // pastas de backup separadas por ";" (ex.: C:\\HappyAlpha-Backups;E:\\HappyAlpha-Backups)
    backupDirs: (process.env.BACKUP_DIRS ?? '').split(';').map((s) => s.trim()).filter(Boolean),
    pgDumpPath: process.env.PG_DUMP_PATH ?? 'pg_dump',
    uploadsDir: process.env.UPLOADS_DIR ?? resolve(PROJECT_ROOT, 'data', 'uploads'),
    webDist: resolve(PROJECT_ROOT, 'web', 'dist'),
    migrationsDir: resolve(SERVER_ROOT, 'drizzle'),
    sessionDays: 30,
    timezone: 'America/Sao_Paulo',
};
