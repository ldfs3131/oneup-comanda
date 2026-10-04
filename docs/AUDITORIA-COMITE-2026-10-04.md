# Auditoria do ONE UP Comanda — comitê de 7 especialistas (04/10/2026)

Prompt seguido: `docs/PROMPT-AUDITORIA-COMITE.md`. Versão auditada: 3.2.0. Versão corrigida: **3.2.1**.
Cada especialista leu só a sua área, provou os achados em banco e servidor próprios (sem tocar no projeto) e entregou
arquivo:linha, cenário, evidência e correção. Depois, cada achado grave foi conferido de novo e corrigido com um teste
que falharia antes.

## Placar
| Área | Achados | Crít. | Altos | Corrigidos agora |
|---|---|---|---|---|
| 1. Segurança e multiempresa | 10 | 1 | 2 | 7 |
| 2. Integridade do dinheiro | 10 | 0 | 2 | 6 |
| 3. Operação (PDV/UX) | 12 | 0 | 3 | 2 |
| 4. Frontend, app e acessibilidade | 12 | 0 | 3 | 5 |
| 5. Infraestrutura e continuidade | 13 | 0 | 5 | 6 |
| 6. Banco e desempenho | 12 | 1 | 2 | 6 |
| 7. Produto, LGPD e regras | 12 | 0 | 4 | 4 |

Testes: 11 suítes, **577 verificações, todas verdes** (novas: `migracoes` 7 e `auditoria` 17).

## O que já foi corrigido (3.2.1)
**Críticos**
- A migração da 3.2 tinha a mesma data da anterior: quem atualizasse da 3.1 subiria **sem PIN, aparelhos, fiado com data e
  acompanhamento** (login e cozinha quebrariam). Renumerada; teste novo recusa data repetida ou fora de ordem.
- Uma rajada anônima no login furava o limite de senhas e travava **todos os restaurantes** por até 32 s. Agora a tentativa
  é reservada antes de conferir a senha, há fila curta (429 imediato) e limite no Nginx.

**Altos e médios corrigidos**
- PIN: 7 tentativas simultâneas não bloqueavam; agora o bloqueio é atômico.
- Revogar um aparelho perdido não derrubava quem estava logado; agora derruba na hora.
- Tempo real continuava chegando a quem foi desativado e aceitava outra origem; corrigido.
- POST vindo de outro subdomínio (`*.oneupsistemas.com.br`) era aceito; agora 403.
- Desconto de conta cancelada deixava venda e lucro negativos; agora fica fora dos números.
- Cortesia de 100% nunca encerrava a conta; agora fica PAGA e encerra.
- Caixa conseguia "perdoar" fiado com ajuste e sumir com comida entregue cancelando a conta inteira; bloqueado.
- Despesa, sangria e desconto duplicavam com a rede lenta; agora com proteção contra repetição.
- Mesa de 1 dígito ("5") era recusada; corrigido.
- `/api/settings`, histórico de configurações e cardápio vazavam chaves da ONE UP e o custo dos produtos; corrigido.
- Tempo de cozinha aparecia no painel do Dono; agora só ONE UP. Telas da ONE UP redirecionam o Dono.
- Saúde respondia "ok" com o banco parado; agora confere o banco (503 se cair).
- Reinício ficava ~90 s fora do ar com tablets conectados; agora sai em ~1,3 s.
- Financeiro levava 1–1,6 s por causa do JIT do PostgreSQL com RLS; desligado (0,1–0,3 s) + tempos-limite.
- Índices para as telas ao vivo, resumo do caixa, estoque e auditoria.
- Instalador mudava o fuso do servidor inteiro (afetaria o Lava Jato); removido. Apt não reinicia serviços alheios.
- Nginx sem compressão (654 KB de JavaScript no 4G); ligada.
- Telas com carregamento infinito quando a API falha; agora "Tentar de novo" após 8 s em todas.
- Erro ao enviar pedido ficava escondido do cliente; agora aparece na tela de revisão.
- "Baixar o app de clientes" instalava o app da equipe; corrigido.
- Valores "1.500" e "2.000" eram recusados em silêncio; aceitos. "R$" não quebra mais de linha.
- Texto do WhatsApp prometia uso "só para este pedido" (não era verdade); texto corrigido.

## Decisões que são suas (Lucas)
1. **Ritmo do mês no Financeiro do Dono.** Tem projeção do fechamento e médias de 6 meses — o especialista de produto
   classifica como interpretação (Leva 2). Manter para o Dono ou mover para a ONE UP?
2. **Painel do dia** (primeira tela do Dono) mostra "Mais vendidos" e "Pedidos por hora". Fica, sai, ou o Dono passa a
   entrar direto em Pedidos/Financeiro?
3. **"Permitir suporte".** Hoje o acesso ONE UP vê nomes e telefones dos clientes sem o Dono liberar (prometido na Leva 1,
   ainda não feito). Fazer antes do teste do Rafael?
4. **Cópia de segurança fora da VPS.** Hoje tudo fica no mesmo disco. Escolher o destino (Google Drive da ONE UP ou
   Backblaze) para eu configurar a cópia criptografada diária.
5. **Alertas.** Para onde mandar aviso de backup falho, disco cheio e certificado vencendo (WhatsApp, Telegram ou e-mail)?

## Próximas melhorias recomendadas (por prioridade)
**Antes do Rafael usar de verdade**
- Tela **Clientes** do Dono: corrigir, juntar duplicados, "parar ofertas", "apagar dados" (LGPD); cliente identificado
  pelo telefone normalizado; sem telefone na auditoria.
- Barra de "prontos" com limite de altura (8 prontos tomam a tela do tablet) e itens no card.
- "Encerrar o dia": listar as contas abertas/pagas/vazias e os pedidos na cozinha; permitir **uma recontagem** se passar
  da tolerância antes de fechar.
- Autorização do Dono no próprio aparelho (PIN do Dono só para a ação) e troca de forma de pagamento do dia pelo caixa.
- Estorno depois do caixa fechado gerar a saída no caixa do dia.
- Motivo de recusa para o cliente em lista fechada (o texto livre do caixa hoje aparece para o cliente).
- Limite de pedidos públicos por IP e de pedidos aguardando por restaurante.

**Primeiras semanas**
- "+1" com desfazer de 5 s; aviso de mesa já aberta; divisão por pessoas que lembra quem já pagou; foco no "valor
  recebido" no dinheiro; aba "Mais vendidos" só com 8+ produtos; confirmação ao vender sem estoque; pré-conta.
- Contraste das cores fracas e da cor de destaque escolhida pelo Dono; margens da barra do iPhone; toques de 44 px;
  leitor de tela em modais e avisos; ícone "maskable" próprio; código dividido por área (cardápio mais leve).
- Deploy por versões com volta instantânea; instalador que não reescreve o `.env`; checar site padrão do Nginx;
  usuário de banco da aplicação sem BYPASSRLS; conferir que o `dist` publicado é o compilado.
- "Pedidos do dia" sem N+1; sugestão de compra e pendências em uma consulta; auditoria com filtros indexados; migrações
  publicadas congeladas por hash; limpeza diária das chaves de repetição.
- Dia operacional com virada às 05:00 (noites que passam da meia-noite somam no dia certo).
- Importação: preço 0 vira erro; aviso para "1.500" sem centavos.

## Maior risco de cada área (antes das correções)
1. Uma rajada no login parava todos os restaurantes. **Corrigido.**
2. Dinheiro saía sem rastro pelo cancelamento ou pelo ajuste de fiado. **Corrigido.**
3. O caixa trava em coisas pequenas repetidas numa sexta cheia. **Parcial** (mesa de 1 dígito corrigida).
4. O canal de pedido do cliente falhava em silêncio. **Corrigido.**
5. Tudo "verde" com o sistema quebrado e a única cópia no mesmo disco. **Parcial** (saúde real; falta cópia externa e alertas).
6. Atualizar da 3.1 subiria sem as tabelas da 3.2. **Corrigido.**
7. O Dono já via interpretação e o cliente recebia promessas não cumpridas. **Parcial** (decisões 1–3 acima).
