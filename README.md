# Happy Alpha — Sistema de pedidos (V1)

Sistema web para o restaurante Happy Alpha: contas, pedidos, cozinha em tempo real, pagamentos, caixa, histórico e painel administrativo.

```
CONTA → PEDIDOS → COZINHA → PRONTO → PAGAMENTO → ENCERRAMENTO → FINANCEIRO
```

## Documentos

| Documento | Para quem |
|---|---|
| [docs/INSTALACAO.md](docs/INSTALACAO.md) | Instalar no computador do caixa (Windows) e configurar o tablet |
| [docs/GUIA-RAPIDO.md](docs/GUIA-RAPIDO.md) | Treinamento da equipe (caixa e cozinha) |
| [docs/ARQUITETURA.md](docs/ARQUITETURA.md) | Arquitetura, banco, telas, fluxos e roadmap |

## Telas

| Endereço | Quem usa |
|---|---|
| `/caixa` | Caixa (computador/tablet) |
| `/cozinha` | Tablet da cozinha |
| `/admin` | Administrador |
| `/cardapio` | Cliente (QR Code — desligado na V1) |

## Estrutura

```
server/   API Node.js + TypeScript (Fastify, Drizzle, PostgreSQL, Socket.IO)
  src/routes/     rotas por módulo (contas, cozinha, caixa, cardápio, admin, público)
  src/services/   regras de negócio (totais, status, fechamento, backup)
  drizzle/        migrações do banco (aplicadas ao iniciar)
web/      Front-end React + TypeScript (Vite)
windows/  Instalador e atalhos para o computador do caixa
docs/     Documentação
```

## Desenvolvimento

Pré-requisitos: Node.js 22 e PostgreSQL 16+.

```bash
npm install
cp .env.example .env          # ajuste DATABASE_URL
npm run build                 # compila web e servidor
npm run setup                 # migrações + usuários + cardápio (interativo)
npm start                     # http://localhost:3000

# desenvolvimento com recarga automática
npm run dev:server            # API em :3000
npm run dev:web               # front em :5173 (proxy para a API)
```

## Testes

Teste automatizado do cenário de aceite (68 verificações), rodado contra um banco de teste recém-configurado:

```bash
DATABASE_URL=postgres://.../happy_alpha_test node server/dist/scripts/setup.js --admin-pass=admin123 --caixa-pass=caixa123 --cozinha-pass=cozinha123
DATABASE_URL=postgres://.../happy_alpha_test PORT=3100 npm start &
DATABASE_URL=postgres://.../happy_alpha_test BASE_URL=http://localhost:3100 npm run test:e2e
```

## Garantias implementadas

- Valores sempre calculados no servidor, em centavos. O navegador só envia produto, quantidade e opções.
- O item vendido guarda nome e preço do momento da venda. **O banco recusa** alterar esses campos depois.
- **O banco recusa** apagar contas, pedidos, itens, pagamentos, descontos, cancelamentos, caixas e histórico.
- Só um caixa aberto por vez (trava no banco).
- Todo desconto, cancelamento, estorno e reabertura exige motivo e registra usuário e horário.
- Perfis com permissão verificada no servidor (a cozinha não acessa o financeiro).
