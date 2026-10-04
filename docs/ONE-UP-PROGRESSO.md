# ONE UP — Progresso por fase

Leia este arquivo no início de cada sessão (o prompt mestre manda começar pela próxima fase não concluída).

| Fase | Situação | Portão |
|---|---|---|
| 0. Auditoria e prompt mestre | ✅ 01/10 | `docs/ONE-UP-AUDITORIA.md`, `docs/PROMPT-MESTRE-ONE-UP.md` |
| 1. ONE Base multi-empresa | ✅ 01/10 | 124 e2e + 30 insights + demo + **145 de vazamento** |
| 2. Personalização pelo Dono | ✅ 01/10 | **54 de personalização** + telas no navegador (computador, tablet e celular) |
| 3. Perfis por pessoa, PIN, Dono × Admin ONE UP, fechamento às cegas total | ✅ 04/10 (3.3.0, com "Permitir suporte") | **67 da Leva 1** + às cegas no e2e |
| 4. Ficha 5.3–5.10 (R3 Leva 1 restante) | ✅ 04/10 (3.2.0) | suíte `leva1` |
| 5. Command Center fase 1 + Financeiro ONE UP + modo suporte | ✅ 04/10 (3.3.0) | suítes `plataforma`, `analise`, `auditoria` |
| 6. Migração do Happy Alpha (paralelo e virada) | pendente | |
| 7. Inteligência, Raio-X, Recuperador | 🟡 3.3.0 sem IA (Central de Análise, Recuperação de vendas) | suítes `analise`, `crm` |

## Versão 3.3.0 (04/10) — versão do Happy Alpha (decisões do comitê)

- **Dono:** começa em Pedidos; Painel do dia sem ranking, movimento por hora e tempo de cozinha (só ONE UP);
  Ritmo do mês só ONE UP. Trava do Dono em 2 minutos (cancelar com comida pronta, desconto acima do limite, fiado).
- **Acesso ONE UP com dados completos** (decisão do Lucas, 04/10, no lugar do "Permitir suporte" mascarado);
  toda ação da ONE UP aparece na auditoria como "Suporte ONE UP".
- **Caixa:** estornar pagamento (vira sangria se o dinheiro era de caixa fechado), trocar forma de pagamento,
  pré-conta, recusar pedido com motivo que o cliente entende, caixa só para receber.
- **Clientes e LGPD:** um cliente por telefone, juntar duplicados, exportar, apagar (anonimizar), parar ofertas,
  retenção de 24 meses, página /privacidade, acompanhamento expira em 48 h.
- **ONE UP:** Plataforma (licença por restaurante), Central de Análise, Recuperação de vendas (só com o serviço ligado),
  base de comparação. Cobrança continua sempre manual (wa.me).
- **Proteção:** 60 pedidos por IP a cada 10 min (Wi-Fi do restaurante é compartilhado); máximo de 40 aguardando.
- **Servidor:** backup externo criptografado no Google Drive da ONE UP (`oneup backup-externo configurar`),
  alertas por WhatsApp/e-mail (`oneup alertas configurar`), vigia a cada 5 min, `oneup versao`.
- **Adiado pelo comitê:** virada do dia às 05:00 (só se o restaurante fechar depois da meia-noite); deploy por releases;
  textos jurídicos de contrato.
- Testes: 16 suítes, TUDO OK (auditoria 30, plataforma 87, análise 86, crm 114, caixa 38, clientes 64).

## Versão 3.2.1 (04/10) — correções da auditoria do comitê

Relatório completo: `docs/AUDITORIA-COMITE-2026-10-04.md`. Corrigido (com a suíte `auditoria`, 17 verificações, e `migracoes`, 7):
migração da 3.2 que seria pulada ao atualizar; rajada no login (reserva antes do bcrypt, fila curta, limite no Nginx);
bloqueio do PIN atômico; revogar aparelho derruba a sessão; tempo real desconecta quem foi desativado e recusa outra origem;
POST de outra origem recusado; desconto de conta cancelada fora dos números; cortesia de 100% encerra; caixa não perdoa
fiado nem cancela conta com comida pronta (com a trava); despesa/sangria/desconto sem duplicar; mesa de 1 dígito;
/api/settings, histórico e menu sem vazar chaves da ONE UP e custo; tempo de cozinha só ONE UP; saúde confere o banco;
desligamento em ~1 s; JIT desligado e tempos-limite no banco; índices das telas ao vivo; instalador não muda o fuso;
"Tentar de novo" em vez de carregamento infinito; erro do pedido visível ao cliente; link do app de clientes certo.

## Versão 3.2.0 (04/10) — aplicativo do restaurante + Leva 1 completa

- **Aplicativo sem Play Store:** dois apps instaláveis pelo navegador com nome e ícone do restaurante — clientes (abre o
  cardápio) e equipe (abre o sistema); página `/app` com os dois botões; Dono troca nome e ícone em Configurações.
- **PIN de 4 números** para Caixa e Cozinha, só em aparelho onde alguém já entrou com senha; 5 erros = bloqueio de 5 min;
  Dono vê e revoga aparelhos; "Trocar de pessoa" em 2 toques. Definir o primeiro PIN não derruba ninguém.
- **Fechamento às cegas total:** Caixa nunca recebe esperado, diferença, PIX, cartão nem total (API e tela); acima da
  tolerância (Configurações → Caixa) vê só "Confira com o responsável".
- **Pedido identificável:** pelo menos um entre nome, telefone, mesa ou observação.
- **Cardápio digital:** nome e WhatsApp obrigatórios, caixinha separada de ofertas (texto e hora guardados), tela de
  revisão e acompanhamento por código aleatório (aguardando → confirmado → em preparação → pronto; recusado com motivo).
- **A receber:** data combinada, etiquetas venceu/hoje/sem data/em dia por urgência; botão "💬 Cobrar" desligado por padrão,
  só a ONE UP liga (seção "ONE UP (só você vê)" em Configurações); nunca envia sozinho, registra a última cobrança.
- **Estoque do Dono:** atual com mínimo, entrada de compra (custo e fornecedor; pergunta antes de mudar o custo), ajuste com
  motivo, sugestão de compra com a conta aberta (≥14 dias de dados), histórico imutável. Caixa vê só "acabou/acabando".
- **Pendências:** produtos sem custo (preenche ali), avulsos repetidos (virar produto/ignorar), divergências (conferido).
- **Importação por planilha CSV** em Cardápio: modelo, prévia com erro por linha, atualiza por nome, nunca apaga.
- **Financeiro do Dono:** Hoje/7 dias/Mês/Ano; lucro com ▲▼ vs período anterior; cascata exata; formas de pagamento;
  12 meses com "sem dados"; produtos em ordem alfabética com "sem custo" (nunca 100%).
- **Menu do Dono** com 6 itens (+ "Mais"); Tempo de preparo só ONE UP; lembrete de backup externo a cada 30 dias (só ONE UP).

## Versão 3.0.0 online (01/10) — entrega para o teste do Happy Alpha

- **Online:** `deploy/instalar.sh` (Ubuntu 24.04: Node 22, PostgreSQL, Caddy com HTTPS sob demanda, firewall,
  backup diário) e o comando `oneup` (status, atualizar com volta automática, backup, restaurar, senha, nova-empresa).
  Guia: `docs/INSTALACAO-ONLINE.md`. Ensaiado de ponta a ponta neste ambiente (instalar, reinstalar, atualizar,
  volta automática, backup, restaurar, HTTPS, certificado recusado para endereço inexistente).
- **Acesso ONE UP** (`users.oneup`): Administrador da plataforma dentro da empresa; fora da lista de usuários do Dono,
  intocável por ele; Insights e Base de comparação só nele (as ações dele ficam na Auditoria).
- **Taxa da maquininha** por forma de pagamento (Dono configura), congelada em cada pagamento; Financeiro mostra
  "cai na conta" e o resultado operacional desconta as taxas.
- **Base de comparação** (`referencias_externas`, só a plataforma grava): relatório da maquininha dos 6 meses antes do sistema.
- **Provisionamento por arquivo** (`plataforma.js provisionar`, `server/provisionamento/happy-alpha.json`): custos, produto
  novo desligado aguardando preço, taxas, logotipo, configurações iniciais e base. Idempotente.
- **Caixa nunca trava por estoque zerado** (regra da R3): vende, registra divergência, painel do Dono mostra
  "vendido sem estoque — ajuste a contagem"; cancelar não devolve unidade que nunca existiu.
- App instalável com o nome do restaurante; QR para imprimir/copiar link; validações em português; perfil ADMIN do
  restaurante aparece como **Dono**.
- Testes: suíte completa **436** verificações (nova `oneup-test`, 48).

## Fase 1 — o que foi feito

- **Migração 0005:** tabela `empresas`; `empresa_id` em 29 tabelas, preenchido pelo próprio banco; RLS ligado e forçado com "nega tudo" sem empresa; unicidades, numeração e "um caixa aberto" passam a ser por empresa; papel `oneup_app` sem BYPASSRLS; trava `ha_ref_mesma_empresa` impede vínculo com registro de outra empresa (a chave estrangeira do PostgreSQL não olha o RLS). Um banco existente vira a **empresa nº 1** sem mover dados.
- **Contexto por requisição** (`server/src/db/index.ts`): cada chamada de API usa uma conexão exclusiva presa à empresa; consulta fora de contexto é recusada; `runAsEmpresa` e `runAsSystem` para tarefas de fundo, scripts e plataforma. Ponto único de escolha da conexão.
- **Empresa pelo endereço:** `<slug>.BASE_DOMAIN`; `DEFAULT_EMPRESA` para instalação de uma empresa só; cabeçalho `x-empresa` apenas com `EMPRESA_HEADER=true` (testes). A sessão só vale na empresa onde foi criada.
- **Tempo real, caches e limites de tentativa por empresa** (o cache de insights e as salas do Socket.IO eram globais).
- **Instalação sem terminal** (`setup.js` nunca espera teclado no servidor), **Dockerfile** e `.env.example` online.
- Testado: atualização de um banco real da R2.0.2 (dados idênticos, login e painel funcionando).

## Fase 2 — o que foi feito

- **Catálogo** (`server/src/services/configuracoes.ts`): 26 configurações em 8 seções; cada uma diz quem pode mudar (Dono ou ONE UP), valida o valor, tem padrão e explicação. A tela é **gerada** do catálogo.
- **Migração 0006:** `empresa_config` (valores), `config_historico` (imutável), `config_travas` (cadeado; a aplicação só lê).
- **Telas:** Configurações nova (busca, seções, "Alterado", padrão por item e seção, histórico, cadeado com motivo, logotipo, cor, formas de pagamento); marca da empresa em todas as telas (logotipo, cor de destaque, título da aba, nome do campo "Mesa"); cardápio digital com boas-vindas, links, texto de fechado e "Acabou" configurável.
- **Regras que as configurações ligam no servidor:** campos obrigatórios do pedido; limite de desconto do caixa (acumulado por conta); cancelar comida já pronta só pelo Dono; produto sem estoque no cardápio digital; módulos do plano liberam cardápio digital e delivery.
- **Ferramenta da ONE UP** (`server/dist/scripts/plataforma.js`): `empresas`, `catalogo`, `travar`, `destravar`, `definir`.
- Corrigido de passagem: o painel do Dono quebrava sem backup local; o menu do painel passava da largura no celular (já existia na R2).

## Revisão independente de segurança (01/10)

Um revisor que não participou do desenvolvimento procurou vazamentos que os testes não pegam. Corrigido:
- **Alta:** requisição cancelada no meio de uma transação (aparelho caiu) podia devolver ao pool uma conexão ainda em uso. Agora: conexão cancelada ou em transação é **descartada**, e o código antigo não consegue mais usá-la (`test:conexoes`, 7 verificações).
- Backup local por pasta desligado quando há mais de uma empresa (o pg_dump copia o banco inteiro).
- Logotipo só da pasta da própria empresa; cache de empresas e mapas de tentativas com limite de memória.
- Detalhes do servidor (pastas, IPs) escondidos no modo online; `EMPRESA_HEADER=true` recusado em produção.
- Trava de vínculo também ao mudar o caixa de um pagamento.
Verificado e OK pelo revisor: ordem dos hooks e contexto em uploads, salas do tempo real, caches por empresa, cookies por subdomínio, políticas de todas as tabelas, nenhuma função com privilégio elevado, scripts gravando na empresa certa.

## Pendências conhecidas (entram nas próximas fases)

- **Cardápio de exemplo** (`server/src/seed/menu.ts`) ainda é o cardápio real do Happy Alpha; usado só na empresa nº 1 e nos testes. Trocar por modelo genérico antes de criar empresas de outros clientes.
- **Logotipo do Happy Alpha** ainda está em `web/public/logo.png` (preservado para a empresa nº 1). Antes de vender: enviar como logotipo da empresa nº 1 e remover do pacote.
- **Perfis:** o "Dono" ainda é o perfil ADMIN da empresa; o Admin ONE UP global e o PIN chegam na fase 3. Até lá, `INSIGHTS_ENABLED` continua desligado.
- **Fechamento às cegas:** o caixa ainda vê a diferença depois de contar (fase 3).
- **Imagem Docker** não foi construída neste ambiente (Docker Hub bloqueado); os passos dela foram testados fora do Docker. Validar no primeiro deploy no Coolify.
- **Backup online** (Cloudflare R2) é configuração do servidor, fora da aplicação: montar no deploy.
- Exportar/restaurar **uma** empresa: ferramenta prevista para a fase 5.
- Pasta `windows/` é da instalação offline (R2); não é usada no ONE UP online.
- O teste T24 (tempo de preparo) da R2 falha entre 0h e 2h11 por causa do horário; corrigido no ONE UP, não na R2.

## Como rodar os testes

```bash
npm ci && npm run build
cd server
# 1) testes antigos dentro de uma empresa
DATABASE_URL=.../of_e2e node dist/scripts/setup.js --admin-name=Administrador --admin-pass=admin123 --caixa-pass=caixa123 --cozinha-pass=cozinha123
DATABASE_URL=.../of_e2e PORT=3100 INSIGHTS_ENABLED=true DEFAULT_EMPRESA=empresa-1 node dist/index.js &
DATABASE_URL=.../of_e2e BASE_URL=http://localhost:3100 node dist/scripts/e2e.js
DATABASE_URL=.../of_insights node dist/scripts/insights-test.js
# 2) vazamento e personalização (duas empresas)
for e in alfa beta; do DATABASE_URL=.../of_iso node dist/scripts/setup.js --empresa=$e --nome=$e --admin-pass=$e-admin --caixa-pass=$e-caixa --cozinha-pass=$e-coz --cardapio=exemplo; done
DATABASE_URL=.../of_iso EMPRESA_HEADER=true PORT=3200 node dist/index.js &
DATABASE_URL=.../of_iso BASE_URL=http://localhost:3200 node dist/scripts/isolamento-test.js
DATABASE_URL=.../of_iso BASE_URL=http://localhost:3200 node dist/scripts/personalizacao-test.js
```
