# ONE UP — Definições em discussão (não implementar ainda)

> Parecer do comitê analítico de 01/10: ver `ONE-UP-COMITE-2026-10-01.md` (matriz de votos, definições recomendadas e 5 decisões do Lucas).

Registro de 01/10/2026 (manhã). Entram no prompt mestre quando o Lucas fechar a discussão.
Referências visuais: `docs/referencias/financeiro-panorama-lucas.png` (modelo aprovado) e `docs/referencias/financeiro-atual-reprovado.png` (tela atual reprovada).

## D1. Aba "Empresas" do Administrador (cadastrar quem fechou com a ONE UP)
- Pedido: o Administrador adiciona uma empresa nova, que recebe o mesmo sistema do Happy Alpha dentro do ONE UP; logotipo (espaço reservado por empresa), cores e demais personalizações de funcionamento.
- Recomendação: assistente em 4 passos — (1) dados e endereço (`slug.restaurantes.oneup…`), (2) marca (logotipo, cor, nome, subtítulo), (3) plano e módulos, (4) acesso do Dono (convite ou senha inicial) e cardápio (em branco, planilha ou modelo genérico). Lista de empresas com status, abrir, suspender.
- Depende de: login próprio da ONE UP, separado do restaurante (fase 3). Não pode morar dentro do painel de um restaurante: quem administra um restaurante não pode criar outros.
- Reaproveita: catálogo de personalização, logotipo por empresa e cadeados (fase 2, já prontos); comando `setup.js` vira tela.
- Pré-requisito antes de cadastrar o 2º cliente: trocar o cardápio de exemplo (hoje é o do Happy Alpha) por um modelo genérico e tirar o logotipo do Happy Alpha do pacote.

## D2. Quais telas do panorama do financeiro o Dono vê
- Proposta do Lucas: Dono vê 1, 2, 3 e 4.
- Recomendação: Dono vê **1 Resumo** (com o filtro "Ano" fazendo o papel da tela 5), **2 Despesas** e **4 Produtos (números)**. **3 Fluxo** fica no Administrador (decisão congelada da R3: menos telas para o Dono; a barra de formas de pagamento já está no Resumo). Telas 6–10 são operação do Dono/Caixa (já decidido). 11–15 só Administrador.
- Em aberto: o Dono ordenar a tabela de produtos por lucro conta como "ranking"? (Decisão congelada: Dono sem ranking nem etiquetas.)

## D3. Relatório de Insights do Administrador por período
- Pedido: relatório completo com os 5 pontos que estão travando o negócio, com seletor 7d, 30d, 60d, 90d, 6M, 12M.
- Regras: compara sempre com o período anterior de mesmo tamanho (e mesmo período do ano anterior quando existir); "5" é máximo, não meta; abaixo da amostra mínima mostra "dados insuficientes" (7 dias costuma ser pouco para margem, estoque e clientes); impacto em R$ com premissa. É o Módulo I (Raio-X) com seletor de período.

## D4. Financeiro redesenhado (tela atual reprovada: parece planilha)
- Duas versões: **Dono** (3 abas: Resumo, Despesas, Produtos — o básico) e **Administrador** (completo de consultor: Resumo, Despesas, Fluxo, Produtos, Ano, Metas + leitura).
- **Resultado:** cartão-herói do lucro com margem e variação ▲▼; 4 cartões (Vendido, Custo, Despesas, A receber); cascata visual Vendido → Descontos → Custo → Despesas → Lucro com números que batem; barra única das formas de pagamento; no filtro Ano, 12 barras vendido × lucro; alerta "produto sem custo, o lucro pode estar maior".
- **Por produto:** tabela com preço, custo, margem, vendidos e lucro, com barra de margem por linha; "sem custo" nunca 100%; atalho para preencher o custo. Etiquetas e rankings só no Administrador.
- **Despesas:** barras por categoria (valor e %), comparativo dos últimos meses, lista dos lançamentos e botão "Lançar despesa".
- Seguir o padrão visual do panorama de referência e as regras de gráfico (uma escala, sem eixo duplo, legenda, cores validadas).

## D5. Itens viáveis para a nova versão (pedido de 01/10, 06h37) — análise contra o código

| # | Item | O que já existe | O que falta | Esforço real | Fase sugerida |
|---|---|---|---|---|---|
| 1 | QR Code do cardápio | Configurações já gera o QR do link `/cardapio` | Folha para imprimir (balcão e mesa, com nome e logotipo); QR por mesa (`/cardapio?mesa=7`) que preenche a mesa no pedido e chega ao caixa já identificado | Baixo | 4 |
| 2 | Número de comanda | Campo "Mesa" com nome configurável (pode virar "Comanda") | Campo "Comanda" separado e opcional, ligado em Configurações, para quem usa mesa **e** comanda; busca por número no caixa e na cozinha | Baixo | 4 |
| 3 | Divisão de conta | Já existe: dividir em N pessoas e pagamento misto (PIX + cartão + dinheiro com troco) na mesma conta | Dividir **por itens** (cada pessoa paga o que consumiu); continuar respeitando o fechamento às cegas (o caixa nunca vê totais do dia) | Médio | 4 |
| 4 | Impressão 80 mm | Não existe | Ticket da cozinha e recibo do cliente com layout térmico, pela impressão do navegador (USB ou rede). Impressão automática sem a janela de confirmação exige o computador com o navegador em modo quiosque de impressão: documentar no guia. Recibo com aviso "não é documento fiscal" | Baixo a médio | 4 |
| 5 | Vendas por funcionário | O sistema já grava quem abriu cada conta e pedido (hoje por login, não por pessoa) | Depende dos perfis por pessoa com PIN (fase 3). Tela: quem lançou, quanto, quantos pedidos, descontos e cancelamentos. Dono e Administrador | Baixo (após fase 3) | 3/4 |
| 6 | Fornecedores | Entrada de estoque prevê fornecedor em texto livre | Cadastro de fornecedores (por empresa, isolado) ligado a entradas de estoque e despesas; base para "variação de custo por fornecedor" da análise do Administrador | Baixo | 4 |
| 7 | Celular/tablet + PWA | Manifesto e ícones já existem; caixa, configurações e cardápio já testados no celular | Revisar telas de tabela larga (financeiro, histórico, cardápio do admin) no celular; instalar na tela inicial; aviso claro de "sem conexão". **Não** é modo offline: online continua obrigatório | Médio | junto da migração online (6) |

Pontos para decidir:
- Item 5 × decisão congelada da Leva 2 ("controle interno por turno, sem citar nome, salvo se o Dono ativar"): recomendação — vendas por funcionário **com nome** para o Dono (é gestão de equipe dele); análises de desvio/descontos por pessoa seguem só no Administrador.
- Item 3: quando um item é dividido entre pessoas, a divisão é só no pagamento (o pedido continua um só para a cozinha e o estoque).
