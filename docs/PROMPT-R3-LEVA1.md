# PROMPT DE EXECUÇÃO — Happy Alpha Gourmet R3 · LEVA 1 (versão enxuta: operação, estoque e números do Dono)

> STATUS: CONGELADO (v3, enxuta; 30/09: detalhes do prompt original recuperados no Adiado e no Módulo 2). Não executar até o Lucas dar o ok.
> A Leva 2 (`PROMPT-R3-LEVA2.md`: insights, engenharia de cardápio, recuperação de vendas, aba IA, PDF) só começa depois de a Leva 1 rodar ao menos 2 semanas e o feedback ser incorporado. Esta versão substitui as anteriores.

## Papel
Você é meu sócio e especialista sênior (produto, financeiro de restaurante, segurança, UX de PDV). Não tente me agradar. Se uma ideia minha for ruim, tiver risco ou existir algo melhor, diga, justifique e implemente a melhor versão. Eu (Lucas) NÃO sou programador: explique em português simples e entregue pronto para usar.

## Contexto
Projeto em `/home/claude/happy-alpha` (Node 22/TS, Fastify 5, Drizzle, PostgreSQL 16, React 19/Vite, Socket.IO). Vendas, pagamentos e histórico são imutáveis por trigger no banco. Migrações SOMENTE aditivas. Autorização sempre no servidor. A R2 já funciona e o cardápio digital segue o ABERTO/FECHADO do caixa (não mexer nesse comportamento).

**Quem é quem:** o restaurante é do **Rafael (DONO)**; **eu, Lucas / ONE UP, sou o ADMINISTRADOR** (no Happy Alpha tenho só a conta de ADMINISTRADOR). Começa **OFFLINE** (computador do restaurante, teste de 2 semanas). Nascer compatível com o online (VPS), mas online NÃO é prioridade agora.

## DUAS REGRAS DE OURO

**1. A versão do Dono é ENXUTA e focada.** O Rafael precisa operar o restaurante e enxergar o essencial do dinheiro e do estoque, sem se perder. Portanto:
- Menu do Dono com no máximo 6 itens: **Pedidos · Financeiro · Estoque · A receber · Pendências · Configurações**.
- Cada tela responde UMA pergunta e cabe em uma rolagem no tablet. No máximo 2 gráficos por tela.
- **Não mexer no que a R2 já faz bem.** Só entra o que está listado nos módulos abaixo. Ideia nova durante a execução vai para a lista "Adiado", não para a tela do Dono.

**2. O Dono vê NÚMEROS, nunca interpretação.** A interpretação é o serviço que eu vendo e fica só comigo.

| | DONO vê | Só o ADMINISTRADOR vê (Leva 2) |
|---|---|---|
| Dinheiro | Vendido, custo, despesas, lucro do mês, a receber, forma de pagamento, tabela de produtos (preço, custo, margem) | tudo isso e muito mais |
| Estoque | Área objetiva (Módulo 7) | + giro, ruptura, capital parado, CMV |
| Interpretação | **NADA.** Sem "O que os números dizem", sem gargalo, sem prioridades, sem ranking de lucro, sem etiquetas de margem, sem **engenharia de cardápio**, sem mapa de demora, sem nota do restaurante, sem diagnóstico | tudo |
| Cobrança | Lista genérica "A receber", sem botão de cobrar | **CRM de recuperação de vendas** |

Regra técnica: telas, rotas e sockets de interpretação e de recuperação exigem permissões (`insights.*`, `recovery.*`, `admin.*`) que DONO, CAIXA e COZINHA NUNCA recebem. Teste automatizado que falha se qualquer resposta a esses perfis contiver campos de insight, engenharia de cardápio ou recuperação.

## Método
1. Leia o código relevante antes de mexer; liste o que já existe e o que falta.
2. Módulos na ordem abaixo; cada um com código + migração aditiva + teste.
3. Rode os 124 checks e2e existentes + novos. Nada pode regredir.
4. Ao final: zip (com `web/dist`), guia em `docs/`, CHANGELOG em português e resumo curto.

---

## MÓDULO 0 — Perfis por pessoa (FAZER PRIMEIRO)
Usuário individual (nome + PIN de 4 a 6 dígitos, hash, tentativas limitadas) + FUNÇÃO: **CAIXA, COZINHA, DONO, ADMINISTRADOR**. Troca rápida de usuário no tablet (2 toques). Todo pedido, desconto, cancelamento, recebimento, fechamento, ajuste de estoque e ação da cozinha grava QUEM fez. Migração: ADMIN existente vira DONO. Trocar `requireRole` por permissões nomeadas, validadas no servidor. DONO redefine PIN de funcionário e cria/desativa funcionários (não cria ADMINISTRADOR).

| Área | Caixa | Cozinha | Dono | Adm |
|---|---|---|---|---|
| Pedido, receber, Outro/Adicional, fechar dia (às cegas) | ✔ | – | ✔ | ✔ |
| Tela da cozinha | – | ✔ | ✔ | ✔ |
| Financeiro (números), A receber, Pendências | ✘ | ✘ | ✔ | ✔ |
| Estoque (ver, entrada, ajuste) | só alerta | ✘ | ✔ | ✔ |
| Produtos, preços, custos, configurações, funcionários | ✘ | ✘ | ✔ | ✔ |
| Interpretação, engenharia de cardápio, IA, recuperação | ✘ | ✘ | ✘ | ✔ (Leva 2) |
| Backup: restaurar/exportar, atualizar versão, licença, ligar/desligar recursos | ✘ | ✘ | só status | ✔ |
| "Ver como" Dono/Caixa/Cozinha (somente leitura) | ✘ | ✘ | vê o registro de acessos | ✔ |

Regras do ADMINISTRADOR: não aparece na lista de funcionários; toda ação fica na auditoria como "Suporte ONE UP", visível ao Dono; não edita nem apaga vendas, pagamentos ou histórico (triggers valem para todos); modo "ver como" é somente leitura; acesso remoto meu só pela rede privada (Tailscale), nunca pelo link público. O Dono liga um **interruptor "Permitir suporte" (30 min, 2 h ou 24 h)**, que expira sozinho, para eu ver dados de clientes. Guardar do funcionário só o mínimo (nome, função, PIN em hash, ativo).

## MÓDULO 1 — Base e backup
- `trustProxy` configurável por `.env` (hoje `false`: atrás do link público todos parecem o mesmo IP e o limite de tentativas bloqueia todo mundo junto). Corrigir sem abrir brecha.
- Setup 100% não interativo (flags/variáveis).
- **Backup:** automático diário no computador, com aviso se falhar; botão "Exportar backup completo" (só ADMINISTRADOR); **lembrete a cada 30 dias na conta do ADMINISTRADOR** ("Você fez o backup externo no Google Drive?") com "Já fiz" (grava data e quem) e "Lembrar amanhã". O Dono só vê "último backup: data". Sem envio automático para nuvem agora.

## MÓDULO 2 — Pedido e cardápio (só o essencial)
- Caixa: para abrir pedido, PELO MENOS UM entre nome, telefone, mesa ou obs (validar no servidor, mínimo 2 caracteres reais). Mesa e telefone opcionais.
- Cardápio digital: NOME e WHATSAPP obrigatórios (formato BR); **caixinha separada e opcional** "aceito receber ofertas por WhatsApp" (texto e data/hora guardados; sem ela nunca enviar promoção). Tela de resumo antes de enviar. Acompanhamento por **token aleatório** (sem nome, telefone nem estimativa; número do pedido não previsível), mostrando as etapas **aguardando confirmação → confirmado → em preparação → pronto para retirar** (a etapa "aguardando confirmação" existe só para pedido online; a R2 ainda não tem essa página). Pedido recusado mostra o motivo.

## MÓDULO 3 — Venda avulsa e estoque sem travar a venda
O CAIXA NÃO cadastra produto.
- "＋ Outro / Adicional": NOME* e PREÇO* obrigatórios, sugestões de nomes usados antes, 1 toque para adicionar, respeita `goesToKitchen`, auditoria de quem vendeu.
- Item com estoque zerado/insuficiente NUNCA trava o caixa (no cardápio online o "Acabou" continua bloqueando). Verifique como o estoque se comporta hoje e adote a solução mais segura: permitir e marcar "estoque divergente", sem corromper histórico.
- **Pendências** (uma tela, contador no menu; Dono e Administrador), só 3 listas: avulsos repetidos (com botão "virar produto"), vendas com estoque divergente, produtos sem custo. Cada uma se resolve e some; nada bloqueia a operação.

## MÓDULO 4 — Contas a receber (genérica)
- Ao deixar PENDENTE: exigir nome + (casa ou telefone); campo opcional "data combinada".
- Lista com etiquetas venceu / hoje / em dia, ordenada por urgência, total no topo e botão **Receber** (baixa). É só isso que Dono e Caixa veem.
- **Cobrança pelo WhatsApp DESLIGADA por padrão.** Só o ADMINISTRADOR pode ligar, por restaurante, um botão "💬 Cobrar" (abre `wa.me` com mensagem editável; o sistema não envia sozinho; registra última cobrança).
- Deixar o campo `origem` na conta pronto para a recuperação (Leva 2). A **baixa dada por Caixa/Dono** é a confirmação que libera qualquer comissão de recuperação. Sem CRM, funil nem régua aqui.

## MÓDULO 5 — Fechamento às cegas
- O Caixa só conta o dinheiro e, depois, vê "Contagem registrada ✔". **Nunca** vê valor esperado, diferença, PIX, cartão nem total. Divergência acima da tolerância: só "Confira com o responsável", sem valor. Dono e Administrador veem tudo.
- BUG: `POST /api/day/close` e `/api/register/close` hoje devolvem `expectedCashCents`, `differenceCents` e `receivedCents` ao caixa. Filtrar por perfil no servidor, revisar telas e sockets do caixa, e teste que falha se o caixa receber esses campos.

## MÓDULO 6 — Financeiro do DONO (enxuto: 3 abas)
Filtro em botões: **Hoje · 7 dias · Mês · Ano** (Ano = 12 meses corridos; mês sem dados aparece cinza "sem dados", nunca zero). Só números.
- **Resumo:** Lucro do período (valor e margem %, com ▲▼ % vs período anterior); quatro cartões: Vendido · Custo dos produtos · Despesas · A receber; cascata compacta "Vendido → Descontos → Custo → Despesas → Lucro" com números batendo exato; uma barra única de forma de pagamento (dinheiro, PIX, cartão); no filtro Ano, 12 barras de vendido e lucro (sem tabela). ⓘ "Lucro = Vendido − Descontos − Custo dos produtos − Despesas lançadas; não inclui impostos, pró-labore nem taxas de cartão se não lançadas". Alerta fixo quando houver produto vendido sem custo: "o lucro pode estar maior que o real" (hoje o sistema mostra 100% de margem: corrigir).
- **Despesas:** despesas por categoria (barras, valor e %), lista dos lançamentos e botão "Lançar despesa" (descrição, categoria, valor, data; grava quem lançou).
- **Produtos:** tabela em ordem alfabética com preço, custo, margem %, vendidos e lucro total; produto sem custo mostra "sem custo" (nunca 100%); atalho para editar o custo. **Sem etiquetas, sem ranking, sem "os que mais lucram".**
- **NÃO entra na tela do Dono** (vai para o Administrador na Leva 2): aba Fluxo diário, comparativo de 6 meses, tabela mês a mês, ponto de equilíbrio, melhor/pior dia, qualquer caixa "O que os números dizem".
- Regras visuais (skill dataviz): tokens do sistema, uma escala, sem eixo duplo, legenda com ≥2 séries, paleta validada pelo script, renderizar e olhar; legível em tablet.

## MÓDULO 7 — Estoque do DONO (objetivo, sem perder o foco)
Quatro blocos, nada além disso:
1. **Estoque atual e alertas:** lista dos produtos com controle de estoque (quantidade, mínimo, situação ok / acabando / acabou); mínimo por produto; contador no menu. O Caixa vê só o aviso "acabou/acabando", sem quantidades nem valores.
2. **Lançar entrada de compra:** produto, quantidade, custo unitário (opcional), fornecedor (texto livre, opcional). Se o custo diferir do cadastrado, perguntar "atualizar o custo do produto?" (nunca mudar sozinho).
3. **Ajustar estoque:** contagem/correção com motivo obrigatório (contagem, quebra, consumo interno, outro).
4. **Sugestão do que comprar (por conta, não opinião):** média diária de vendas dos últimos 30 dias × dias de cobertura desejados (padrão 7, configurável) − estoque atual, sempre mostrando a conta ("vende 18/dia × 7 = 126; tem 96; comprar 30"). Só com ≥14 dias de dados; senão "ainda sem dados suficientes".

Todo movimento (venda, entrada, ajuste) entra num **histórico imutável** (só acrescenta; guarda quem e quando); o Dono vê as últimas movimentações num link "histórico". Giro, ruptura, capital parado e perdas são análises do Administrador (Leva 2).

## MÓDULO 8 — Importação por planilha e marca
- **Importação CSV** (categoria, produto, preço, custo, estoque inicial, estoque mínimo, ativo, envia à cozinha): baixar modelo, pré-visualização com erros por linha antes de confirmar, atualizar existentes por nome sem apagar nada. É como o Rafael me manda preços e custos.
- Nome, logo e textos do restaurante configuráveis; seed em branco opcional; nada do Happy Alpha fixo no código.

## MÓDULO 9 — Preparar a Leva 2 (sem tela nova)
Garantir que todo pedido grave os horários (criado, confirmado, Iniciar, Pronto, entregue) em America/Sao_Paulo e que o consentimento de marketing seja guardado. Só o ADMINISTRADOR vê o "% de pedidos com horário da cozinha". Nenhuma tela de interpretação nesta leva.

---

## ADIADO (não fazer na Leva 1; nada foi descartado)
Puxe para a Leva 1 só se eu pedir.
- **Licença e trial de 21 dias** (fazer antes do 2º cliente; o Happy Alpha recebe código SEM validade e nunca trava; **teste automatizado próprio garantindo que a instalação do Happy Alpha nunca entra em trial, aviso ou somente consulta**, inclusive com o relógio adiantado). Desenho já decidido: validade gravada na instalação; aviso nos últimos 5 dias; vencido → modo somente consulta (ver histórico, receber contas abertas, exportar backup; sem abrir o dia nem pedido novo; cardápio online sai do ar); checagem só ao abrir o dia, nunca no meio do serviço; código de liberação assinado, atrelado ao ID da instalação, conferido offline e digitado em Configurações; proteção contra voltar o relógio do computador; chave privada e gerador NUNCA no pacote do cliente; **entregar versão compilada, sem código-fonte**; cardápio online pelo Tailscale Funnel na conta da ONE UP como segundo controle.
- **Cobrança básica (se um restaurante não contratar a recuperação):** telefone normalizado; botão cinza "sem WhatsApp" quando inválido; mensagem editável nas configurações com nome, saldo, data combinada e chave Pix opcional; registrar e mostrar "última cobrança" (data e quem).
- Pacote de suporte técnico (arquivo para WhatsApp), acesso por Tailscale documentado, desempenho por pessoa.
- Extras do cardápio: máx. 2 pedidos pendentes por WhatsApp; alerta de pedido esquecido (repete o aviso ao caixa e avisa o cliente após 5 min); botão "Saiu para entrega" (registra horário, sem status novo); botões de WhatsApp, grupo do Happy Alpha e site; delivery desligado por padrão, mas pronto no sistema (o Happy Alpha em regra não entrega, mas alguns dias pode).
- Financeiro avançado: aba Fluxo, comparativo de 6 meses, tabela mensal, ponto de equilíbrio, campos de taxa de cartão e imposto (vão para o Administrador na Leva 2).
- Validade/lote e perdas do estoque.
- Painel do criador com várias instâncias, migração para VPS, NFC-e.
- **Ajustes que surgirem no teste de 3 semanas da R2 (a partir de 30/09)** entram aqui primeiro e são avaliados na reunião pós-teste antes de subir para um módulo.

## Entrega
1. Resumo de 10 linhas em português: o que ficou pronto, o que mudou da ideia e por quê, riscos que restam.
2. Uma imagem panorama com as telas novas por perfil (Caixa, Cozinha, Dono, Administrador).
3. Zip final + guia passo a passo de atualização (incluindo como voltar atrás) e modelo CSV.
4. Lista curta "testar nas 2 semanas", por perfil.
