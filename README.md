# HAPPY ALPHA GOURMET R2 — Sistema de pedidos

Sistema web do restaurante Happy Alpha: contas, pedidos, cozinha em tempo real, pagamentos, caixa, estoque, despesas, financeiro, tempo de preparo. Desenvolvido por **ONE UP**.

```
ABRIR O DIA → CONTA → PEDIDOS → COZINHA → PRONTO → PAGAMENTO → ENCERRAR O DIA → FINANCEIRO
```

A R2 evolui a V1.1 **no mesmo banco** (histórico contínuo). A V1.1 fica preservada na tag git `v1.1`.

## Documentos

| Documento | Para quem |
|---|---|
| [docs/INSTALACAO.md](docs/INSTALACAO.md) | Instalar no Windows, atualizar da V1.1, tablet, QR/internet |
| [docs/GUIA-RAPIDO.md](docs/GUIA-RAPIDO.md) | Treinamento da equipe (caixa, cozinha, admin) |
| [docs/CARDAPIO-DIGITAL.md](docs/CARDAPIO-DIGITAL.md) | Cardápio online por link, ligado ao ABERTO/FECHADO do caixa |
| [docs/ARQUITETURA.md](docs/ARQUITETURA.md) | Arquitetura, banco, fluxos |

## Telas

| Endereço | Quem usa |
|---|---|
| `/caixa` | Caixa: contas, pedidos do dia, a receber, estoque, “acabou?”, dia/caixa |
| `/cozinha` | Tablet/TV da cozinha (modo TV e resumo de produção) |
| `/admin` | Administrador: dashboard, financeiro, pedidos, tempo de preparo, cardápio, auditoria |
| `/cardapio` | Cliente: cardápio online e pedido direto ao caixa (segue ABERTO/FECHADO) |

Portas padrão: **3010** (sistema), **3011** (demonstração), porta pública opcional (`PUBLIC_PORT`, ex. 3012). Nunca usa 3000/3001.

## Estrutura

```
server/   API Node.js 22 + TypeScript (Fastify 5, Drizzle, PostgreSQL 16, Socket.IO)
  src/routes/     contas, cozinha, caixa/dia, cardápio, estoque, gestão (financeiro, despesas, tempos, histórico), admin, público
  src/services/   regras de negócio (totais, situação FIFO, estoque, insights, fechamento, backup)
  drizzle/        migrações (aplicadas ao iniciar)
web/      Front-end React 19 + TypeScript (Vite)
windows/  Instalador e atalhos
docs/     Documentação
```

## Desenvolvimento

```bash
npm install
cp .env.example .env          # ajuste DATABASE_URL
npm run build
npm run setup                 # migrações + usuários + cardápio
npm start                     # http://localhost:3010
```

## Testes

```bash
# cenário completo V1 + R2 (124 verificações), em banco de teste recém-configurado
DATABASE_URL=postgres://.../happy_alpha_test node server/dist/scripts/setup.js --admin-name=Administrador --admin-pass=admin123 --caixa-pass=caixa123 --cozinha-pass=cozinha123
DATABASE_URL=postgres://.../happy_alpha_test PORT=3100 INSIGHTS_ENABLED=true npm start &
DATABASE_URL=postgres://.../happy_alpha_test BASE_URL=http://localhost:3100 npm run test:e2e

# cenários do Insights (30 verificações) — banco com "insights" no nome, recriado a cada cenário
DATABASE_URL=postgres://.../happy_alpha_insights npm run test:insights
```

## Garantias implementadas

- Valores sempre calculados no servidor, em centavos. O navegador só envia produto, quantidade e opções.
- O item vendido congela nome, preço e custo do momento da venda — **o banco recusa** alterar depois.
- **O banco recusa** apagar contas, pedidos, itens, pagamentos, descontos, cancelamentos, caixas, estoque, despesas e histórico.
- **O banco recusa** editar pagamentos (só estorno), descontos, cancelamentos, despesas (só cancelamento), movimentos de estoque, custos, histórico e caixa já fechado, e recusa esvaziar tabelas (TRUNCATE).
- Estoque nunca fica negativo (trava no banco); venda sem estoque só com decisão registrada (corrigir ou liberar com divergência).
- Duplo clique / reenvio não duplica conta, pedido nem pagamento (chave de idempotência).
- Reabertura: a cozinha recebe **só os itens novos**; os anteriores aparecem apenas como referência.
- Fechamento às cegas: o caixa só vê o dinheiro esperado depois de contar.
- Caixa só enxerga o dia atual + contas vivas e pendentes (verificado no servidor).
- Todo desconto, cancelamento, estorno, ajuste de estoque, correção de horário e reabertura exige motivo e registra usuário, perfil e horário.
- Insights com números determinísticos (nada gerado por IA), comparação explícita e “Por quê?” com o método.
