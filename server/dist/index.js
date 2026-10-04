import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { avisosConfig, config } from './config.js';
import { appPool, bindContext, db, ensureEmpresaBase, ensurePlatformData, releaseContext, runAsEmpresa, runAsSystem, runMigrations, systemPool, waitForDatabase } from './db/index.js';
import { empresas, restaurantSettings } from './db/schema.js';
import { empresaPorSlug, slugDaRequisicao } from './lib/empresa.js';
import { errorHandler } from './lib/http.js';
import { fecharRealtime, initRealtime } from './realtime.js';
import { authRoutes } from './routes/auth.js';
import { menuRoutes } from './routes/menu.js';
import { accountRoutes } from './routes/accounts.js';
import { kitchenRoutes } from './routes/kitchen.js';
import { registerRoutes } from './routes/register.js';
import { adminRoutes } from './routes/admin.js';
import { publicRoutes } from './routes/public.js';
import { stockRoutes } from './routes/stock.js';
import { managementRoutes } from './routes/management.js';
import { configuracoesRoutes } from './routes/configuracoes.js';
import { pendenciasRoutes } from './routes/pendencias.js';
import { importacaoRoutes } from './routes/importacao.js';
import { analiseRoutes } from './routes/analise.js';
import { cleanupIdempotency } from './lib/idempotency.js';
import { registrarRespostaCompartilhada } from './lib/cacheRota.js';
import { dimensoesDe, rotaUploads } from './lib/imagem.js';
import { configuracoesPublicas } from './services/configuracoes.js';
/**
 * Cada chamada de API pertence a UMA empresa (descoberta pelo endereço). A conexão do banco dessa
 * requisição fica presa a ela (RLS) e é devolvida ao terminar. Sem empresa válida: 404.
 */
function empresaPorRequisicao(app) {
    app.addHook('onRequest', async (req, reply) => {
        if (!req.url.startsWith('/api/') || req.url.startsWith('/api/health'))
            return;
        const emp = await empresaPorSlug(slugDaRequisicao(req.headers.host, req.headers['x-empresa']));
        if (!emp)
            return reply.code(404).send({ error: 'Empresa não encontrada. Confira o endereço de acesso.', code: 'EMPRESA_NAO_ENCONTRADA' });
        req.empresa = emp;
        req.dbCtx = { kind: 'app', empresaId: emp.id };
    });
    // depois da leitura do corpo: liga o contexto ao restante da requisição (hooks de login e rota)
    app.addHook('preValidation', (req, _reply, done) => { if (req.dbCtx)
        bindContext(req.dbCtx, done);
    else
        done(); });
    app.addHook('onResponse', async (req) => { await releaseContext(req.dbCtx); });
    // aparelho desistiu no meio: a conexão é descartada (pode estar no meio de uma transação)
    app.addHook('onRequestAbort', async (req) => { await releaseContext(req.dbCtx, { abortada: true }); });
}
export async function buildApp() {
    const app = Fastify({
        logger: { level: process.env.LOG_LEVEL ?? 'warn' },
        forceCloseConnections: true,
        bodyLimit: 1024 * 1024,
        // atrás do proxy (Coolify/Cloudflare) o IP real vem do cabeçalho; sem isso todos parecem o mesmo aparelho
        trustProxy: config.trustProxy,
    });
    app.setErrorHandler(errorHandler);
    securityHeaders(app);
    mesmaOrigem(app);
    empresaPorRequisicao(app);
    registrarRespostaCompartilhada(app);
    await app.register(cookie);
    await app.register(multipart);
    mkdirSync(config.uploadsDir, { recursive: true });
    rotaUploads(app);
    await app.register(authRoutes);
    await app.register(menuRoutes);
    await app.register(accountRoutes);
    await app.register(kitchenRoutes);
    await app.register(registerRoutes);
    await app.register(adminRoutes);
    await app.register(publicRoutes);
    await app.register(stockRoutes);
    await app.register(managementRoutes);
    await app.register(configuracoesRoutes);
    await app.register(pendenciasRoutes);
    await app.register(importacaoRoutes);
    await app.register(analiseRoutes);
    // Saúde de verdade: confere o banco (com o Postgres parado responde 503, não "ok")
    app.get('/api/health', async (_req, reply) => {
        try {
            await Promise.race([systemPool.query('SELECT 1'), new Promise((_, r) => setTimeout(() => r(new Error('tempo')), 2000))]);
            return { ok: true, versao: config.version, time: new Date().toISOString() };
        }
        catch {
            return reply.code(503).send({ ok: false, erro: 'banco de dados indisponível' });
        }
    });
    app.get('/api/health/vivo', async () => ({ ok: true }));
    // App instalável (tablet da cozinha, celular do caixa): nome do restaurante no ícone da tela inicial (ícone ONE UP Comanda)
    // Dois aplicativos instaláveis com o nome e o ícone do restaurante: CLIENTES (abre o cardápio) e EQUIPE (abre o sistema)
    // Corta no fim de uma palavra (nome do ícone não fica "Restaurante do Teste Equ")
    const encurta = (t, n) => { if (t.length <= n)
        return t; const c = t.slice(0, n + 1); const i = c.lastIndexOf(' '); return (i > 3 ? c.slice(0, i) : t.slice(0, n)).trim(); };
    const manifesto = (tipo) => async (req, reply) => {
        const emp = await empresaPorSlug(slugDaRequisicao(req.headers.host, req.headers['x-empresa']));
        let nome = config.productName;
        let curto = 'Comanda';
        let icone = null;
        let tema = 'escuro';
        if (emp) {
            const r = await runAsEmpresa(emp.id, async () => {
                const [s] = await db.select({ name: restaurantSettings.name }).from(restaurantSettings).limit(1);
                return { nome: s?.name || emp.nome, pub: await configuracoesPublicas() };
            });
            curto = r.pub.nome_app || r.nome;
            nome = r.pub.nome_app || r.nome;
            icone = r.pub.icone_app || null;
            tema = r.pub.tema || 'escuro';
        }
        const dim = icone ? dimensoesDe(icone) : null;
        const fundo = tema === 'claro' ? '#f6f4ee' : '#161513';
        reply.type('application/manifest+json').header('Cache-Control', 'no-cache');
        return {
            id: tipo === 'cliente' ? '/cardapio' : '/', lang: 'pt-BR', dir: 'ltr',
            name: tipo === 'cliente' ? nome : `${nome} — Equipe`,
            short_name: tipo === 'cliente' ? encurta(curto, 24) : `${encurta(curto, 17)} Equipe`,
            description: tipo === 'cliente' ? `Cardápio e pedidos de ${nome}` : `${nome}: caixa, cozinha e gestão (${config.productName})`,
            start_url: tipo === 'cliente' ? '/cardapio?origem=app' : '/?origem=app', scope: tipo === 'cliente' ? '/cardapio' : '/',
            display: 'standalone', orientation: 'any', background_color: fundo, theme_color: fundo,
            icons: icone && dim
                ? [{ src: icone, sizes: `${dim.w}x${dim.h}`, type: /\.png$/i.test(icone) ? 'image/png' : /\.webp$/i.test(icone) ? 'image/webp' : 'image/jpeg', purpose: 'any' },
                    { src: '/comanda-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }]
                : [{ src: '/comanda-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
                    { src: '/comanda-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }],
        };
    };
    app.get('/manifest.webmanifest', manifesto('equipe'));
    app.get('/cardapio.webmanifest', manifesto('cliente'));
    // Proxy HTTPS (Caddy, certificado sob demanda) pergunta se o endereço é de uma empresa ativa antes de emitir certificado
    app.get('/api/health/tls', async (req, reply) => {
        const domain = String(req.query.domain ?? '').toLowerCase();
        const emp = await empresaPorSlug(slugDaRequisicao(domain, undefined));
        return emp ? { ok: true } : reply.code(404).send({ ok: false });
    });
    // Site (React compilado) + rotas do SPA
    if (existsSync(config.webDist)) {
        await app.register(fastifyStatic, {
            root: config.webDist, prefix: '/',
            setHeaders: (res, path) => {
                res.header('Cache-Control', path.includes('assets') ? 'public, max-age=31536000, immutable' : 'no-cache');
            },
        });
        // o cardápio é instalado como o app dos CLIENTES (manifesto próprio); o resto, como o app da EQUIPE
        let htmlCardapio = null;
        app.setNotFoundHandler((req, reply) => {
            if (req.url.startsWith('/api/') || req.url.startsWith('/uploads/')) {
                return reply.status(404).send({ error: 'Rota não encontrada.' });
            }
            if (req.url === '/cardapio' || req.url.startsWith('/cardapio?') || req.url.startsWith('/cardapio/')) {
                htmlCardapio ??= readFileSync(join(config.webDist, 'index.html'), 'utf8').replace('href="/manifest.webmanifest"', 'href="/cardapio.webmanifest"');
                return reply.type('text/html').header('Cache-Control', 'no-cache').send(htmlCardapio);
            }
            return reply.type('text/html').sendFile('index.html');
        });
    }
    return app;
}
/**
 * Mudanças (POST/PUT/PATCH/DELETE) só da própria página: se o navegador informa a origem, ela tem de ser o mesmo
 * endereço. Barra formulário forjado vindo de outro subdomínio do mesmo site (SameSite=Lax não protege isso).
 */
function mesmaOrigem(app) {
    app.addHook('onRequest', async (req, reply) => {
        if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || !req.url.startsWith('/api/'))
            return;
        const origin = req.headers.origin;
        const site = req.headers['sec-fetch-site'];
        let ok = true;
        if (origin) {
            try {
                ok = new URL(origin).host === req.headers.host;
            }
            catch {
                ok = false;
            }
        }
        else if (site && site !== 'same-origin' && site !== 'none')
            ok = false;
        if (!ok)
            return reply.code(403).send({ error: 'Origem não permitida.', code: 'ORIGEM' });
    });
}
function securityHeaders(app) {
    app.addHook('onSend', async (req, reply, payload) => {
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('X-Frame-Options', 'SAMEORIGIN');
        reply.header('Referrer-Policy', 'same-origin');
        // só código do próprio sistema roda na página (barra script injetado em nome de cliente, observação etc.)
        if (!reply.hasHeader('content-security-policy')) {
            const host = /^[a-z0-9.-]+(:\d+)?$/i.test(req.headers.host ?? '') ? req.headers.host : '';
            reply.header('Content-Security-Policy', [
                "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
                `connect-src 'self'${host ? ` wss://${host} ws://${host}` : ''}`, "font-src 'self' data:", "object-src 'none'",
                "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'", "manifest-src 'self'",
            ].join('; '));
        }
        if (config.cookieSecure)
            reply.header('Strict-Transport-Security', 'max-age=15552000');
        return payload;
    });
}
/** Servidor público opcional: expõe SOMENTE o cardápio do cliente e a API pública. */
async function buildPublicApp() {
    const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 256 * 1024 });
    app.setErrorHandler(errorHandler);
    securityHeaders(app);
    empresaPorRequisicao(app);
    registrarRespostaCompartilhada(app);
    rotaUploads(app);
    await app.register(publicRoutes);
    app.get('/api/meta', async () => ({ demoMode: config.demoMode, public: true }));
    if (existsSync(config.webDist)) {
        await app.register(fastifyStatic, { root: config.webDist, prefix: '/', index: false, serve: true });
        app.get('/', async (_req, reply) => reply.redirect('/cardapio'));
        app.setNotFoundHandler((req, reply) => {
            if (req.url.startsWith('/api/'))
                return reply.status(404).send({ error: 'Rota não encontrada.' });
            if (!req.url.startsWith('/cardapio'))
                return reply.redirect('/cardapio');
            return reply.type('text/html').sendFile('index.html');
        });
    }
    return app;
}
function lanAddresses() {
    return Object.values(networkInterfaces()).flat()
        .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}
async function main() {
    if (config.allowEmpresaHeader && process.env.NODE_ENV === 'production') {
        throw new Error('EMPRESA_HEADER=true é só para testes: recusado em produção (qualquer um escolheria a empresa pelo cabeçalho).');
    }
    for (const a of avisosConfig)
        console.warn('  Aviso: ' + a);
    if (config.baseDomain && !config.trustProxy)
        console.warn('  Aviso: online sem TRUST_PROXY — todos os aparelhos parecerão um só (limites de tentativa ficam por empresa). Use TRUST_PROXY=cloudflare.');
    if (config.baseDomain && config.defaultEmpresa)
        console.warn('  Aviso: BASE_DOMAIN e DEFAULT_EMPRESA juntos — endereços desconhecidos caem na empresa padrão.');
    await waitForDatabase();
    await runMigrations();
    await ensurePlatformData();
    const lista = await runAsSystem(() => db.select().from(empresas));
    for (const e of lista.filter((x) => x.status !== 'CANCELADA')) {
        await runAsEmpresa(e.id, async () => { await ensureEmpresaBase(); await cleanupIdempotency(); });
    }
    const app = await buildApp();
    await app.ready();
    initRealtime(app.server);
    await app.listen({ port: config.port, host: config.host });
    const ips = lanAddresses();
    console.log(`\n  ${config.productName} ${config.demoMode ? '(DEMONSTRAÇÃO) ' : ''}rodando · ${lista.length} empresa(s)`);
    console.log(`  Neste computador:  http://localhost:${config.port}`);
    for (const ip of ips)
        console.log(`  Tablet/celular:    http://${ip}:${config.port}`);
    if (config.publicPort) {
        const pub = await buildPublicApp();
        await pub.listen({ port: config.publicPort, host: config.host });
        console.log(`  Cardápio público:  http://localhost:${config.publicPort}/cardapio (somente cardápio)`);
    }
    console.log('');
    // Desligar rápido: fecha os sockets dos tablets antes (senão o processo espera até o systemd matar, ~90 s fora do ar)
    let parando = false;
    const stop = async () => {
        if (parando)
            return;
        parando = true;
        setTimeout(() => process.exit(0), 8000).unref();
        await fecharRealtime().catch(() => undefined);
        await app.close().catch(() => undefined);
        await appPool.end().catch(() => undefined);
        await systemPool.end().catch(() => undefined);
        process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}
main().catch((e) => {
    console.error('Falha ao iniciar o servidor:', e);
    process.exit(1);
});
