# PROMPT DE EXECUÇÃO — Happy Alpha Gourmet R3 · LEVA 2 (o painel completo do ADMINISTRADOR)

> STATUS: CONGELADO (v3, com o Relatório Mensal ONE UP — Módulo I). Só executar depois de: (1) o Lucas dar o ok e (2) a Leva 1 ter rodado ao menos 2 semanas no restaurante, com o feedback incorporado.
> Pré-requisito técnico: Leva 1 concluída (perfis, estoque com histórico imutável, financeiro do Dono em números, contas a receber genérica com `origem`, horários dos pedidos gravados).

## Papel
Você é meu sócio e, nesta leva, também **especialista em avaliação de restaurantes, finanças de food service e CEO/consultor de gestão**. Pense e escreva como quem é pago para dizer ao dono onde está o dinheiro e o gargalo. Não tente me agradar: se um número não sustenta a conclusão, diga. Eu (Lucas) NÃO sou programador: explique em português simples e entregue pronto para usar.

## Contexto
Mesmo projeto da Leva 1 (`/home/claude/happy-alpha`). O restaurante é do **Rafael (DONO)**; **eu, Lucas / ONE UP, sou o ADMINISTRADOR**. Começa offline; tudo compatível com o modo online (uma instância por restaurante).

## REGRA-MÃE
**Tudo o que interpreta, aconselha ou cobra é SÓ do ADMINISTRADOR**, e aqui está a lista fechada do que o Dono NÃO vê, nem em resumo:
- todo "O que os números dizem" (insights por regra);
- **engenharia de cardápio**;
- **recuperação de vendas (CRM de cobrança)**;
- aba IA, diagnóstico, nota do restaurante, radar de alertas, plano de ação;
- financeiro avançado (fluxo diário, comparativos, projeções, cenários "e se", curva ABC);
- análises de estoque (giro, ruptura, capital parado), de equipe, de clientes e de fiado.

Isso vale para tela, botão, rota, socket e campo de resposta de API. Eu levo o resultado ao Rafael por fora (PDF e conversa). O Dono continua com a versão enxuta da Leva 1: números, estoque objetivo e lista genérica de "A receber". Teste automatizado que falha se qualquer perfil diferente de ADMINISTRADOR receber qualquer um dos itens acima. O modo "ver como" Dono mostra exatamente a visão limitada dele.

## Padrão de todo insight (obrigatório)
Cada achado mostra: **(1) a frase simples, (2) o número que a sustenta, (3) a amostra ("312 pedidos em 30 dias"), (4) a confiança (baixa/média/alta), (5) a ação sugerida e (6) o impacto estimado em R$ quando houver, sempre com a premissa visível e marcado como estimativa.** O insight é calculado por REGRA em código (a IA só melhora a redação, no Módulo F). Abaixo da amostra mínima ele não aparece. Metas e limiares são configuráveis por restaurante; qualquer comparação com "média do mercado" só entra com fonte citada, senão fica de fora.

## Método
Igual à Leva 1: ler o código antes; módulo por módulo (código + migração aditiva + teste); 124 checks e2e + novos sem regressão; no final zip, guia, CHANGELOG e resumo curto. Reaproveitar as consultas da Leva 1 em vez de duplicar.

---

## MÓDULO A — Financeiro COMPLETO do Administrador
Superconjunto do que o Dono vê. Abas: **Resumo · Despesas · Fluxo · Produtos · Ano · Metas e projeção**, mesmo filtro de período, mais "Personalizado". Tudo com "O que os números dizem" (3 a 5 achados por aba) e botão "Exportar CSV" em cada tabela.
- **Resumo:** lucro, margem, comparação com o período anterior e com o mesmo período do ano anterior (quando existir); **ponto de equilíbrio** (despesas ÷ (1 − custo% das vendas líquidas), "indisponível" sem custo suficiente) e dia em que foi coberto; melhor e pior dia da semana; descontos acima do normal; taxas estimadas de cartão/PIX e impostos (campos configuráveis) para aproximar do lucro líquido.
- **Despesas:** por categoria com variação vs mês anterior, comparativo de 12 meses (R$ e % das vendas, clique filtra), categoria que subiu mais de 20%, peso da folha e do fornecedor sobre as vendas, despesas fixas × variáveis, previsão das próximas.
- **Fluxo:** entradas por dia e por forma de pagamento, saldo acumulado, fiado recebido, concentração no fim de semana, dia mais fraco.
- **Produtos:** etiquetas **Saudável** (margem ≥ meta, padrão 60%), **Atenção** (45–60%), **Margem baixa** (<45%), **Sem custo**; rankings lado a lado **"O que mais VENDE"** e **"O que mais LUCRA"**; **curva ABC** por faturamento e por lucro (quantos produtos fazem 80% do dinheiro); margem por categoria; "vende muito com margem baixa: subir R$ Y leva a margem para Z%".
- **Ano:** 12 meses lado a lado (vendido, lucro, margem, ticket, despesas), sazonalidade, mês a mês vs ano anterior, melhor e pior mês, tendência.
- **Metas e projeção:** meta mensal configurável (vendas e lucro) com progresso; **projeção do fechamento do mês** pelo ritmo dos dias já vendidos (mostrar a conta); simulador de cenários "e se" (preço de um produto ou categoria +X%, custo −Y%, despesa −Z%, mantendo o volume), sempre com a premissa escrita e marcado como estimativa.
- Regras visuais (skill dataviz): tokens do sistema, uma escala, sem eixo duplo, legenda com ≥2 séries, tooltip, tabela alternativa, paleta validada pelo script, renderizar e olhar.

## MÓDULO B — Engenharia de cardápio (SÓ Administrador)
- **Matriz popularidade × margem:** Estrela, Burro de carga, Quebra-cabeça, Abacaxi. Popular = vende ≥ 70% ÷ nº de itens do total; margem boa = meta configurável. Produto sem custo fica de fora e aparece como pendência.
- Cada quadrante traz a ação: manter e destacar; subir preço ou baixar custo; divulgar, combo, sugerir no caixa; rever receita ou tirar.
- **Simulador de preço** por produto (impacto em margem e lucro, com premissa e estimativa).
- **Combos e venda adicional:** produtos que aparecem juntos no mesmo pedido (contagem simples de pares, com amostra mínima), sugestão de combo e de "quem pede X e não pede Y".
- Itens candidatos a sair, a promover e a reprecificar, com a evidência.

## MÓDULO C — Estoque: visão do consultor (SÓ Administrador)
- **Cobertura em dias** por produto contra a meta, **ruptura** (dias zerado e vendas perdidas estimadas, com premissa), **giro**, **capital parado** (cobertura muito acima da meta).
- **Divergências recorrentes** (produto vendido sem estoque), **perdas e quebras** a partir dos ajustes por motivo, **variação do custo de compra** por produto e por fornecedor ("Suco Kapo +24% em 60 dias").
- **Compra sugerida otimizada** (conta mostrada) e alerta de item com estoque parado ou vencendo cobertura.
- Quando houver ficha técnica (fase posterior): CMV teórico × real. Fora agora.

## MÓDULO D — Operação e equipe (SÓ Administrador)
- **Monitor de tempo de preparo:** tempo padrão é META, nunca muda sozinho; medir o real (fila, confirmação do caixa, preparo, balcão, total) por medianas com limpeza de outliers; estimativa por tipo de pedido com fallback (mesmos itens → mix de categorias → nº de itens → geral; mínimo 10 pedidos); acerto da estimativa; sugestões por produto (≥10 amostras e ≥3 min de diferença) que eu aprovo ou ignoro. Aviso honesto: depende de a cozinha apertar Iniciar/Pronto.
- **Mapa de movimento e demora:** duas grades dia da semana × hora (America/Sao_Paulo), movimento (nº de pedidos) e demora (mediana; alternável entre fila, confirmação, preparo, balcão), filtros por tipo (balcão, no local, entrega, online) e período (30 dias, 90 dias, Ano). Célula com <5 pedidos em cinza "poucos dados". Uma cor de escala; demora acima da meta em cor de alerta. Pico de cada dia, hora mais lenta e **capacidade estimada** da cozinha.
- **Controle interno por turno/função (sem citar nome, salvo se o Dono ativar):** cancelamentos e recusas por motivo, descontos por turno e tipo, diferença de caixa por turno e recorrência, pedidos esquecidos. Texto de apoio à operação, nunca punição.

## MÓDULO E — Clientes e fiado (SÓ Administrador)
- **Clientes (agregado por WhatsApp, sem enviar o número à IA):** novos × recorrentes, frequência e intervalo médio entre pedidos, ticket por cliente, **clientes que sumiram** (lista só de quem aceitou receber ofertas), base para reativação.
- **Fiado:** total a receber, vencido, prazo médio de recebimento, % de inadimplência, concentração (quantos clientes fazem 80% do fiado), ranking de devedores e risco por histórico.

## MÓDULO F — Aba "IA": diagnóstico completo (SÓ Administrador)
**Arquitetura obrigatória:**
1. Fatos calculados por código, texto escrito pela IA. A IA recebe SÓ um JSON de fatos agregados (todos os módulos A a E) e não consulta o banco.
2. Nenhum dado pessoal sai do sistema: sem nome, telefone, endereço ou observações de cliente ou de funcionário.
3. **Anti-alucinação:** toda frase com número usa número presente nos fatos; validar por código (extrair números do texto e conferir com o pacote); descartar e regerar o que não bater. Estimativas mostram a premissa.
4. Dados mínimos: ≥14 dias e ≥100 pedidos para o geral; ≥10 amostras por produto e por hora. Sem amostra: "ainda sem dados suficientes".
5. **Modo sem IA:** sem internet ou chave, a aba funciona com os mesmos fatos e textos por regra.
6. Custo sob controle: chamada pelo servidor (chave nunca no navegador); 1 diagnóstico automático por semana + até 3 manuais por dia; cache; registrar tokens e custo; modelo econômico por padrão, configurável; preparar gateway central para o online.
7. Geração assíncrona ("gerando…"), nunca trava a operação.

**Confiança = quanto os dados sustentam a conclusão** (não a certeza da IA), calculada por código no diagnóstico e em cada insight: **Baixa** (<14 dias, <100 pedidos ou <50% com horários da cozinha), **Média** (14–60 dias, 100–500 pedidos, ≥50% com horários), **Alta** (>60 dias, >500 pedidos, ≥80% com horários). Mostrar o porquê e o que melhora a confiança. Limiares configuráveis.

**Conteúdo da aba:**
- Cabeçalho: data, período, confiança, "Gerar novo diagnóstico".
- **Nota do restaurante (0 a 100):** calculada por regra e transparente, com 6 pilares (Vendas e demanda · Margem e preço · Operação e tempo · Estoque · Caixa e controle · Fiado), cada um com nota, o número que a justifica e o que fazer para subir. É para mim e para o PDF; o Dono não vê.
- **Onde está o gargalo:** UM principal, com evidência em números e o dia/horário; classificar em atendimento/caixa, cozinha, estoque, margem/preço, fiado ou demanda.
- **As 5 prioridades** ranqueadas por impacto: o que acontece, o número que prova, impacto em R$/mês (premissa), esforço, ação, botão "Marcar como feito". Pelo menos uma olha o estoque quando os dados justificarem.
- **O que mais vende e o que mais lucra**, com a leitura de cada produto (manter, subir preço, reposicionar, combo, tirar).
- **O que está indo bem** (até 5, ver Módulo I). **Plano de 30 dias** (semana a semana). **Evolução** (comparar as prioridades marcadas como feitas). **Histórico** dos diagnósticos.
- Rodapé: "Sugestões de apoio à decisão baseadas nos dados. Não substituem contador." Fora agora: chat "pergunte à IA".

## MÓDULO G — Radar do Administrador
Painel de alertas por regra, para eu atender vários restaurantes sem abrir cada tela:
- **Alertas:** queda de vendas >X% vs média das últimas 4 semanas, margem caiu, categoria de despesa disparou, ruptura de item que vende bem, fiado vencido crescendo, diferença de caixa recorrente, cozinha sem apertar Iniciar/Pronto, backup externo atrasado.
- Cada alerta com gravidade, número que o sustenta e ação; posso marcar "visto" ou "silenciar por N dias".
- **Resumo semanal** do restaurante pronto para eu copiar e mandar por WhatsApp (texto curto, gerado por regra).

## MÓDULO H — Central de Serviços (produto vendável)
Painel do Administrador: restaurantes, licença, saúde (versão, backup e data do último backup externo, disco, erros), alertas do Radar, resumo do mês (recuperado, comissão, diagnósticos a finalizar). Cada serviço liga/desliga por restaurante (contrato).

**1. Recuperação de vendas (CRM de cobrança), 100% só do Administrador.** O Dono vê apenas a lista comum de "A receber": sem botão, sem status de recuperação, sem relatório no sistema.
- Entram as contas que a regra do contrato definir (ex.: vencidas há N dias) e que eu não marquei "não cobrar"; acesso mínimo ao devedor (nome, contato, valor, vencimento, origem). Cláusula de contrato e de dados (LGPD) obrigatória.
- **Funil:** Novo → Contatado → Sem resposta → Prometeu pagar (data) → Pago → Recuperado / Contestado / Perdido.
- **Ficha:** dados, linha do tempo (data, canal, resultado, quem), próximo lembrete, mensagem pronta e editável que abre `wa.me`, botões de resultado (Sem resposta · Vai pagar (data) · Pagou · Pediu parcelar · Contestou · Número errado · Não vai pagar), anexar comprovante.
- **Régua (valores PROVISÓRIOS, 100% configurável: passos, dias, canais, textos, limites):** D+1 lembrete gentil, D+3 reforço com chave Pix, D+7 ligação + WhatsApp, D+15 proposta de acordo, D+30 encerrar com relatório.
- **Lembretes:** sem resposta → a cada 3 dias, máx. 4 tentativas, depois pausa; prometeu → lembra no dia e no seguinte; promessa quebrada 2 vezes → ligação; contestou → pausa; número errado → pedir correção.
- **Guarda-corpos:** contatos só 8h–20h, seg–sáb; 1 contato/dia/conta; mensagem identifica o restaurante e oferece canal para contestar; nunca ameaçar nem expor; "não contatar" bloqueia para sempre; tudo registrado; **sem envio automático** (eu envio com um toque; o sistema agenda e lembra).
- **Comprovante:** foto/PDF/print na ficha (dado bancário: só Administrador, fora de listas e do PDF, opção de apagar após o fechamento do mês). O pagamento cai SEMPRE direto na conta/Pix do restaurante, nunca na minha.
- **Comissão:** a conta só vira "Recuperado" quando o Caixa/Dono der a **baixa** na conta a receber comum (Leva 1). Pagamento por Pix direto: eu anexo o comprovante e a conta fica "aguardando baixa"; sem baixa depois de N dias, o sistema me avisa para combinar com o Rafael por fora. Nunca gerar comissão sem baixa.
- **Percentual por contrato**, sobre o valor efetivamente recuperado, **por faixa de dias de atraso na entrada**. Sugestão inicial: ≥15 dias = 10%, ≥30 dias = 15%, ≥60 dias = 20%. O valor fechado com cada restaurante eu combino por fora e só registro no contrato.
- **Fila "Hoje"** (quem contatar, canal, atrasadas) e **relatório mensal** por restaurante (enviado, recuperado, em negociação, perdido, taxa de recuperação, tempo médio, comissão, líquido ao restaurante) em tela e PDF, só para mim.

**2. Diagnóstico mensal em PDF (só eu vejo e envio por fora). A estrutura oficial está no Módulo I; o que vem abaixo é o mínimo.** A IA gera o RASCUNHO (Módulo F); eu reviso (checklist: números conferidos, sugestões coerentes, tom), acrescento meu parecer e gero o **PDF com a marca ONE UP**. Estados: rascunho → em revisão → finalizado. O sistema **não publica nada para o Dono** e não tem botão "solicitar plano".
- Conteúdo: capa; resumo executivo; **nota do restaurante e 6 pilares**; indicadores do mês vs mês anterior e vs Ano; gráficos (vendas e lucro, despesas, margem por produto, mapa de movimento e demora); gargalo principal com evidências; 5 prioridades com impacto e premissas; **o que mais vende × o que mais lucra**; **engenharia de cardápio**; **capítulo de estoque** (cobertura, ruptura, capital parado, compra sugerida); clientes e fiado; **plano de 30 dias**; evolução das prioridades anteriores; confiança dos dados e metodologia; meu parecer. Sem dados pessoais de clientes.

**3. Contratos:** por restaurante, serviços ativos, valores (site, plataforma, diagnóstico) e percentuais da recuperação, plano (offline ou online) e custos de infraestrutura quando online, início e próxima cobrança. Texto padrão de contrato e cláusula LGPD revisados por advogado antes de vender (fora do código).

**4. Privacidade:** vejo dados de clientes só das contas delegadas e só com o interruptor de suporte/contrato ativo; tudo em auditoria visível ao Dono.

**5. Outros serviços (fase posterior, ligáveis por contrato):** reativação de clientes (só quem aceitou ofertas), campanhas para horários fracos, auditoria de taxas e compras, venda adicional a clientes fixos, comparação anônima entre restaurantes (só no online, com consentimento).

## MÓDULO I — Relatório Mensal ONE UP (o produto que eu vendo ao Dono)

**Por que existe:** o Rafael vê os NÚMEROS (Leva 1). O que eu vendo é a LEITURA: onde o dinheiro está escapando, o que mudou, o que fazer e quanto isso vale em R$. A escassez é o produto: nada deste módulo aparece para DONO, CAIXA ou COZINHA, nem como resumo, contador, "nota" ou aviso. Teste automatizado cobre isso.

### I.1 Biblioteca de detectores (a base da "análise absurda")
A qualidade do relatório vem da quantidade de regras que olham os dados, não da IA. Cada detector é código, com limiar configurável, amostra mínima e cálculo de impacto em R$/mês (premissa escrita). A IA só escolhe as palavras. Mínimo de detectores na entrega:

- **Vendas e demanda:** vendas vs mês anterior, vs média dos últimos 3 meses e vs mesmo mês do ano anterior; ticket médio caindo com volume subindo (ou o inverso); dia da semana fraco (< 60% da média); horas ociosas e horas saturadas; clientes novos × recorrentes; clientes que sumiram (sem pedido há 2× o intervalo habitual); peso do cardápio online; pedidos recusados por motivo.
- **Margem e preço:** produto de alto volume com margem abaixo da meta; custo de compra que subiu sem repasse no preço ("Suco Kapo: custo +24% em 60 dias, preço igual → −R$ X/mês"); produtos vendidos sem custo; dependência (poucos itens fazem 80% do lucro); itens Abacaxi e Quebra-cabeça (Módulo B); categoria com margem caindo; pares de produtos que viram combo.
- **Descontos, cancelamentos e controle:** descontos em % das vendas acima do normal, por turno e tipo; cancelamentos em R$ e depois de pronto; diferença de caixa recorrente; avulsos repetidos (virar produto) e avulsos sem custo.
- **Operação:** tempo de preparo acima da meta no pico; fila de confirmação no caixa; pedidos esquecidos; % de pedidos sem Iniciar/Pronto (baixa a confiança); capacidade estimada vs pico.
- **Estoque:** ruptura de item que vende bem (vendas perdidas estimadas); capital parado; perdas e quebras em R$ por motivo; divergências recorrentes; variação de custo por fornecedor.
- **Despesas:** categoria que subiu > 20%; despesa em % das vendas acima do limite; ponto de equilíbrio atingido cada vez mais tarde no mês.
- **Fiado:** vencido crescendo; prazo médio de recebimento; concentração; inadimplência.

### I.2 Estrutura fixa do relatório (sempre nesta ordem)
1. **Resumo executivo** (3 frases): como foi o mês, o maior problema, a maior oportunidade.
2. **Nota do restaurante 0–100 e os 6 pilares**, com a variação vs mês anterior (▲▼) e o que fazer para subir cada um.
3. **"Dinheiro na mesa"**: soma das oportunidades de lucro extra por mês, em R$, conservadora, sem contar duas vezes a mesma coisa, com a premissa. É o número que abre a conversa com o Dono.
4. **Os 5 gargalos do mês**: onde o lucro está sendo perdido ou travado AGORA. Cada um com causa, número que prova, amostra, confiança, impacto em R$/mês, ação e dono da ação. Ranqueados por impacto × confiança.
5. **Os 5 pontos do comparativo**: as 5 maiores mudanças vs mês anterior, vs média de 3 meses e vs mesmo mês do ano anterior (quando existir). Neutro: o que subiu e o que caiu, com o número.
6. **5 pontos positivos**: o que melhorou ou está acima da meta, com o número (serve para o Dono saber o que NÃO mexer).
7. **5 pontos negativos**: o que piorou ou está abaixo da meta e ainda não virou gargalo (sinal de alerta).
8. **O que mais vende × o que mais lucra** e a **engenharia de cardápio** (Módulo B), com a decisão para cada item.
9. **Capítulo de estoque** (Módulo C) e **clientes e fiado** (Módulo E).
10. **Plano de ação de 30 dias**: no máximo 5 ações, semana a semana, cada uma com meta mensurável ("subir o X de R$ 18 para R$ 20; esperado +R$ 340/mês").
11. **Resultado do plano do mês passado**: para cada ação, feito / não feito e o efeito medido ("preço do X subiu 11%, vendas do X caíram 3%, lucro do X +R$ 290"). É o que prova o valor do serviço e segura a renovação.
12. **Previsão do próximo mês** (pelo ritmo e sazonalidade, com a conta) e **confiança dos dados e metodologia**.
13. **Meu parecer** (texto livre do Lucas).

### I.3 Regras de honestidade (inegociáveis)
- **Um fato aparece em uma seção só.** Gargalo não se repete como negativo; o comparativo não repete o gargalo. Deduplicação por código.
- **"5" é o máximo, não a meta.** Se só 3 achados passam na amostra mínima e na confiança, o relatório mostra 3 e diz por quê. Nunca inventar ou esticar para completar a lista.
- Toda estimativa em R$ mostra a premissa e é marcada como estimativa. Números validados contra o pacote de fatos (anti-alucinação do Módulo F).
- Comparativo com meses sem dados: "sem dados", nunca zero. Nos primeiros meses, o relatório declara a confiança baixa em vez de fingir tendência.

### I.4 Entregáveis gerados a cada mês (só o Administrador vê)
- **PDF com a marca ONE UP** (fluxo rascunho → revisão → finalizado do Módulo H.2).
- **Resumo para WhatsApp** (10 linhas: nota, dinheiro na mesa, top 3 ações) para eu mandar antes da reunião.
- **Roteiro da reunião mensal** (1 página, só para mim): por onde começar, qual número mostrar primeiro, as 3 decisões que preciso tirar do Dono, objeções prováveis.
- **Acompanhamento:** as ações aprovadas pelo Dono entram numa lista minha com status; o sistema mede o efeito no mês seguinte automaticamente (item 11).

### I.5 Opcional, desligado por padrão (eu decido por restaurante)
Um cartão na tela do Dono só com "Seu relatório de <mês> está pronto — fale com seu consultor ONE UP", sem nenhum número, nota ou achado. Serve de lembrete e não entrega a análise.

## Fora de escopo agora
Chat com a IA, painel multi-instância completo, ficha técnica com CMV, NFC-e, publicação de site, migração para VPS. Apenas não impedir.

## Entrega
1. Resumo de 10 linhas em português: o que ficou pronto, o que mudou da ideia e por quê, riscos que restam.
2. Imagem panorama das telas do Administrador e, ao lado, da visão do Dono, mostrando que ele não vê nada da interpretação, da engenharia de cardápio nem da recuperação.
3. **PDF de exemplo do Relatório Mensal (Módulo I, estrutura completa)**, resumo de WhatsApp e roteiro da reunião, gerados com dados de teste de pelo menos 3 meses.
4. Zip final + guia passo a passo (incluindo como voltar atrás).
5. Lista curta "testar": o que observar como Administrador e o que confirmar que o Dono NÃO vê.
