import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createReadStream, mkdirSync } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { empresaAtual } from '../db/index.js';
import { bad } from './http.js';
import { empresaPorSlug, slugDaRequisicao } from './empresa.js';

/** Tipo REAL da imagem pelos primeiros bytes (não pelo nome do arquivo). */
function tipoReal(b: Buffer): 'png' | 'jpg' | 'webp' | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/**
 * Recebe uma imagem enviada pelo Dono e grava na pasta da própria empresa.
 * Aceita só PNG, JPG e WEBP de verdade (confere o conteúdo); o nome do arquivo é gerado aqui.
 */
export async function salvarImagem(req: FastifyRequest, prefixo: string, maxBytes: number) {
  const file = await req.file({ limits: { fileSize: maxBytes } });
  if (!file) throw bad('Envie uma imagem.');
  const buf = await file.toBuffer().catch(() => { throw bad(`Imagem muito grande (máximo ${Math.round(maxBytes / 1024 / 1024)} MB).`); });
  if (file.file.truncated) throw bad(`Imagem muito grande (máximo ${Math.round(maxBytes / 1024 / 1024)} MB).`);
  const tipo = tipoReal(buf);
  if (!tipo) throw bad('O arquivo não é uma imagem PNG, JPG ou WEBP válida.');
  const pasta = join(config.uploadsDir, String(empresaAtual()));
  mkdirSync(pasta, { recursive: true });
  const nome = `${prefixo}-${randomBytes(6).toString('hex')}.${tipo}`;
  await writeFile(join(pasta, nome), buf);
  return `/uploads/${empresaAtual()}/${nome}`;
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

/**
 * Imagens enviadas: cada empresa só enxerga as próprias (/uploads/<id da empresa>/<arquivo>),
 * conferindo o endereço de acesso. Nunca executam nada no navegador.
 */
export function rotaUploads(app: FastifyInstance) {
  app.get('/uploads/:empresa/:arquivo', async (req, reply) => {
    const { empresa, arquivo } = req.params as { empresa: string; arquivo: string };
    const m = /^[a-z0-9_-]{1,80}\.(png|jpe?g|webp)$/i.exec(arquivo);
    const emp = await empresaPorSlug(slugDaRequisicao(req.headers.host, req.headers['x-empresa']));
    if (!m || !/^\d+$/.test(empresa) || !emp || String(emp.id) !== empresa) return reply.code(404).send({ error: 'Imagem não encontrada.' });
    const caminho = join(config.uploadsDir, empresa, arquivo);
    const st = await stat(caminho).catch(() => null);
    if (!st?.isFile()) return reply.code(404).send({ error: 'Imagem não encontrada.' });
    reply.header('content-type', MIME[m[1].toLowerCase()]);
    reply.header('content-length', st.size);
    reply.header('cache-control', 'public, max-age=86400');
    reply.header('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    return reply.send(createReadStream(caminho));
  });
}
