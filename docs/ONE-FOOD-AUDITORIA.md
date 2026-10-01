# ONE Food — Auditoria e plano (etapa 0)

01/10/2026 · base: Happy Alpha R2.0.2 (commit `ca374e1`) · projeto novo em `one-food/`

## 1. Estado real do código (lido, não suposto)

| Item | Situação |
|---|---|
| Tecnologia | Node 22 + TypeScript, Fastify 5, Drizzle, PostgreSQL 16, React 19 (Vite), Socket.IO. **Já é a stack do prompt da plataforma.** |
| Banco | 30 tabelas, 5 migrações. Trilha imutável completa (nada se apaga nem se edita; só estorno, cancelamento de despesa, juntar contas). |
| Perfis | ADMIN, CAIXA, COZINHA (por login e senha). Não existem DONO, ADMINISTRADOR separado, PIN nem permissões nomeadas. |
| Testes | 124 verificações e2e + 30 de insights + bateria de auditoria (88) + telas no navegador. Tudo passando. |
| Onde roda | Um computador Windows, offline, um restaurante só. |
| Personalização | Só nome, subtítulo, WhatsApp, cardápio digital, MEI e ABERTO/FECHADO. O resto está fixo no código. |

## 2. O que impede ter vários restaurantes hoje

| # | Ponto | Risco se ignorado | Solução |
|---|---|---|---|
| 1 | Nenhuma tabela sabe de qual empresa é o registro | Tudo misturado | `empresa_id` em 28 tabelas (só `roles` fica global) + RLS forçado |
| 2 | **Tempo real por perfil, não por empresa**: o pedido novo vai para TODAS as cozinhas conectadas | Cozinha do restaurante B vê pedido do A | Salas por empresa (`e:<id>:kitchen`) |
| 3 | **Cache de insights global** (uma variável para o servidor inteiro) | Empresa B recebe a análise da A | Cache por empresa |
| 4 | Numeração de contas/pedidos única global (`counters`, `number UNIQUE`) | Restaurante B começa no #4.812 | Contador e unicidade por empresa |
| 5 | Formas de pagamento e categorias de despesa com código/nome únicos globais | Uma empresa não consegue ter "Pix" se outra já tem | Unicidade por empresa |
| 6 | Login com usuário único global | Dois restaurantes não podem ter "caixa" | Usuário único por empresa |
| 7 | 21 pontos leem "a configuração nº 1"; 16 textos "Happy Alpha" no código; cardápio de 167 linhas embutido | Todo restaurante vira Happy Alpha | Configuração por empresa; cardápio vira modelo opcional |
| 8 | Backup grava em pasta local do Windows | Não serve online | Backup diário do banco no servidor (Cloudflare R2), fora do app |
| 9 | Fechamento às cegas incompleto: o caixa vê a diferença depois de contar | Contraria a decisão de 30/09 | Filtrar por permissão no servidor (Módulo 5 da R3) |
| 10 | Tarefa em segundo plano (backup ao fechar o dia) roda depois da resposta | Com isolamento por conexão, ela perderia a empresa | Tarefas de fundo abrem o próprio contexto de empresa |

## 3. Decisões congeladas que ainda não estão no código

Fonte: PROMPT-R3-LEVA1 v3, PROMPT-R3-LEVA2 v3, auditoria de 30/09 (seções 10–13), ONE UP Command Center (01/10) e conversa de 01/10.

- **Plataforma:** multi-empresa (RLS), Command Center, dois financeiros, Raio-X, Recuperador, manifesto do produto.
- **R3 Leva 1:** perfis por pessoa com PIN (Caixa, Cozinha, Dono, Administrador); menu do Dono com 6 itens; pedido com pelo menos um identificador; cardápio digital com resumo, consentimento e acompanhamento por token; avulso "Outro/Adicional"; estoque nunca trava a venda; Pendências; A receber com data combinada; fechamento às cegas total; financeiro do Dono em 3 abas; estoque do Dono em 4 blocos; importação CSV; nada do Happy Alpha fixo no código; horários de todas as etapas.
- **R3 Leva 2:** financeiro completo, engenharia de cardápio, estoque do consultor, operação e equipe, clientes e fiado, aba IA com anti-alucinação, Radar, Central de serviços, Recuperação de vendas, Relatório Mensal ONE UP (Módulo I).
- **Novas (01/10):** nome **ONE Food**; Rafael online; **o Dono personaliza o máximo possível em Configurações**, com histórico, voltar ao padrão e cadeado do Administrador; o que protege dinheiro fica travado para todos.

## 4. O que muda de status com a ida para o online

| Decisão antiga (offline) | Agora |
|---|---|
| Licença/trial de 21 dias com código assinado offline e entrega compilada | Vira **status da assinatura** no Financeiro ONE UP; vencido → somente consulta (mesma regra) |
| Backup local + lembrete de cópia manual no Drive | Backup diário automático no servidor (R2, 30 dias) + exportação por empresa |
| Acesso de suporte pelo Tailscale | Modo suporte do Command Center (motivo, 60 min, auditoria visível ao Dono) |
| "Permitir suporte" do Dono para ver dados de clientes | Mantido: dados pessoais de clientes finais ficam mascarados para o Administrador sem esse interruptor ou contrato de recuperação |
| Porta pública + Tailscale Funnel para o cardápio | Endereço próprio da empresa (`slug.onefood…`) |

## 5. Plano por fases, com portões

| Fase | Entrega | Portão | Complexidade |
|---|---|---|---|
| **1. ONE Base** | empresas; `empresa_id` + RLS forçado; contexto por requisição; empresa pelo endereço; tempo real e cache por empresa; criar empresa por comando; Dockerfile | 154 testes antigos passando dentro da empresa 1 + **testes de vazamento** A × B (API, tempo real e banco direto) | Alta |
| **2. Personalização** | catálogo de configurações; tela gerada; histórico; padrão; cadeado; marca ONE Food sem nada fixo | dono muda, admin trava, caixa não vê; nada de dinheiro configurável | Média |
| 3. Perfis e permissões | PIN, Dono × Administrador, aparelho autorizado, permissões nomeadas, fechamento às cegas total | teste "ninguém além do Administrador recebe interpretação" | Média |
| 4. R3 Leva 1 restante | módulos 2–9 | e2e por módulo | Média |
| 5. Command Center fase 1 | carteira, Financeiro ONE UP manual, desempenho, modo suporte | vazamento + auditoria | Alta |
| 6. Migração do Rafael | ensaio em cópia, conferência de totais, paralelo, virada | zero diferença | Média |
| 7. Leva 2 / Raio-X / Recuperador | conforme prompt mestre | testes de escassez | Alta |

**Escopo desta sessão:** fases 1 e 2.

## 6. O que não será alterado

Regras de negócio da R2 (cálculo no servidor, congelamento de preço e custo, imutabilidade, FIFO de situação, idempotência, reabertura só com itens novos, cardápio seguindo ABERTO/FECHADO). A R2.0.2 do Rafael segue no projeto `happy-alpha` até a virada.

## 7. Riscos

- **RLS mal aplicado vaza dados:** mitigado com padrão "nega tudo" (sem empresa no contexto = nenhuma linha), papel de banco sem privilégio de ignorar RLS, `db` que recusa consulta fora de contexto, e testes de vazamento como portão.
- **Internet do restaurante:** online sem internet para o restaurante. Requisito de implantação: internet no balcão + 4G reserva + combinado de papel.
- **Conexão presa por requisição:** cada requisição segura uma conexão do banco; pool dimensionado e liberado sempre ao fim.

## 8. Perguntas de negócio (resolvidas pelas decisões de 01/10)

1. Nome: **ONE Food**. 2. Rafael online: **sim**, após portões e checagem de internet. 3. Quem personaliza: **Dono**, com cadeado do Administrador. 4. Onde roda: VPS Hostinger + Coolify + Cloudflare. 5. Ordem: restaurante primeiro, cria a ONE Base.
