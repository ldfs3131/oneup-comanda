import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync, mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { config } from './config.js';
import { appPool, bindContext, db, ensureEmpresaBase, ensurePlatformData, releaseContext, runAsEmpresa, runAsSystem, runMigrations, systemPool, waitForDatabase, type DbContext } from './db/index.js';
import { empresas } from './db/schema.js';
import { empresaPorSlug, slugDaRequisicao, type EmpresaInfo } from './lib/empresa.js';
import { errorHandler } from './lib/http.js';
import { initRealtime } from './realtime.js';
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
import { cleanupIdempotency } from './lib/idempotency.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest { empresa?: EmpresaInfo; dbCtx?: DbContext }
}

/**
 * Cada chamada de API pertence a UMA empresa (descoberta pelo endereço). A conexão do banco dessa
 * requisição fica presa a ela (RLS) e é devolvida ao terminar. Sem empresa válida: 404.
 */
function empresaPorRequisicao(app: FastifyInstance) {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/health')) return;
    const emp = await empresaPorSlug(slugDaRequisicao(req.headers.host, req.headers['x-empresa']));
    if (!emp) return reply.code(404).send({ error: 'Empresa não encontrada. Confira o endereço de acesso.', code: 'EMPRESA_NAO_ENCONTRADA' });
    req.empresa = emp;
    req.dbCtx = { kind: 'app', empresaId: emp.id };
  });
  // depois da leitura do corpo: liga o contexto ao restante da requisição (hooks de login e rota)
  app.addHook('preValidation', (req, _reply, done) => { if (req.dbCtx) bindContext(req.dbCtx, done); else done(); });
  app.addHook('onResponse', async (req) => { await releaseContext(req.dbCtx); });
  // aparelho desistiu no meio: a conexão é descartada (pode estar no meio de uma transação)
  app.addHook('onRequestAbort', async (req) => { await releaseContext(req.dbCtx, { abortada: true }); });
}

export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'warn' },
    bodyLimit: 1024 * 1024,
    // atrás do proxy (Coolify/Cloudflare) o IP real vem do cabeçalho; sem isso todos parecem o mesmo aparelho
    trustProxy: (config.trustProxy || false) as boolean, // número de saltos aceito em tempo de execução
  });
  app.setErrorHandler(errorHandler);
  securityHeaders(app);
  empresaPorRequisicao(app);
  await app.register(cookie);
  await app.register(multipart);

  mkdirSync(config.uploadsDir, { recursive: true });
  await app.register(fastifyStatic, { root: config.uploadsDir, prefix: '/uploads/', decorateReply: false });

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
  app.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));

  // Site (React compilado) + rotas do SPA
  if (existsSync(config.webDist)) {
    await app.register(fastifyStatic, {
      root: config.webDist, prefix: '/',
      setHeaders: (res, path) => {
        res.header('Cache-Control', path.includes('assets') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/uploads/')) {
        return reply.status(404).send({ error: 'Rota não encontrada.' });
      }
      return reply.type('text/html').sendFile('index.html');
    });
  }
  return app;
}

function securityHeaders(app: FastifyInstance) {
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('Referrer-Policy', 'same-origin');
    return payload;
  });
}

/** Servidor público opcional: expõe SOMENTE o cardápio do cliente e a API pública. */
async function buildPublicApp() {
  const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 256 * 1024 });
  app.setErrorHandler(errorHandler);
  securityHeaders(app);
  empresaPorRequisicao(app);
  await app.register(fastifyStatic, { root: config.uploadsDir, prefix: '/uploads/', decorateReply: false });
  await app.register(publicRoutes);
  app.get('/api/meta', async () => ({ demoMode: config.demoMode, public: true }));
  if (existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, prefix: '/', index: false, serve: true });
    app.get('/', async (_req, reply) => reply.redirect('/cardapio'));
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Rota não encontrada.' });
      if (!req.url.startsWith('/cardapio')) return reply.redirect('/cardapio');
      return reply.type('text/html').sendFile('index.html');
    });
  }
  return app;
}

function lanAddresses() {
  return Object.values(networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address);
}

async function main() {
  if (config.allowEmpresaHeader && process.env.NODE_ENV === 'production') {
    throw new Error('EMPRESA_HEADER=true é só para testes: recusado em produção (qualquer um escolheria a empresa pelo cabeçalho).');
  }
  if (config.baseDomain && config.defaultEmpresa) console.warn('  Aviso: BASE_DOMAIN e DEFAULT_EMPRESA juntos — endereços desconhecidos caem na empresa padrão.');
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
  for (const ip of ips) console.log(`  Tablet/celular:    http://${ip}:${config.port}`);
  if (config.publicPort) {
    const pub = await buildPublicApp();
    await pub.listen({ port: config.publicPort, host: config.host });
    console.log(`  Cardápio público:  http://localhost:${config.publicPort}/cardapio (somente cardápio)`);
  }
  console.log('');

  const stop = async () => { await app.close(); await appPool.end(); await systemPool.end(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error('Falha ao iniciar o servidor:', e);
  process.exit(1);
});
