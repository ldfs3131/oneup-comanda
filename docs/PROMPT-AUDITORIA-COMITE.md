# PROMPT — Auditoria do ONE UP Comanda por um comitê de especialistas

> Versão 1 · 04/10/2026 · alvo: versão 3.2.0 (`/home/claude/one-food`), antes de o Happy Alpha (Rafael) testar online.

## Missão
Vocês são um comitê independente contratado pela ONE UP para dizer, sem rodeios, **o que pode dar errado no dia em que
o sistema estiver no ar num restaurante de verdade** — e o que tornaria o produto claramente melhor. Não elogiem.
Não repitam o que já funciona. Cada achado tem de ser **verificável no código** (arquivo e linha) e, quando possível,
**reproduzido** (comando, requisição ou teste). Opinião sem evidência não entra no relatório.

## O sistema (contexto mínimo)
- PDV de restaurante, multiempresa por subdomínio (`<empresa>.comanda.oneupsistemas.com.br`), uma VPS Hostinger com
  Nginx + PM2 já rodando outro sistema (Lava Jato). Node 22/TypeScript, Fastify 5, Drizzle, PostgreSQL 16 com RLS
  (`app_empresa()`, papel `oneup_app`), React 19/Vite, React Query, Socket.IO. PWA instalável (clientes e equipe).
- Perfis: Dono (ADMIN), Caixa, Cozinha; `users.oneup` = ONE UP (Administrador da plataforma, invisível ao Dono).
- Dinheiro em centavos inteiros; fuso America/Sao_Paulo; vendas, pagamentos e histórico imutáveis por trigger.
- Regras de ouro do produto: o Dono vê números, nunca interpretação; o Caixa fecha o dia às cegas; cobrança nunca é
  automática; consentimento de ofertas explícito; nada de dados de um restaurante vazar para outro.
- Pastas: `server/src` (rotas, serviços, auth, db/schema), `server/drizzle` (migrações), `web/src` (telas),
  `deploy/` (instalador, CLI `oneup`), `docs/`. Testes: `./testes.sh` (9 suítes, 553 verificações).

## Comitê (cada um lê o código da sua área e só da sua área)
1. **Segurança e multiempresa** — autenticação, sessão, PIN e aparelhos, CSRF/cookies, permissões por rota (ADMIN, CAIXA,
   COZINHA, ONE UP), RLS em todas as tabelas e em todo caminho que roda fora de `runAsEmpresa`, sockets por empresa,
   uploads de imagem, limites de tentativa, rotas públicas (cardápio, acompanhamento por código), injeção, XSS,
   cabeçalhos HTTP, segredos e logs.
2. **Integridade do dinheiro** — totais de conta, descontos, pagamentos parciais, estorno, fechamento de caixa (esperado,
   sangria, suprimento, despesa da gaveta), fiado, taxas da maquininha, financeiro (cascata, período anterior, 12 meses),
   arredondamento, concorrência (dois caixas ao mesmo tempo), idempotência, fuso horário e virada de dia.
3. **Operação de restaurante (PDV/UX)** — fluxo real de sexta à noite: abrir dia, pedido, cozinha, pronto, entrega,
   pagamento dividido, conta esquecida, cancelamento, estoque zerado, internet caindo, tablet recarregando, troca de
   pessoa por PIN. Onde o funcionário erra, trava ou perde tempo.
4. **Frontend, app e acessibilidade** — PWA (manifestos, service worker, instalação iPhone/Android), celular/tablet,
   tema claro/escuro, estados de carregamento/erro/vazio, textos, toque mínimo, leitura, contraste, desempenho do bundle.
5. **Infraestrutura, deploy e continuidade** — `deploy/instalar.sh`, CLI `oneup` (atualizar, voltar atrás, backup,
   restaurar), convivência com Nginx/PM2 existente, HTTPS, firewall, backups (frequência, teste de restauração, cópia
   externa), monitoramento, o que acontece se a VPS reiniciar, disco encher ou o Postgres parar.
6. **Banco de dados e desempenho** — migrações aditivas e reaplicáveis, índices para as consultas quentes (painel do caixa,
   cozinha, financeiro, A receber, pendências), N+1, transações e travas, crescimento de 1 ano de dados, pool de conexões.
7. **Produto, LGPD e regras de negócio** — consentimento e dados pessoais (cliente, telefone, WhatsApp), retenção,
   o que o Dono vê × o que só a ONE UP vê (nenhum campo de interpretação vazando), mensagens ao cliente, coerência
   entre telas, lacunas que o Rafael vai sentir na primeira semana.

## Método (obrigatório)
1. Ler o código antes de opinar. Rodar comandos quando ajudar (o PostgreSQL local é `postgres://postgres:postgres@localhost:5432`;
   `cd server && npm run build` compila; os testes ficam em `server/src/scripts/*-test.ts`).
2. **Não alterar nenhum arquivo do projeto.** Scripts de prova vão para a pasta temporária de vocês.
3. Para cada suspeita, tentar derrubá-la: se não conseguir apontar o cenário concreto que quebra, ela não é achado.
4. Separar **falha** (algo está errado hoje) de **melhoria** (está certo, mas pode ficar melhor).

## Severidade
- **CRÍTICA** — perde ou expõe dinheiro/dados, vaza entre restaurantes, derruba o sistema, ou impede operar.
- **ALTA** — erro provável em uso normal com prejuízo real, ou brecha explorável por alguém de dentro.
- **MÉDIA** — erro em caso menos comum, ou atrito que custa tempo toda semana.
- **BAIXA** — detalhe, texto, polimento.

## Formato de cada achado
```
[SEVERIDADE] Título curto
Área: <comitê> · Arquivo: caminho:linha
Cenário: passo a passo concreto → o que acontece de errado
Evidência: trecho, comando ou requisição que comprova
Correção sugerida: o que mudar (específico)
Confiança: CONFIRMADO (reproduzido) | PROVÁVEL (lido no código, não reproduzido)
```
Máximo de 12 achados por especialista, os mais graves primeiro. Depois, até 5 **melhorias** priorizadas
(impacto × esforço) e uma frase com o maior risco da área.

## Depois do comitê
O coordenador verifica cada achado de novo, corrige no código os CRÍTICOS e ALTOS confirmados (com teste automático que
falharia antes da correção), mantém `./testes.sh` verde, versiona e publica o relatório: o que foi encontrado, o que foi
corrigido e as melhorias para o Lucas decidir.
