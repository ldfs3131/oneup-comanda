# Comitê analítico ONE Food — 01/10/2026

Pauta: definições D1–D5 (`ONE-FOOD-DEFINICOES-PENDENTES.md`). Cinco pareceres independentes, cada membro sem ver os outros:
**Operação** (dono de restaurante pequeno) · **Finanças** (consultor de food service e dados) · **Arquitetura** (software e segurança) · **Comercial** (SaaS para pequeno varejo) · **Produto/UX**.

Legenda: ✅ aprovar · 🟡 aprovar com ajuste · ⏸ adiar.

## 1. Matriz de votos

| Item | Operação | Finanças | Arquitetura | Comercial | UX | Resultado |
|---|---|---|---|---|---|---|
| D1 Aba Empresas | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | **Consenso: aprovado com ajuste** |
| D2 Telas do Dono | 🟡 | 🟡 | 🟡 | 🟡 | ✅ | **Consenso** |
| D3 Insights por período | ⏸ | 🟡 | ⏸ | 🟡 | 🟡 | **Aprovado como serviço, com regras; construção na fase 7** |
| D4 Financeiro novo | ✅ | 🟡 | ✅ | ✅ | ✅ | **Consenso, prioridade alta** |
| D5.1 QR por mesa | 🟡 | ✅ | 🟡 | ✅ | ✅ | **Consenso** |
| D5.2 Comanda | ✅ | ✅ | ✅ | 🟡 | 🟡 | **Consenso** |
| D5.3 Dividir por itens | 🟡 | 🟡 | 🟡 | ⏸ | 🟡 | **Aprovado, prioridade baixa (fim da fase 4)** |
| D5.4 Impressão 80 mm | 🟡 | ✅ | 🟡 | ✅ | ✅ | **Unânime — prioridade nº 1** |
| D5.5 Vendas por funcionário | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | **Consenso com as mesmas condições** |
| D5.6 Fornecedores | ⏸ | 🟡 | ✅ | ⏸ | 🟡 | **Dividido → versão leve agora, cadastro completo depois** |
| D5.7 Celular/PWA | ✅ | ✅ | 🟡 | 🟡 | ✅ | **Consenso** |

## 2. Definições recomendadas

**D1 — Aba Empresas.**
- Mora no painel da ONE UP (`painel.<domínio>`), com login próprio e duas etapas. Nunca dentro do painel de um restaurante.
- Assistente em 3–4 passos: nome e endereço gerado; marca com prévia ao vivo; plano e Dono; concluir.
- Convite por link de uso único (72 h) em que o Dono cria a senha. Sem "senha inicial" trafegando por WhatsApp.
- Criação numa transação só, com status IMPLANTAÇÃO; endereço fixo depois de ativado; nomes reservados (admin, painel, api, www, demo).
- A tela não vê pedidos nem financeiro (isso é o modo suporte, fase 5) e não apaga empresa.
- Cardápio inicial por modelo genérico ou planilha, implantado pela ONE UP. Operação vetou "em branco": cliente começa sem cardápio e não opera na primeira sexta.
- Quando: o pré-requisito sai já (cardápio genérico, logotipo do Happy Alpha fora do pacote). A tela vem logo após a fase 3 se o 2º cliente assinar antes; senão, como primeira tela do Command Center.

**D2 — Telas do Dono.**
- Dono vê **1 Resumo** (com o filtro Ano no lugar da tela 5), **2 Despesas** e **4 Produtos**.
- **3 Fluxo** fica no Administrador, mas o Resumo ganha o bloco **"Entrou no caixa"** (formas de pagamento e fiado recebido), porque dono pequeno pensa em caixa.
- **Ordenar coluna não é ranking (5 de 5).** A lista abre em ordem alfabética, sem posição numerada, "top" ou etiqueta, com a barra de margem numa cor só.
- Exceção a registrar por escrito: o Dono vê **uma** variação, contra o período anterior equivalente (mesmos dias). Média de 3 meses e comparação com o ano anterior ficam no Admin.
- Tirar da tela do Dono: "▲67% jan→set" (escolhe as pontas e engana), "melhor e pior dia", "margem baixa/saudável".
- Na tabela de produtos, "Lucro" vira **"Sobra bruta"**: não desconta despesas e não pode parecer um segundo lucro.

**D3 — Relatório dos 5 pontos por período.** É o Raio-X: serviço pago da ONE UP, nunca autoatendimento do Dono.
- Abre em 30 dias. Cada detector declara as janelas em que vale; fora delas, "não se aplica".

| Janela | Serve para |
|---|---|
| 7 dias | Só sinais operacionais: cancelamentos, diferença de caixa, ruptura, desconto fora do padrão, tempo de preparo |
| 30 dias | Margem, ticket, mix |
| 60/90 dias | Custo por fornecedor, clientes sumidos, despesas |
| 6/12 meses | Sazonalidade. Comparação com o ano anterior só a partir do 13º mês |

- Despesas sempre por **mês fechado**.
- Contra falso alarme: comparar o mesmo dia da semana, calendário de feriados por empresa, dia atípico fora da conta, mediana, e limiar duplo (por exemplo, ≥15% **e** ≥R$ 300/mês). Ordenar por impacto × confiança.
- Amostras mínimas: produto com 30 unidades; dia da semana com 4 ocorrências; geral com 14 dias e 100 pedidos; fornecedor com 3 compras em 60 dias.

**D4 — Financeiro novo.**
- **Dono, 3 abas:** Resumo ("quanto sobrou?"), Despesas ("para onde foi?"), Produtos ("quanto cada um deixa?"). Uma rolagem no tablet; períodos Hoje · 7 dias · Mês · Ano.
- **Ordem do Resumo:**
  1. faixa de qualidade do dado ("X produtos sem custo: o lucro mostrado está **acima** do real"; "nenhuma despesa lançada neste mês");
  2. cartão grande do lucro, com margem e ▲▼;
  3. 4 cartões: Vendido, Custo, Despesas, A receber;
  4. cascata "Do vendido ao que sobrou";
  5. "Entrou no caixa" por forma de pagamento;
  6. no Ano, 12 colunas vendido × lucro.
- **Linguagem de dono:** Vendido, Custo dos produtos, Despesas, Sobrou. Sem "CMV", "faturamento" ou "resultado operacional".
- **Admin acrescenta:** Fluxo, Ano com tabela, Metas e ponto de equilíbrio, média por dia da semana, comparativos, etiquetas, "mais vende × mais lucra" e o bloco "o que os números dizem".
- **Regras de cálculo (Finanças):**
  - cascata calculada no servidor, com teste de que fecha exato;
  - margem sempre sobre as vendas líquidas de desconto;
  - custo congelado na venda;
  - compra de mercadoria entra como custo pelo estoque, **nunca também como despesa**;
  - fiado vencido há mais de 60 dias aparece à parte;
  - "vs mês anterior" compara os mesmos dias.
  - Observação: o próprio panorama de referência não fecha (produtos somam cerca de R$ 28,5 mil e o Resumo, R$ 18,4 mil). É modelo visual, não de números.

**D5 — Itens viáveis.**
1. **Impressão 80 mm (prioridade 1).**
   - Falha de impressora nunca trava nem desfaz o pedido; botão "reimprimir"; suporte também a 58 mm.
   - Cozinha com modo Automático (quiosque) / Perguntar / Não. O ticket mostra a mesa grande, a observação em destaque e só os itens novos.
   - Recibo com Imprimir / WhatsApp / Pronto, só o primeiro nome, "não é documento fiscal" e nunca totais do dia.
   - Impressão automática só num perfil de navegador exclusivo para isso.
2. **QR por mesa.**
   - Código aleatório por mesa (`/cardapio?m=k3F9x`), não `?mesa=7`, que qualquer um troca.
   - A mesa é sugestão do cliente e passa pela confirmação do caixa ("mesa informada pelo cliente").
   - Folha pronta para imprimir, com nome e logotipo.
3. **Comanda.**
   - Busca por número já; segundo campo opcional, ligado em Configurações, com teclado numérico.
   - Bloquear duas comandas abertas com o mesmo número.
4. **Vendas por funcionário (após o PIN).**
   - Dono vê com nome, ordenado por nome, só números crus: vendas, pedidos, descontos e cancelamentos antes e depois do preparo, por turno.
   - Sem ranking e sem "suspeito". Desvio por pessoa fica no Admin.
   - Dados anteriores ao PIN não são reaproveitados. Reforçar na implantação: "cada um no seu PIN".
5. **Celular/PWA.**
   - Primeiro o financeiro do Dono no celular; tabelas viram cartões abaixo de 600 px.
   - Pode guardar no aparelho: só os arquivos do sistema. Nunca `/api`, `index.html`, cardápio ou login. Cloudflare com `no-store` na API.
6. **Fornecedores.**
   - Versão leve na fase 4: o fornecedor nasce do autocompletar na entrada de compra e na despesa, sem item de menu.
   - Cadastro completo (unidade-base, custo médio ou último custo) junto do Raio-X de estoque.
7. **Dividir por itens.**
   - Modo dentro do mesmo modal de pagamento (Igual | Por itens), no fim da fase 4. O "pago R$ 40 e vou embora" já existe como pagamento parcial.

## 3. Pontos novos levantados pelo comitê (não estavam na pauta)

| # | Ponto | Quem | Recomendação |
|---|---|---|---|
| N1 | **Nota fiscal (NFC-e)** é a objeção nº 1 de venda. Concorrentes entregam até no plano grátis. | Comercial | Decidir: integrar via parceiro ou declarar fora com prazo |
| N2 | Sessão do aparelho autorizado cai às 21h sem o Dono no local | Operação | Definir validade da autorização e PIN de gerente para religar o aparelho |
| N3 | Fraude fora do fechamento às cegas: PIX marcado sem cair e cancelamento depois de pago | Operação | Mostrar ao Dono, no dia seguinte, os números crus de cancelamentos pós-pagamento e PIX manuais |
| N4 | Volta do papel quando a internet cai: lançar depois com o horário real | Operação | "Lançamento posterior" marcado como "veio do papel", fora do tempo de preparo |
| N5 | Migração: paralelo no balcão vira digitação dupla | Operação | Paralelo só para o Dono consultar; virada numa segunda com fiado, estoque e caixa fechados |
| N6 | `DEFAULT_EMPRESA` + `BASE_DOMAIN` juntos: endereço digitado errado abre a empresa nº 1 | Arquitetura | Proibir a combinação em produção (fase 3) |
| N7 | Status SUSPENSA ainda não bloqueia nada | Arquitetura | Modo somente consulta antes do botão "Suspender" |
| N8 | Upload valida só a extensão | Arquitetura | Conferir o tipo real, recusar SVG, regravar a imagem |
| N9 | Menu do Dono hoje tem 16 itens | UX | Menu final em 6: **Hoje · Caixa · Financeiro · A receber · Estoque · Gestão** (Pendências vira número de aviso em Hoje) |
| N10 | O Raio-X é a receita principal e está na última fase | Comercial | Fazer os primeiros Raio-X à mão (já decidido para outubro) com o Happy Alpha e 2–3 pilotos; automatizar só o que se repetir |
| N11 | Taxas de cartão/PIX, impostos e feriados por empresa | Finanças | Entram no cadastro da empresa (D1, passo do plano) |

## 4. Ordem de construção recomendada

1. **Fase 3:** PIN, login da ONE UP separado com duas etapas, N2, N6, N7.
2. **Fase 4a:** D4 + D2 (financeiro do Dono) com teste de conciliação e de escassez; menu do Dono em 6 itens (N9).
3. **Fase 4b:** D5.4 impressão → D5.1 QR por mesa → D5.2 comanda → fornecedor leve → N3 e N4.
4. **Fase 4c:** D5.5 vendas por funcionário → D5.3 dividir por itens.
5. **Antes do 2º cliente:** cardápio genérico, logotipo fora do pacote, slugs reservados, N8; D1 mínima se o cliente vier antes do Command Center.
6. **Fase 5:** D1 completa, modo suporte, Financeiro ONE UP.
7. **Fase 6:** D5.7 PWA junto da migração (com N5).
8. **Fase 7:** D3 e o financeiro completo do Admin. Até lá, Raio-X manual (N10).

## 5. Decisões que dependem do Lucas

1. **Nota fiscal (N1):** integrar agora via parceiro, prever para depois com prazo, ou vender sem e assumir a objeção?
2. **Exceção ao congelado (D2):** o Dono pode ver uma variação contra o período anterior equivalente?
3. **Fornecedores (D5.6):** confirma a versão leve na fase 4 e o cadastro completo depois?
4. **Aba Empresas (D1):** antecipar logo após a fase 3 ou esperar o Command Center (até lá, cadastro por comando)?
5. **Planos (proposta do Comercial):** Essencial (sistema) · Gestão (com PIN, delivery e Raio-X mensal; o plano a empurrar) · Parceiro (com recuperação de vendas e leituras de 90 dias a 12 meses). Usar como base?
