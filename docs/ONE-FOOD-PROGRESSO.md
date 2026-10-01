# ONE Food — Progresso por fase

Leia este arquivo no início de cada sessão (o prompt mestre manda começar pela próxima fase não concluída).

| Fase | Situação | Portão |
|---|---|---|
| 0. Auditoria e prompt mestre | ✅ 01/10 | `docs/ONE-FOOD-AUDITORIA.md`, `docs/PROMPT-MESTRE-ONE-FOOD.md` |
| 1. ONE Base multi-empresa | ✅ 01/10 | 124 e2e + 30 insights + demo + **145 de vazamento** |
| 2. Personalização pelo Dono | ✅ 01/10 | **53 de personalização** + telas no navegador (computador, tablet e celular) |
| 3. Perfis por pessoa, PIN, Dono × Admin ONE UP, fechamento às cegas total | ⏭ próxima | escassez + às cegas |
| 4. Ficha 5.3–5.10 (R3 Leva 1 restante) | pendente | |
| 5. Command Center fase 1 + Financeiro ONE UP + modo suporte | pendente | |
| 6. Migração do Happy Alpha (paralelo e virada) | pendente | |
| 7. Inteligência, Raio-X, Recuperador | pendente | |

## Fase 1 — o que foi feito

- **Migração 0005:** tabela `empresas`; `empresa_id` em 29 tabelas, preenchido pelo próprio banco; RLS ligado e forçado com "nega tudo" sem empresa; unicidades, numeração e "um caixa aberto" passam a ser por empresa; papel `onefood_app` sem BYPASSRLS; trava `ha_ref_mesma_empresa` impede vínculo com registro de outra empresa (a chave estrangeira do PostgreSQL não olha o RLS). Um banco existente vira a **empresa nº 1** sem mover dados.
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

## Pendências conhecidas (entram nas próximas fases)

- **Cardápio de exemplo** (`server/src/seed/menu.ts`) ainda é o cardápio real do Happy Alpha; usado só na empresa nº 1 e nos testes. Trocar por modelo genérico antes de criar empresas de outros clientes.
- **Logotipo do Happy Alpha** ainda está em `web/public/logo.png` (preservado para a empresa nº 1). Antes de vender: enviar como logotipo da empresa nº 1 e remover do pacote.
- **Perfis:** o "Dono" ainda é o perfil ADMIN da empresa; o Admin ONE UP global e o PIN chegam na fase 3. Até lá, `INSIGHTS_ENABLED` continua desligado.
- **Fechamento às cegas:** o caixa ainda vê a diferença depois de contar (fase 3).
- **Imagem Docker** não foi construída neste ambiente (Docker Hub bloqueado); os passos dela foram testados fora do Docker. Validar no primeiro deploy no Coolify.
- **Backup online** (Cloudflare R2) é configuração do servidor, fora da aplicação: montar no deploy.
- Exportar/restaurar **uma** empresa: ferramenta prevista para a fase 5.
- Pasta `windows/` é da instalação offline (R2); não é usada no ONE Food online.
- O teste T24 (tempo de preparo) da R2 falha entre 0h e 2h11 por causa do horário; corrigido no ONE Food, não na R2.

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
