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
// Faixas publicadas pela Cloudflare (https://www.cloudflare.com/ips/)
const CLOUDFLARE = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
    '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14',
    '172.64.0.0/13', '131.0.72.0/22', '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
    '2a06:98c0::/29', '2c0f:f248::/32'];
const PRIVADAS = ['loopback', 'linklocal', 'uniquelocal'];
export const avisosConfig = [];
function confiancaProxy(v) {
    const t = (v ?? '').trim().toLowerCase();
    if (!t || t === '0' || t === 'false')
        return false;
    if (t === 'true')
        return true;
    if (t === 'cloudflare')
        return [...PRIVADAS, ...CLOUDFLARE];
    if (t === 'privado')
        return PRIVADAS;
    if (/^\d+$/.test(t)) {
        avisosConfig.push(`TRUST_PROXY=${t} (número) não funciona no Fastify 5: usando "privado". Atrás da Cloudflare use TRUST_PROXY=cloudflare.`);
        return PRIVADAS;
    }
    return t.split(',').map((x) => x.trim()).filter(Boolean);
}
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
    // TRUST_PROXY: quem está na frente do servidor e informa o IP real do aparelho (X-Forwarded-For).
    //   cloudflare = Cloudflare + proxy local (Coolify/Traefik) · privado = só proxy local · vazio/0 = acesso direto
    //   ou uma lista de redes (ex.: 10.0.0.0/8,172.16.0.0/12). Número de saltos NÃO é aceito pelo Fastify 5.
    trustProxy: confiancaProxy(process.env.TRUST_PROXY),
    host: process.env.HOST ?? '0.0.0.0',
    // Banco: DATABASE_URL = dono do banco (migrações e plataforma; precisa ser superusuário ou ter BYPASSRLS).
    // A aplicação usa o papel APP_DB_ROLE (sem BYPASSRLS) — por padrão na mesma conexão, ou em APP_DATABASE_URL.
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/oneup',
    appDatabaseUrl: process.env.APP_DATABASE_URL || undefined,
    appDbRole: (process.env.APP_DB_ROLE ?? 'oneup_app').replace(/[^a-z0-9_]/g, ''),
    dbPoolSize: num(process.env.DB_POOL_SIZE, 20),
    // Empresa da requisição: <slug>.BASE_DOMAIN (online). DEFAULT_EMPRESA = instalação de uma empresa só.
    // EMPRESA_HEADER=true aceita o cabeçalho x-empresa (somente desenvolvimento e testes).
    baseDomain: (process.env.BASE_DOMAIN ?? '').toLowerCase().replace(/^\./, ''),
    defaultEmpresa: (process.env.DEFAULT_EMPRESA ?? '').toLowerCase() || undefined,
    allowEmpresaHeader: process.env.EMPRESA_HEADER === 'true',
    productName: 'ONE UP Comanda',
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
