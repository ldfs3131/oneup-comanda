import { createReadStream, mkdirSync } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { empresaAtual } from '../db/index.js';
import { bad } from './http.js';
import { empresaPorSlug, slugDaRequisicao } from './empresa.js';
/** Tipo REAL da imagem pelos primeiros bytes (não pelo nome do arquivo). */
function tipoReal(b) {
    if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a)
        return 'png';
    if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
        return 'jpg';
    if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP')
        return 'webp';
    return null;
}
/** Largura × altura lidas do cabeçalho do arquivo (PNG, JPG ou WEBP), sem biblioteca de imagem. */
export function dimensoes(b) {
    const t = tipoReal(b);
    if (t === 'png' && b.length > 24)
        return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (t === 'jpg') {
        let i = 2;
        while (i + 9 < b.length) {
            if (b[i] !== 0xff) {
                i++;
                continue;
            }
            const m = b[i + 1];
            if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
                return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
            i += 2 + b.readUInt16BE(i + 2);
        }
        return null;
    }
    if (t === 'webp' && b.length > 30) {
        const fmt = b.toString('ascii', 12, 16);
        if (fmt === 'VP8X')
            return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
        if (fmt === 'VP8 ')
            return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
        if (fmt === 'VP8L') {
            const v = b.readUInt32LE(21);
            return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 };
        }
    }
    return null;
}
const cacheDim = new Map();
/** Dimensões de uma imagem já enviada (/uploads/<empresa>/<arquivo>), com cache. */
export function dimensoesDe(url) {
    if (cacheDim.has(url))
        return cacheDim.get(url);
    const m = /^\/uploads\/(\d+)\/([a-z0-9_-]{1,80}\.(png|jpe?g|webp))$/i.exec(url);
    let d = null;
    try {
        if (m)
            d = dimensoes(readFileSync(join(config.uploadsDir, m[1], m[2])));
    }
    catch {
        d = null;
    }
    if (cacheDim.size > 5000)
        cacheDim.clear();
    cacheDim.set(url, d);
    return d;
}
/** Ícone do aplicativo: quadrado e com pelo menos 192 px (o celular recusa ícone pequeno ou torto). */
export function validarIcone(b) {
    const d = dimensoes(b);
    if (!d)
        throw bad('Não consegui ler o tamanho da imagem. Envie um PNG ou JPG.');
    if (Math.abs(d.w - d.h) > Math.max(2, d.w * 0.02))
        throw bad(`O ícone precisa ser quadrado (a imagem tem ${d.w} × ${d.h}).`);
    if (d.w < 192)
        throw bad(`O ícone precisa ter pelo menos 192 × 192 px (a imagem tem ${d.w} × ${d.h}). Ideal: 512 × 512.`);
}
/** Grava uma imagem já em memória (ferramenta da plataforma) na pasta da empresa do contexto. */
export async function gravarImagem(buf, prefixo) {
    const tipo = tipoReal(buf);
    if (!tipo)
        throw bad('O arquivo não é uma imagem PNG, JPG ou WEBP válida.');
    const pasta = join(config.uploadsDir, String(empresaAtual()));
    mkdirSync(pasta, { recursive: true });
    const nome = `${prefixo}-${randomBytes(6).toString('hex')}.${tipo}`;
    await writeFile(join(pasta, nome), buf);
    return `/uploads/${empresaAtual()}/${nome}`;
}
/**
 * Recebe uma imagem enviada pelo Dono e grava na pasta da própria empresa.
 * Aceita só PNG, JPG e WEBP de verdade (confere o conteúdo); o nome do arquivo é gerado aqui.
 */
export async function salvarImagem(req, prefixo, maxBytes, validar) {
    const file = await req.file({ limits: { fileSize: maxBytes } });
    if (!file)
        throw bad('Envie uma imagem.');
    const buf = await file.toBuffer().catch(() => { throw bad(`Imagem muito grande (máximo ${Math.round(maxBytes / 1024 / 1024)} MB).`); });
    if (file.file.truncated)
        throw bad(`Imagem muito grande (máximo ${Math.round(maxBytes / 1024 / 1024)} MB).`);
    const tipo = tipoReal(buf);
    if (!tipo)
        throw bad('O arquivo não é uma imagem PNG, JPG ou WEBP válida.');
    validar?.(buf);
    const pasta = join(config.uploadsDir, String(empresaAtual()));
    mkdirSync(pasta, { recursive: true });
    const nome = `${prefixo}-${randomBytes(6).toString('hex')}.${tipo}`;
    await writeFile(join(pasta, nome), buf);
    return `/uploads/${empresaAtual()}/${nome}`;
}
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
/**
 * Imagens enviadas: cada empresa só enxerga as próprias (/uploads/<id da empresa>/<arquivo>),
 * conferindo o endereço de acesso. Nunca executam nada no navegador.
 */
export function rotaUploads(app) {
    app.get('/uploads/:empresa/:arquivo', async (req, reply) => {
        const { empresa, arquivo } = req.params;
        const m = /^[a-z0-9_-]{1,80}\.(png|jpe?g|webp)$/i.exec(arquivo);
        const emp = await empresaPorSlug(slugDaRequisicao(req.headers.host, req.headers['x-empresa']));
        if (!m || !/^\d+$/.test(empresa) || !emp || String(emp.id) !== empresa)
            return reply.code(404).send({ error: 'Imagem não encontrada.' });
        const caminho = join(config.uploadsDir, empresa, arquivo);
        const st = await stat(caminho).catch(() => null);
        if (!st?.isFile())
            return reply.code(404).send({ error: 'Imagem não encontrada.' });
        reply.header('content-type', MIME[m[1].toLowerCase()]);
        reply.header('content-length', st.size);
        reply.header('cache-control', 'public, max-age=86400');
        reply.header('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
        return reply.send(createReadStream(caminho));
    });
}
