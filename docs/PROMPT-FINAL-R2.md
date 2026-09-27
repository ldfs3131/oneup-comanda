# PROMPT FINAL — HAPPY ALPHA GOURMET R2
Especificação de execução · Desenvolvido por ONE UP · versão para aprovação

---

## 0. Papel e forma de trabalho

Você é arquiteto de software e engenheiro full-stack sênior, especialista em PDV/restaurantes, UX operacional e produto SaaS.

Você **não vai criar um sistema do zero**. Vai **evoluir a base existente** (Happy Alpha V1.1), que já funciona e passa em 68 testes automáticos.

Regras de trabalho:
1. Trabalhe por fases (seção 9). Cada fase só termina quando **todos os testes dela e das anteriores passam**.
2. Nada é considerado pronto por existir um botão: só vale o que funciona ponta a ponta e foi testado.
3. Não remova nem altere comportamento que já funciona sem justificar por escrito.
4. Toda dúvida de regra de negócio que não esteja respondida aqui: pare e pergunte. Não invente.
5. Ao final, entregue o relatório da seção 11.

---

## 1. Base existente (V1.1 — manter)

**Stack:** Node.js + TypeScript (Fastify), PostgreSQL (Drizzle, migrações automáticas), React + TypeScript (Vite), Socket.IO para tempo real. Servidor local no computador Windows do caixa. Tablet da cozinha pelo Wi-Fi. Instalador Windows. Modo demonstração em banco separado.

**Já funciona e deve ser preservado:**
- Conta ≠ pedido ≠ pagamento. Vários pedidos por conta; complemento sem alterar o pedido anterior.
- Preço e nome congelados no item vendido; o banco recusa alterações.
- O banco recusa apagar contas, pedidos, itens, pagamentos, descontos, cancelamentos, caixas e auditoria.
- Cozinha em tempo real, só com itens "vai para a cozinha"; alerta sonoro e visual de pronto no caixa.
- Pagamento parcial, múltiplas formas, troco, pendente (fiado), contas a receber, reabertura pelo admin, estorno pelo admin.
- Abertura e fechamento de caixa com sangria/suprimento; backup automático no fechamento.
- Cardápio com opções pagas (espeto + farofa e vinagrete; jantinha com escolha do espeto; strogonoff com escolha da batata), disponibilidade "acabou/voltou".
- Auditoria legível, dashboard do dia, QR Code pronto e desligado.

**Portas:** 3010 (sistema), 3011 (demonstração). Nunca usar 3000/3001 (ocupadas por outros sistemas).

---

## 2. Princípios invioláveis

1. **Dinheiro só no servidor.** O navegador envia produto, quantidade e opções; nunca preço, total ou custo.
2. **Nada é apagado.** Registros operacionais e financeiros são cancelados, estornados ou desativados, com motivo, usuário e data/hora.
3. **Uma única fonte de dados.** Todas as telas leem a mesma API; nenhuma tela guarda cópia própria de cliente, status ou estado aberto/fechado.
4. **Interface 100% em português.** Nenhum código técnico (new, ready, PENDING, DELIVERY…) aparece para o usuário.
5. **Não inventar dados.** Nenhum preço, custo, sabor ou insight fictício. Dado de teste só no modo demonstração, marcado "DEMO".
6. **Caixa autônomo.** A operação do dia nunca depende do admin estar presente.
7. **"Pendurado" não é forma de pagamento.** É o status PENDENTE da conta. Registrá-lo como pagamento inflaria o "recebido".
8. **"Misto" não é forma de pagamento.** São vários pagamentos (PIX, cartão, dinheiro) na mesma operação.
9. **Desconto pertence à conta**, podendo citar o pedido de origem. O pedido mostra a sua parte.

---

## 3. Decisões já fechadas

| Tema | Decisão |
|---|---|
| Versão | Evoluir a V1.1 (mesmo banco, histórico contínuo). A V1.1 fica congelada como backup. |
| Desconto do caixa | Sem limite de valor, motivo obrigatório; total por operador no painel e no fechamento. |
| O que o caixa enxerga | Tudo desde a abertura do caixa atual + contas vivas + pendentes. Sem histórico antigo nem financeiro. Travado no servidor. |
| Abrir/fechar | "Abrir o dia" = abre o caixa (dinheiro inicial) + estabelecimento ABERTO. "Encerrar o dia" = fechamento de caixa às cegas + FECHADO. Botão "Pausar/reabrir pedidos" no meio do dia. Caixa e admin podem; estado único em tempo real; cada mudança registrada. |
| Estabelecimento fechado | Não aceita conta ou pedido novo. Permite consultar e, com o caixa aberto, receber. |
| Estoque zerado | Alerta com 3 opções: corrigir estoque e vender / liberar venda (registra divergência) / cancelar. Estoque nunca fica negativo. Caixa e admin podem. |
| Despesa paga com a gaveta | Vira sangria automática no caixa. O caixa só lança esse tipo; o restante é do admin. |
| Tempo de preparo padrão | 15 min por produto; admin ajusta; após 4 semanas o sistema sugere com base na mediana real. |
| Cliente | Cadastro leve e opcional (nome + casa/telefone), com sugestão ao digitar e alerta de fiado. |
| Pedido do cliente pelo link | Pronto e **desligado**. Porta pública separada, só com o cardápio. Tailscale Funnel gratuito. Sempre passa pela confirmação do caixa. |
| Extras da 1ª entrega | Dividir/juntar contas e transferir pedido; visão de produção na cozinha. |
| Adiados | Cobrança de fiado pelo WhatsApp, troca de operador por PIN, crédito/débito com taxa, estoque de ingredientes, ficha técnica, multiempresa. |

---

## 4. Regressões obrigatórias (bugs vistos em versões anteriores)

Cada item vira teste automático. A entrega é bloqueada se algum falhar.

| # | Bug observado | Teste obrigatório |
|---|---|---|
| R1 | Nome do cliente sumia ("Cliente não informado") | Criar conta com nome e outra sem nome. Conferir o nome em: caixa, pedidos do dia, detalhe do pedido, conta, cozinha, alerta de pronto, contas a receber, seletor de conta, histórico, recebimento e fechamento. "Cliente não informado" só na conta sem nome. |
| R2 | "Receber" não fazia nada | Caixa e admin: abrir o recebimento, pagar R$ 60 PIX + R$ 40 dinheiro numa conta de R$ 100 → saldo 0. Pagar R$ 60 de R$ 100 → saldo R$ 40, depois quitar. Tudo atualiza sem F5. |
| R3 | Detalhe do pedido inexistente | Clicar em qualquer pedido abre o detalhe sem sair da tela, com todos os campos da seção 5.4. |
| R4 | Busca perdia o cursor | Digitar "F-i-l-é" rápido, apagar, colar e combinar com filtro de categoria. O cursor e o foco permanecem. "file" também encontra "Filé". |
| R5 | Status em inglês | Varredura automática da interface renderizada: nenhum código técnico visível. |
| R6 | Admin e caixa com estados diferentes | Caixa abre → admin vê aberto; admin fecha → caixa vê fechado, em tempo real. |
| R7 | Tela piscando ou perdendo filtro ao atualizar | Com filtro digitado e rolagem no meio da lista, chega um evento em tempo real: filtro, rolagem, foco e formulário permanecem. |

---

## 5. Escopo por módulo (com critério de aceite)

### 5.1 Caixa
- Busca instantânea que ignora acentos e maiúsculas; categorias; mais vendidos primeiro; atalhos de teclado (/ busca, Enter adiciona).
- Carrinho: + / −, remover, observação por item e por pedido, **limpar pedido**, cliente, tipo de consumo, total em destaque.
- **Item "Outro / Adicional"**: descrição obrigatória + valor + "vai para a cozinha?". No histórico aparece a descrição ("Queijo extra — R$ 5,00"), nunca só "Outro".
- **Pedidos do dia**: lista desde a abertura do caixa, com nº, cliente, tipo, status, hora, total e situação (pago/pendente); filtros e busca.
- **Alerta de pronto** visual e sonoro, com botão **silenciar/ativar som**.

### 5.2 Pedido
- **Tipo de consumo obrigatório**: 🍽️ Comer no local (padrão) / 🥡 Para viagem. Aparece no pedido, na cozinha, no detalhe e no histórico. Pode ser alterado até o pedido ficar pronto (auditado).
- Complemento sempre como novo pedido na mesma conta.
- Reduzir a quantidade de um item já enviado = cancelamento parcial com motivo.
- Cancelamento com motivo; se o item já estava em preparo ou foi entregue, fica marcado como perda.

### 5.3 Cozinha
- Novo → Em preparo → Pronto; o pedido fica pronto como um todo (todos os itens de cozinha).
- Cartão com: nº do pedido, "CONTA #" ou "COMPLEMENTO DA CONTA #", cliente/observação, **tipo de consumo em destaque**, itens, opções, observações, horário e tempo decorrido.
- **Cores pelo tempo padrão do pedido** (maior tempo padrão entre os itens): verde no prazo, amarelo acima do padrão, vermelho acima de 1,5× o padrão.
- **Visão de produção**: soma por produto de tudo que está na fila ("6× Espeto de frango").
- Aviso de cancelamento com "OK, vi"; botão "Problema"; admin opera a mesma tela.
- Funciona muito bem em celular e tablet; tela sempre acesa (Fully Kiosk).

### 5.4 Detalhe do pedido (modal, sem sair da tela)
Nº, cliente, data/hora, tipo de consumo, itens, quantidades, opções, adicionais/"Outro", observações, subtotal do pedido, parte do desconto, total, status, situação (pago/parcial/pendente), pagamentos da conta, saldo e conta vinculada (com link).
**Linha do tempo:** lançado → enviado → iniciou → pronto → entregue, com quem fez cada etapa.
**Admin vê também:** auditoria do pedido e correções de horário.

### 5.5 Contas e pagamentos
- Total / pago / saldo sempre visíveis.
- **Situação por pedido** calculada na ordem dos pedidos (o primeiro pagamento quita o primeiro pedido); não altera valores.
- Formas: PIX, cartão, dinheiro (com troco); vários pagamentos na mesma operação; parcial; "Receber e encerrar" ou "Só receber".
- **Dividir por N pessoas** no recebimento.
- **Juntar contas** (a conta de origem fica "Juntada à conta #X", sem contar como cancelamento).
- **Transferir pedido** para outra conta.
- **Pendente (fiado)**: exige nome + casa/telefone; recebimento posterior entra no caixa do dia em que foi pago.
- Cada pagamento registra valor, forma, usuário, data/hora e conta.

### 5.6 Clientes
- Nome e observação livres (nome, casa, "camisa vermelha", "perto da piscina"); nunca exigir mesa.
- Cadastro leve opcional: ao digitar, sugere o cliente conhecido e **avisa pendência** ("Casa K11 tem R$ 80 pendentes desde 12/10").

### 5.7 Cardápio, produtos e bebidas
- Categorias iniciais: Petiscos, Espetos, Pratos, Bebidas, **Outros**. Criar, renomear, desativar, reordenar, **excluir se nunca teve produto**, mover produtos.
- Produto: nome, categoria, descrição, foto, preço, **custo estimado (opcional)**, **controla estoque?**, **estoque**, **alerta de estoque baixo**, **vai para a cozinha?**, **tempo de preparo**, disponível, ativo.
- Produto ativo exige preço maior que zero.
- **Bebidas com preço real (27/09):** Refrigerantes R$ 6 (Coca-Cola, Coca Zero, Guaraná, Fanta Laranja, Sprite); Limoneto R$ 8; Powerade R$ 8; Monster R$ 14 (um produto por sabor); Heineken, Corona e Baden Baden R$ 14; Chope 300 ml R$ 7 e 500 ml R$ 10; Chope IPA 300 ml R$ 10 e 500 ml R$ 15 (chope sem controle de estoque); Água de coco caixinha R$ 5; Suco Kapo R$ 5; Suco lata Del Valle R$ 8; Água sem gás R$ 4; Água com gás R$ 5.
- **Drinks que vão para a COZINHA (têm preparo):** Caipirinha R$ 20 e Caipirosca R$ 25, com a opção obrigatória de sabor **Limão / Morango** (o admin pode adicionar sabores; sem estoque); Cozumel com chope R$ 15 (sem estoque); **Cozumel com cerveja R$ 20, com escolha obrigatória da cerveja (Heineken / Corona / Baden Baden), baixando 1 unidade do estoque da cerveja escolhida**; Preparo de Cozumel R$ 7.
- **Doses servidas pelo caixa (sem preparo):** Campari dose R$ 18; Whisky Red dose R$ 20.
- **Hambúrguer:** R$ 25, com a opção "+ batata frita" (+R$ 5 = R$ 30).
- **Monster:** cadastrar os 15 sabores vendidos no Brasil (Green, Green Zero Açúcar, Absolutely Zero, The Doctor, Ultra, Ultra Peachy Keen, Ultra Violet, Ultra Watermelon, Ultra Fiesta Mango, Ultra Strawberry Dreams, Khaotic, Mango Loco, Rio Punch, Pacific Punch, Pipeline Punch), R$ 14, **inativos**; o admin ativa os que tiver. Red Bull não entra (não está na lista de preços); o admin cadastra se passar a vender.
- **Refrigerantes confirmados:** Coca-Cola, Coca Zero, Guaraná, Fanta Laranja, Sprite.
- O cardápio de comidas atual é mantido como está (espeto com farofa como opção +R$ 5; strogonoff com escolha de batata).

### 5.8 Estoque simples
- Só para produtos com "controla estoque = sim" (foco: bebidas em lata e garrafa).
- Baixa na **confirmação** do pedido (nunca no carrinho).
- **Opção que consome produto de estoque:** uma opção pode apontar para um produto controlado (ex.: "Heineken" dentro do Cozumel com cerveja). Ao vender, baixa 1 unidade desse produto, com as mesmas regras de alerta, divergência e devolução. Devolução no cancelamento quando o item não foi entregue (o caixa confirma).
- Estoque zerado: alerta com as 3 opções da seção 3. "Liberar venda" registra divergência (produto, estoque registrado, quantidade vendida, usuário, data/hora, motivo).
- Entrada/reposição e ajuste por contagem, sempre com motivo; histórico completo por produto; lista de divergências e de estoque baixo para o admin.
- Sem estoque negativo, nunca.

### 5.9 Tempo de preparo
- Medidas por pedido: **fila** (enviado → iniciou), **preparo** (iniciou → pronto), **cozinha** (enviado → pronto), **balcão** (pronto → entregue) e **total do cliente** (lançado → entregue).
- **Previsão para o caixa**: "fica pronto por volta de 19:52", considerando o tempo padrão e a fila atual.
- **Tempo suspeito** (acima de 3× o padrão, ou pedido esquecido): marcado e fora das médias até ser corrigido.
- **Correção de horário** pelo admin, com motivo; o original fica guardado.
- Estatísticas por **mediana**. "Já está pronto" sem ter iniciado não conta como tempo de preparo.
- Após 4 semanas: sugestão de tempo padrão por produto, que o admin aprova.

### 5.10 Financeiro e despesas (admin)
- Por período: **vendas brutas**, descontos, **faturamento**, **recebido** (por forma), **a receber**, **custo estimado dos produtos**, **lucro bruto estimado**, **despesas**, **resultado operacional estimado**. Nunca usar "lucro líquido".
- O custo fica **congelado no item vendido** (histórico). Ao cadastrar um custo pela primeira vez, o admin pode aplicá-lo às vendas anteriores sem custo.
- Mostra quanto do faturamento tem custo informado ("custo informado para 72% das vendas").
- **Análise por produto**: preço, custo, margem unitária, quantidade, receita, custo total e margem total.
- **Despesas**: descrição, categoria, valor, data, observação, "paga com dinheiro do caixa?"; cancelar com motivo, nunca apagar. Categorias iniciais: Funcionários, Combustível, Energia, Água, Taxas, Compras, Limpeza, Manutenção, Embalagens, Entrega, Comunicação, Outros (editáveis).
- O resultado operacional usa o **mês** como referência principal (salário lançado num dia não pode transformar esse dia em prejuízo).

### 5.11 Dashboard e histórico
- Períodos: hoje, ontem, semana, mês, personalizado e todo o histórico.
- Vendas, recebido, a receber, ticket médio, pedidos, itens vendidos, mais vendidos, **horários de pico**, cancelamentos e perdas, descontos por operador, estoque baixo, custo, margem, despesas, resultado, tempos de cozinha.
- Gráfico só onde ajuda (horário de pico). Sem gráficos decorativos.
- **Indicador do teto do MEI:** ligado ou desligado nas configurações; começa **desligado** até o contador confirmar o enquadramento. O valor do teto é editável.
- Histórico com filtros: data/período, cliente, nº do pedido/conta, status, forma de pagamento, usuário e produto.
- Aviso no painel se o último backup falhou ou tem mais de 2 dias.

### 5.12 ONE UP Insights — painel de inteligência operacional
**Objetivo:** responder "o que mudou, é normal?, o que merece atenção, o que cresce/cai, onde está o movimento" em poucos segundos. Métrica não é insight: todo insight compara com uma referência válida.

**Maturidade (dias com vendas, excluindo dias fechados/atípicos):**
- **Nível 1 (<7 dias):** só indicadores descritivos + "Há dados de N dias. Ainda não há histórico suficiente para identificar padrões."
- **Nível 2 (7–27):** comparações simples (7d × 7d anteriores; hoje × média dos dias anteriores no mesmo horário), mais vendidos, horários, formas de pagamento. Sem conclusões fortes.
- **Nível 3 (28–55):** períodos equivalentes (mesmo dia da semana), tendências, produtos em alta/queda, mix de categorias, ticket, anomalias, dia da semana.
- **Nível 4 (56+):** o mesmo, com confiança maior e detecção de mudanças persistentes.

**Regras de geração:**
- Referência sempre explícita ("comparado com a média das últimas 4 sextas até as 20h").
- Todo card traz valor atual, referência, diferença absoluta, diferença %, período e rótulo DADO / ESTIMATIVA / INSIGHT / RECOMENDAÇÃO.
- Relevância considera % **e** valor absoluto **e** volume (amostra mínima) **e** variabilidade histórica (desvio pelo padrão do mesmo dia da semana). Uma variação de 100% com 2 vendas nunca vira insight.
- Confiança interna ALTA / MÉDIA / BAIXA; BAIXA é descartada.
- Pontuação por magnitude × impacto em R$ × confiança × novidade; o painel mostra **3 a 5**, "Ver todos" mostra o resto relevante.
- **Sem repetição:** registro dos insights exibidos (tipo, assunto, faixa de magnitude); o mesmo insight sem mudança relevante não volta ao topo.
- **Nunca inventar causa:** coincidência é descrita como "no mesmo período"; quando a causa não é determinável, o card diz isso.
- Números 100% determinísticos (SQL + estatística simples); **nenhuma IA gera números**. Texto por modelos fixos.
- Tipos: OPORTUNIDADE, TENDÊNCIA, ANOMALIA, ALERTA, DESEMPENHO, PRODUTO, OPERACIONAL, FINANCEIRO (ícone por tipo).

**Catálogo:**
- **Do dia:** ritmo × mesmo dia da semana no mesmo horário; projeção de fechamento em faixa (ESTIMATIVA); destaque do dia (participação de produto/categoria); rupturas (o que acabou e quando); cozinha (tempo acima do padrão); controle (descontos, cancelamentos, divergências de estoque acima do normal, sem acusar ninguém); estoque baixo; contas a receber antigas.
- **Período:** faturamento 7d/28d; ticket médio (com atribuição a categoria só quando o dado mostra); produtos em alta e em queda (volume mínimo e consistência em múltiplas semanas); mix de categorias; formas de pagamento; taxa de desconto; taxa de cancelamento; concentração por horário; participação por dia da semana; anomalias diárias (desvio do padrão do mesmo dia da semana); tempo de preparo; prazo do fiado; margem (quando houver custos).

**Interface:** bloco "Insights do período" no dashboard (3 a 5 cards) + tela "Insights" com todos, nível de maturidade, dias excluídos e detalhe de cada insight (período, comparação, gráfico simples, dados usados, metodologia em linguagem simples). Zero dados: "Assim que houver dados suficientes, seus primeiros insights aparecerão aqui."

**Desempenho e segurança:** cálculo agregado no banco, cache curto invalidado por novos pedidos/pagamentos; só o admin acessa (cozinha e cliente nunca).

**Testes:** zero vendas, poucos dias, 7/28/56 dias, crescimento, queda, anomalia, empate, produto com poucas vendas, variação grande com baixo volume × alto volume, sem histórico, período incompleto.

### 5.13 Auditoria e segurança
- Registrar com **usuário + perfil + data/hora + o quê + motivo**: login, criação, edição, cancelamento, desconto, preço, custo, estoque, pagamento, estorno, abertura/fechamento (do dia e do estabelecimento), configurações, correção de horário, junção/transferência de contas.
- Permissões verificadas no servidor em todas as rotas; senhas com hash; sessões em cookie httpOnly; validação de toda entrada.
- Admin tem acesso total e usa as mesmas telas de caixa e cozinha, sem trocar de login.

### 5.14 Pedido pelo cliente (pronto, desligado)
- Cardápio público numa **porta separada**, que expõe só o cardápio e a API pública. Caixa e admin nunca ficam acessíveis pela internet.
- Nome e localização opcionais; retirar no balcão, consumir no local ou entrega (só com o delivery aberto).
- Sempre entra como "aguardando confirmação" no caixa.
- Documentar a ativação via Tailscale Funnel.

### 5.15 Visual e identidade
- Marca principal "HAPPY ALPHA GOURMET R2"; "Desenvolvido por ONE UP" discreto, com a logo oficial quando fornecida (nunca recriar marcas).
- Login premium. Logo do Happy Alpha em alta resolução quando fornecida.
- Visual escuro, verde e dourado, sem neon, gradiente gratuito ou cara de template.
- Caixa prioriza velocidade, cozinha prioriza leitura, admin prioriza gestão. Desktop, tablet e celular.

### 5.16 Preparação comercial (sem implementar multiempresa)
- Nenhum texto "Happy Alpha" fixo no código: nome, logo, cores e cardápio vêm das configurações. É isso que permite instalar em outro restaurante.
- Instalação repetível (instalador + modo demonstração); versão do sistema visível no painel.
- Dados de clientes (nome e telefone) tratados com cuidado (LGPD): usados só para a operação.

### 5.17 Adições do prompt mestre de atualização (27/09)
- **Destino por produto:** COZINHA ou CAIXA ("vai para a cozinha?"). Caipirinha, caipirosca e cozumel **vão para a cozinha**. Sem destino "bar" separado: não há necessidade operacional.
- **Cozinha mostra só o nome do produto** (ex.: "Jantinha" + o espeto escolhido). Qualquer coisa a mais ou a menos vai na observação. A composição fica apenas na descrição do cardápio.
- **Campos opcionais do cliente:** mesa, casa/apto, telefone e observação. Nenhum é obrigatório.
- **Login:** tela dividida (40% formulário / 60% visual; uma coluna no celular); "Bem-vindo ao Happy Alpha / Acesse o sistema de gestão"; mostrar/ocultar senha; "lembrar acesso"; "Esqueci minha senha" orienta a pedir a redefinição ao admin (sem e-mail, porque o sistema é local); mensagem de erro genérica.
- **Logout auditado**, junto com o login.
- **Anti-duplicidade:** botões travam enquanto enviam; criação de conta, pedido e pagamento com **chave de idempotência** (duplo clique ou reenvio por rede lenta não duplica nada); atualizações concorrentes protegidas por transação e trava de linha.
- **Erros de conexão:** tempo limite nas requisições, mensagem clara ("não foi salvo, tente de novo") e nenhuma tela fingindo que salvou.
- **Imagens:** placeholder elegante quando o produto não tiver foto; nunca imagem quebrada.
- **Desconto:** registra também o total antes e depois. **Cancelamento:** registra o status anterior e o posterior.
- **Dashboard:** vendas por categoria. **Histórico:** filtro por origem (balcão / QR / delivery).
- **Modo TV na cozinha:** layout para monitor grande, legível à distância.
- **Preparado para a internet** (sem mudar a instalação local): configuração de CORS/origem, segredos só no .env e guia "como colocar na internet" (hospedagem + domínio + HTTPS).
- **Revisão de segurança final:** checklist de escalada de privilégio, manipulação de IDs, XSS, SQL injection, sessão, CORS e vazamento de dados, com correção do que aparecer.
- **Testes extras:** tentativa de pedido e pagamento duplicados, acesso não autorizado pela API, erro/queda de API.
- **Entrega:** inclui como rodar localmente, fazer build, colocar na internet, variáveis de ambiente e credenciais demo.

### 5.18 Reabertura/adição de itens — cozinha recebe só a diferença (27/09)
- Cada adição na conta é um **novo lote** (pedido/complemento) com seus próprios itens, status de produção, horários e usuário. Lotes anteriores nunca são reenviados nem alterados.
- **Aumentar quantidade** de um item já enviado ("+1" / "repetir" na conta) cria um lote só com a diferença (ex.: 2 prontos → +1 = cozinha recebe 1).
- Cozinha: cartão do lote novo mostra **🆕 NOVO ITEM** e, abaixo, **✓ itens anteriores da conta com status** (só leitura).
- Estoque baixa só o lote novo; pagamentos antigos permanecem; saldo recalculado.
- Histórico: quem adicionou, quando, se foi para a cozinha, quando ficou pronto.
- Testes obrigatórios 1–5 do prompt de reabertura (2 hambúrgueres prontos + batata; + batata + coca; 2→3; 2→4 batatas; conta paga + novo item).

---

## 6. Modelo de dados (resumo)

- User(perfil) · Customer (opcional)
- Category → Product (preço, custo atual, estoque, vai para a cozinha, tempo de preparo) → ProductCost (histórico de custo) · StockMovement (entrada, venda, cancelamento, ajuste, divergência)
- Account (cliente, observação, contato, status; juntada em) → Order (tipo de consumo, status, horários, tempo padrão) → OrderItem (nome, preço e custo congelados; "Outro")
- Account → Payment (forma, valor, caixa, estorno) · Discount · Cancellation
- CashRegister → CashMovement (sangria/suprimento) ← Expense (paga com a gaveta)
- RestaurantSettings (estado aberto/fechado) · StatusEvent (linha do tempo) · ExcludedDay · OrderTimeCorrection · AuditLog (usuário + perfil)

**Regras:**
- Order ≠ Account ≠ Payment.
- "Pendente" é status da conta, não pagamento.
- "Misto" = vários pagamentos.
- Custo e preço congelados no item vendido.

---

## 7. Fora do escopo agora

WhatsApp automático, QR público ativo, app de loja, multiempresa, filiais, fiscal/NFC-e, IA generativa, marketplace de delivery, estoque de ingredientes, ficha técnica, compras/fornecedores, contas a pagar, troca de operador por PIN, taxa da maquininha, cobrança de fiado pelo WhatsApp.

---

## 8. Pendências do proprietário (não bloqueiam o desenvolvimento)

1. Logo Happy Alpha em alta resolução (logo ONE UP recebida).
3. Custos estimados dos produtos.
4. Marcar quais sabores de Monster estão à venda (ativar no painel).
5. Confirmar com o contador se é MEI (para ligar o indicador).

---

## 9. Ordem de execução (cada fase fecha com testes passando)

1. **Dados e regras:** migrações (tipo de consumo, "Outro", estoque, custos, despesas, clientes, estado do dia, correções de horário, perfil na auditoria), permissões do caixa por período, bebidas em revisão, categoria Outros.
2. **Operação:** caixa (Outro, tipo, limpar, pedidos do dia, silenciar), estoque na venda com as 3 opções, detalhe do pedido, situação por pedido, dividir/juntar/transferir, cliente com alerta, abrir/encerrar o dia, fechamento às cegas, cozinha (tipo, cores, produção).
3. **Tempo de preparo:** medidas, previsão, suspeitos, correção, sugestão.
4. **Gestão:** financeiro, despesas, análise por produto, dashboard por período, histórico com filtros, aviso de backup.
5. **Insights:** do dia; fim de semana e 4 semanas com "dados insuficientes".
6. **Visual e canal público:** login R2, identidade configurável, porta pública separada.
7. **Verificação final:** todos os testes (seção 10), revisão visual em celular, tablet e desktop, pacote de instalação e documentação.

---

## 10. Definição de pronto — testes obrigatórios

**Automáticos, todos precisam passar:**
- Os 68 testes da V1.1.
- R1 a R7 (seção 4).
- T1: pedido com cliente "Lucas" + Jantinha → caixa, cozinha, conta, histórico.
- T2: pedido sem cliente → "Cliente não informado" somente aqui.
- T3: Jantinha + Coca → Jantinha na cozinha; ambas na conta.
- T4: pedido com vários itens de cozinha → pronto só como um todo.
- T5 e T6: parcial 60/100; misto 60 PIX + 40 dinheiro → saldo 0.
- T7: pago e depois novo consumo → pedido 1 intacto e "pago", pedido 2 "pendente", conta com o saldo certo.
- T8 e T9: cancelamento e desconto com motivo, usuário e horário.
- T10: estoque 1 → vende → 0 → nova venda mostra alerta → corrigir e vender / liberar (divergência auditada) / cancelar; nunca negativo.
- T11 e T12: caixa abre → admin vê; admin fecha → caixa vê; estabelecimento fechado recusa pedido novo.
- T13 e T14: cozinha recebe sem F5; pronto gera alerta no caixa; o som pode ser silenciado.
- T15: filtro "FILÉ" digitado letra a letra; "file" encontra "Filé".
- T16: detalhe do pedido completo.
- T17: "Outro" com descrição aparece no histórico com a descrição.
- T18: tipo de consumo "Para viagem" aparece na cozinha e no detalhe.
- T19: despesa paga com a gaveta vira sangria e o fechamento continua batendo.
- T20: venda + custo + despesa → lucro bruto e resultado corretos no período.
- T21: alteração de preço e de custo não muda vendas antigas.
- T22: caixa não acessa financeiro, usuários nem dias anteriores (verificado na API).
- T23: juntar contas e transferir pedido mantêm totais e pagamentos corretos.
- T24: tempo suspeito fica fora da média; a correção do admin fica auditada.
- T25: insight sem base mostra "Dados insuficientes".
- T26: admin opera caixa e cozinha, e a auditoria registra perfil ADMIN.
- T27: backup + restauração.

**Visuais (navegador real):** caixa, cozinha, admin e cardápio público em 390 px, 768 px e 1366 px, sem rolagem horizontal, sem texto escuro sobre fundo escuro, sem código em inglês.

---

## 11. Formato da entrega

1. Resumo em linguagem simples: o que mudou e o que isso resolve na operação.
2. Tabela requisito → status (✅ / 🟡 / 🔴 / 🚀) → evidência (teste que comprova).
3. Resultado dos testes (quantos passaram; nenhuma falha tolerada).
4. Pendências e riscos conhecidos, sem esconder nada.
5. Pacote (.zip) + instruções de instalação/atualização a partir da V1.1, sem perder dados.
6. Resposta objetiva: "Pode operar no restaurante amanhã?" Se não, o que impede.
