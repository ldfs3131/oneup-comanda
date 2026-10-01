# ONE UP Comanda — sistema de gestão para restaurantes (ONE UP)

Pedidos, cozinha em tempo real, caixa, cardápio digital, estoque, despesas e financeiro para restaurantes, bares, lanchonetes e espetinhos. **Multi-empresa**: cada restaurante acessa pelo próprio endereço (`<empresa>.comanda.oneupsistemas.com.br`), isolado no banco de dados (Row Level Security), e o Dono **personaliza** o sistema em Configurações (nome, logotipo, cor, cardápio digital, regras do caixa e da cozinha, formas de pagamento e taxa da maquininha).

Base: Happy Alpha R2.0.2 (o Happy Alpha é o primeiro cliente).

## Documentos

| Documento | Para quê |
|---|---|
| [docs/INSTALACAO-ONLINE.md](docs/INSTALACAO-ONLINE.md) | Colocar no ar na VPS (um comando) e o dia a dia do servidor |
| [docs/ONE-UP-PROGRESSO.md](docs/ONE-UP-PROGRESSO.md) | O que já foi feito, pendências e como testar |
| [docs/GUIA-RAPIDO.md](docs/GUIA-RAPIDO.md) | Treinamento da equipe |
| [docs/ARQUITETURA.md](docs/ARQUITETURA.md) | Arquitetura (base R2) |
| [docs/PROMPT-MESTRE-ONE-UP.md](docs/PROMPT-MESTRE-ONE-UP.md), [docs/ONE-UP-AUDITORIA.md](docs/ONE-UP-AUDITORIA.md) | Histórico de construção (registro interno) |

## Rodar online

Ubuntu 24.04: `bash /opt/oneup/app/deploy/instalar.sh` (passo a passo em `docs/INSTALACAO-ONLINE.md`). Convive com outros sistemas no
mesmo servidor (usa o Nginx que já existir, Node e porta próprios). Comando do servidor: `oneup ajuda`.

## Testes

`./testes.sh` roda tudo em bancos novos: e2e (124), insights (30), isolamento (145), personalização (56), conexões (7), comitê (26), ONE UP (48).

## Garantias

- Cada empresa só enxerga e só grava os próprios dados — garantido pelo PostgreSQL, não só pelo código. Sem empresa definida, nenhuma linha aparece.
- Valores sempre calculados no servidor, em centavos. Preço e custo congelados na venda.
- O banco recusa apagar e editar vendas, pagamentos (só estorno), descontos, despesas (só cancelamento), estoque, custos, histórico, caixa fechado e histórico de configurações; recusa esvaziar tabelas.
- O Dono personaliza o jeito do negócio; o que protege o dinheiro não é configurável. Toda mudança de configuração fica no histórico; a ONE UP pode travar uma configuração com motivo visível ao Dono.
