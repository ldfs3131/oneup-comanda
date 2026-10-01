# ONE Food — sistema de restaurante da ONE UP

Pedidos, cozinha em tempo real, caixa, estoque, despesas e financeiro para restaurantes, bares, lanchonetes e espetinhos. **Multi-empresa**: cada restaurante acessa pelo próprio endereço (`<slug>.onefood.com.br`), isolado no próprio banco de dados (Row Level Security), e **personaliza** o sistema em Configurações.

Base: Happy Alpha R2.0.2 (o Happy Alpha é a empresa nº 1).

## Documentos

| Documento | Para quê |
|---|---|
| [docs/PROMPT-MESTRE-ONE-FOOD.md](docs/PROMPT-MESTRE-ONE-FOOD.md) | Prompt único de construção (vale sobre os antigos) |
| [docs/ONE-FOOD-PROGRESSO.md](docs/ONE-FOOD-PROGRESSO.md) | O que já foi feito, pendências e como testar |
| [docs/ONE-FOOD-AUDITORIA.md](docs/ONE-FOOD-AUDITORIA.md) | Auditoria de partida e plano por fases |
| [docs/GUIA-RAPIDO.md](docs/GUIA-RAPIDO.md) | Treinamento da equipe |
| [docs/ARQUITETURA.md](docs/ARQUITETURA.md) | Arquitetura da R2 (base) |

## Rodar online (Coolify)

1. PostgreSQL 16 no Coolify. Copie `.env.example` para as variáveis do app (`DATABASE_URL`, `BASE_DOMAIN`, `COOKIE_SECURE=true`, `TRUST_PROXY=2`).
2. Deploy com o `Dockerfile` (as migrações rodam sozinhas ao iniciar; saúde em `/api/health`).
3. DNS no Cloudflare: `*.onefood.com.br` apontando para o servidor.
4. Criar empresa: `node server/dist/scripts/setup.js --empresa=<slug> --nome="<Nome>" --admin-name="<Dono>" --admin-pass=... --caixa-pass=... --cozinha-pass=...`
5. Plano e cadeados: `node server/dist/scripts/plataforma.js empresas | catalogo | travar | destravar | definir`

## Testes

`test:e2e` (124), `test:insights` (30), `test:isolamento` (145), `test:personalizacao` (53). Passo a passo em `docs/ONE-FOOD-PROGRESSO.md`.

## Garantias

- Cada empresa só enxerga e só grava os próprios dados — garantido pelo PostgreSQL, não só pelo código. Sem empresa definida, nenhuma linha aparece.
- Valores sempre calculados no servidor, em centavos. Preço e custo congelados na venda.
- O banco recusa apagar e editar vendas, pagamentos (só estorno), descontos, despesas (só cancelamento), estoque, custos, histórico, caixa fechado e histórico de configurações; recusa esvaziar tabelas.
- O Dono personaliza o jeito do negócio; o que protege o dinheiro não é configurável. Toda mudança de configuração fica no histórico; a ONE UP pode travar uma configuração com motivo visível ao Dono.
