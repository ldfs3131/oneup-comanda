# Contexto para quem programa no ONE UP Comanda (versão Happy Alpha 3.3)

Leia antes de mexer. Escrito para os agentes que trabalham em paralelo, cada um no seu ramo (worktree).

## O produto
PDV de restaurante, multiempresa por subdomínio. Primeiro cliente: Happy Alpha (Dono: Rafael). Lucas = ONE UP
(Administrador da plataforma; usuário com `users.oneup = true`, invisível ao Dono). Tudo online (VPS com Nginx/PM2).
Node 22/TS, Fastify 5, Drizzle, PostgreSQL 16 com RLS, React 19/Vite, React Query, Socket.IO. Português do Brasil
em toda tela, mensagem e comentário. Lucas não é programador: textos simples e diretos.

## Regras de ouro (inegociáveis)
1. **O Dono vê números, nunca interpretação.** Tudo que interpreta, aconselha ou cobra (análises, "o que os números
   dizem", engenharia de cardápio, recuperação de vendas, nota, gargalo, projeção, ranking, mapa de demora) é SÓ da
   ONE UP: rota com `requireOneup()` (de `server/src/auth.ts`, responde 404 para os outros), tela em rota protegida
   por `SoOneUp` (web/src/App.tsx), menu dentro da seção "ONE UP" do `AdminLayout`. Nenhum campo disso em resposta para
   ADMIN não-oneup, CAIXA ou COZINHA. Teste automático que confere isso.
2. Caixa fecha o dia às cegas. Cobrança nunca é automática (o sistema prepara a mensagem e abre `wa.me`; uma pessoa envia).
3. Consentimento de ofertas explícito; dados pessoais de clientes só quando necessários.
4. Nada de um restaurante vaza para outro (RLS em toda tabela nova; `empresa_id integer NOT NULL DEFAULT app_empresa()`).
5. Dinheiro em centavos inteiros; fuso America/Sao_Paulo; vendas, pagamentos e histórico imutáveis.
6. "5" é máximo, não meta: achado só aparece com amostra mínima; estimativa em R$ sempre com a premissa escrita.
7. Nunca usar nomes de clientes da ONE UP (Happy Alpha, Bom Bife, Champion) em textos de marketing/código genérico.

## Como o código é organizado
- `server/src/routes/*.ts` (registradas em `server/src/index.ts`), `server/src/services/*.ts`, `server/src/db/schema.ts`.
- Consultas: `db.execute(sql\`...\`)` ou Drizzle; o contexto da empresa já vem da requisição (RLS). Fora de requisição use
  `runAsEmpresa(id, fn)` ou `runAsSystem(fn)` (de `server/src/db/index.ts`).
- Erros: `bad()`, `conflict()`, `notFound()`, `HttpError` de `server/src/lib/http.ts`; validação com zod + `parse()`.
- Auditoria: `audit(tx, { userId, action, entityType, entityId, message })`.
- Configurações por restaurante: catálogo em `server/src/services/configuracoes.ts` (seção `oneup` = só a ONE UP vê).
- Telas: `web/src/pages/...`, componentes em `web/src/components/ui.tsx` (Modal, MoneyInput, Spinner, Badge, useAction),
  `api` em `web/src/api.ts`, formatos em `web/src/format.ts` (brl, pct, fmtDay...). Cores só por tokens CSS
  (`--brand`, `--surface`, `--muted`, `--ok`, `--danger`, `--cat-1..4` validadas para gráficos). Tema claro e escuro.
- Gráficos: siga a skill de dataviz (uma escala, sem eixo duplo, legenda com ≥2 séries, rótulos seletivos, toque mostra valor).

## Migrações
Somente aditivas e reaplicáveis (`IF NOT EXISTS`, políticas protegidas por `pg_policies`), em `server/drizzle/NNNN_nome.sql`
com `--> statement-breakpoint` entre comandos, e uma entrada em `server/drizzle/meta/_journal.json`
(`idx` = número do arquivo, `when` estritamente crescente). Números reservados:
0013 analise (Central de Análise) · 0014 crm (Recuperação de vendas) · 0015 plataforma. Não use outros.
Espelhe as colunas em `server/src/db/schema.ts`. GRANT para `oneup_app` e sequência.

## Testes
Cada entrega tem um script `server/src/scripts/<nome>-test.ts` no estilo dos existentes (check(label, cond)), que roda num
banco próprio e numa porta própria indicados no seu pedido. NÃO rode `./testes.sh` (usa portas e bancos fixos
compartilhados) — o coordenador roda tudo depois de juntar os ramos. Compile com `cd server && npx tsc -p tsconfig.json`
(gera `dist/`) e `cd web && npx tsc --noEmit -p .`. O PostgreSQL local é `postgres://postgres:postgres@localhost:5432`
(se cair: `service postgresql start`). Para subir um servidor de teste: `setup.js` cria a empresa e
`DATABASE_URL=... EMPRESA_HEADER=true PORT=<sua porta> node dist/scripts/../index.js` (cabeçalho `x-empresa` escolhe a empresa).
Um usuário ONE UP: `node dist/scripts/plataforma.js oneup-usuario --empresa=<slug> --login=<login> --nome="..." --senha=<8+>`.

## Entrega
Commit no seu ramo com mensagem em português, terminando com:
```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NHsVCQy13hEvgPaER1YgbU
```
No relatório final: arquivos criados/alterados, como testar, o que ficou de fora e por quê.
