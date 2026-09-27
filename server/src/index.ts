import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync, mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { config } from './config.js';
import { ensureBaseData, pool, runMigrations, waitForDatabase } from './db/index.js';
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
import { cleanupIdempotency } from './lib/idempotency.js';
import { upgradeMenuIfNeeded } from './seed/menu.js';
import type { FastifyInstance } from 'fastify';

export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'warn' },
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  });
  app.setErrorHandler(errorHandler);
  securityHeaders(app);
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
  await waitForDatabase();
  await runMigrations();
  await ensureBaseData();
  const added = await upgradeMenuIfNeeded();
  if (added) console.log(`  Cardápio atualizado para a R2: ${added} produto(s) adicionados.`);
  await cleanupIdempotency();
  const app = await buildApp();
  await app.ready();
  initRealtime(app.server);
  await app.listen({ port: config.port, host: config.host });
  const ips = lanAddresses();
  console.log(`\n  HAPPY ALPHA ${config.demoMode ? '(DEMONSTRAÇÃO) ' : ''}rodando`);
  console.log(`  Neste computador:  http://localhost:${config.port}`);
  for (const ip of ips) console.log(`  Tablet/celular:    http://${ip}:${config.port}`);
  if (config.publicPort) {
    const pub = await buildPublicApp();
    await pub.listen({ port: config.publicPort, host: config.host });
    console.log(`  Cardápio público:  http://localhost:${config.publicPort}/cardapio (somente cardápio)`);
  }
  console.log('');

  const stop = async () => { await app.close(); await pool.end(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error('Falha ao iniciar o servidor:', e);
  process.exit(1);
});
