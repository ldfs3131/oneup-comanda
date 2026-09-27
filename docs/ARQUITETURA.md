# Happy Alpha — Arquitetura da V1

Documento de referência do sistema. Reflete o briefing original e as decisões fechadas com o Lucas em 27/09/2026.

## Decisões fechadas

| Tema | Decisão |
|---|---|
| Cozinha | Só comida vai para o tablet. Bebida entra direto na conta (produto marcado "não vai para a cozinha"). |
| Variações | Opções com preço por produto (ex.: espeto + farofa e vinagrete +R$ 5,00). |
| Conta pendente | Nome + casa/telefone obrigatórios no momento em que a conta vira PENDENTE. |
| Taxa de serviço | Não existe. Total = itens − descontos. |
| Impressão | Nenhuma na V1. Papel manual como contingência. |
| Dispositivos | 1 caixa + 1 tablet na cozinha (sistema aceita mais, sem limite técnico). |
| Fiscal | MEI, sem emissão de nota. Dashboard mostra faturamento acumulado no ano. |
| Servidor | Local, no computador Windows do caixa. Tablet acessa pelo Wi-Fi. |
| Descontos | Caixa e admin, sem limite de valor, motivo sempre obrigatório. |
| Pendência paga depois | Entra no caixa do dia em que foi recebida. |
| Cancelamento em preparo | Motivo obrigatório; registrado como perda. |

---

## 1. Arquitetura proposta

```
 ┌──────────── Computador do caixa (Windows) ────────────┐
 │                                                       │
 │  Navegador (tela do caixa)                            │
 │        │  http://localhost:3000                       │
 │        ▼                                              │
 │  Servidor Happy Alpha (Node.js, um único processo)    │
 │   ├─ API REST  /api/...   (regras de negócio)         │
 │   ├─ Tempo real (Socket.IO) → avisos cozinha/caixa    │
 │   ├─ Arquivos do site (React compilado)               │
 │   └─ Fotos dos produtos   /uploads                    │
 │        │                                              │
 │        ▼                                              │
 │  PostgreSQL 16 (serviço do Windows)                   │
 └───────────────────────▲───────────────────────────────┘
                         │ Wi-Fi do restaurante
               http://192.168.x.x:3000/cozinha
                         │
              Tablet da cozinha (Fully Kiosk Browser)
```

- **Frontend:** React + TypeScript (Vite). Telas separadas por contexto: caixa, cozinha, admin e cliente.
- **Backend:** Node.js + TypeScript (Fastify). Toda regra de dinheiro mora aqui: o navegador envia só "produto X, quantidade Y, opções Z" e o servidor calcula preços.
- **Banco:** PostgreSQL + Drizzle ORM. Migrações versionadas aplicadas automaticamente quando o servidor inicia.
- **Tempo real:** Socket.IO. Cozinha e caixa recebem eventos na hora; se a conexão cair, reconecta sozinho e a tela mostra uma faixa vermelha "Sem conexão".
- **Autenticação:** sessão em cookie httpOnly, token aleatório guardado no banco em hash; senhas com bcrypt. Perfis: ADMIN, CAIXA, COZINHA.
- **Dinheiro:** sempre em centavos (inteiro). Nunca ponto flutuante.
- **Um único endereço e porta** (3000): o servidor entrega o site e a API juntos. Menos peças para quebrar.

## 2. Estrutura do banco

| Tabela | Função |
|---|---|
| `roles` | Perfis (ADMIN, CAIXA, COZINHA) |
| `users` | Usuários, login, hash da senha, perfil, ativo |
| `sessions` | Sessões de login |
| `categories` | Categorias do cardápio, ordem, ativa |
| `products` | Nome, descrição, preço (centavos), foto, disponível, ativo, ordem, vai para cozinha, "revisar" |
| `option_groups` | Grupos de opções por produto (ex.: "Espeto da jantinha", obrigatório) |
| `options` | Opções com acréscimo de preço |
| `accounts` | Contas: número, cliente (opcional), observação, contato, status |
| `orders` | Pedidos: número, conta, sequência na conta (1 = novo, 2+ = complemento), origem, status, horários e usuários de cada etapa |
| `order_items` | Itens com **nome e preço congelados no momento da venda** |
| `payment_methods` | PIX, Dinheiro, Cartão (outros podem ser ativados depois) |
| `payments` | Pagamentos por conta, forma, valor, caixa, usuário, estorno |
| `discounts` | Descontos/ajustes: valor, motivo, usuário, horário |
| `cancellations` | Cancelamentos de item/pedido/conta: motivo, usuário, horário, se foi perda |
| `cash_registers` | Abertura/fechamento de caixa, esperado × contado, resumo congelado |
| `cash_movements` | Sangria e suprimento de dinheiro durante o caixa |
| `audit_logs` | Histórico legível de tudo que aconteceu |
| `restaurant_settings` | Restaurante aberto/fechado, QR Code ligado/desligado, WhatsApp |
| `delivery_settings` | Delivery aberto/fechado |

Regras estruturais:

- Nada é apagado. Itens, pedidos e contas são **cancelados** com motivo.
- O pedido guarda o preço praticado; mudar o preço no cardápio não altera vendas antigas.
- Pedidos, pagamentos, descontos e cancelamentos apontam para o caixa em que ocorreram, o que torna o fechamento exato.
- Preparado para crescer sem reescrever: `orders.origin` já aceita `QR_CODE`, `WHATSAPP` e `DELIVERY`; `customers`, `inventory`, `suppliers` e `stock_movements` entram depois como tabelas novas ligadas às existentes.

## 3. Mapa de telas

**Caixa** (desktop/tablet)
- Início: contas abertas em cartões grandes + faixa de "pedidos prontos" + botão **Nova conta**
- Conta: pedidos da conta com status, lançar produtos, enviar para cozinha, pagar, desconto, cancelar, marcar pendente, encerrar
- Contas a receber
- Meu caixa: abrir, sangria/suprimento, fechar

**Cozinha** (tablet/celular)
- Uma tela só, três colunas: **Novos**, **Em preparo**, **Prontos**. Cartões grandes, dois botões por cartão.

**Admin** (desktop/tablet)
- Dashboard do dia
- Contas (todas, com filtros) e Contas a receber
- Cardápio: categorias, produtos, opções, disponibilidade, fotos
- Usuários
- Caixas (histórico de fechamentos)
- Histórico (auditoria)
- Configurações: restaurante aberto/fechado, delivery, QR Code, WhatsApp, backup

**Cliente** (celular — desligado na V1)
- Cardápio digital com pedido, liberado só quando o admin ligar o QR Code.

## 4. Fluxo de usuários

```
Login ──► ADMIN   ──► Dashboard (acessa também todas as telas do caixa)
      ├─► CAIXA   ──► Início do caixa (pede para abrir o caixa se estiver fechado)
      └─► COZINHA ──► Painel da cozinha (sessão longa; o tablet fica logado)
```

## 5. Fluxo de uma conta

```
ABERTA ──(pagamento parcial)──► PARCIALMENTE PAGA ──(quita)──► PAGA ──(encerrar)──► ENCERRADA
   │                                   │                                              │
   │                                   └──(cliente saiu sem pagar: exige nome+contato)─┐
   │                                                                                  ▼
   └──(sem pagamento, saiu)──────────────────────────────────────────────────► PENDENTE
                                                               (quita depois) ──► PAGA
ENCERRADA ──(admin reabre com motivo)──► volta ao status calculado
ABERTA sem pagamentos ──(cancelar com motivo)──► CANCELADA
```

## 6. Fluxo de um pedido

```
Caixa:    NOVO → CONFIRMADO (automático) → EM PREPARO → PRONTO → ENTREGUE
QR Code:  AGUARDANDO CONFIRMAÇÃO → (caixa confirma) → CONFIRMADO → ...
Só bebidas (nada vai à cozinha): NOVO → ENTREGUE na hora
Qualquer ponto antes de ENTREGUE: CANCELADO (com motivo)
```

`ENTREGUE` foi acrescentado ao briefing para o caixa "dar baixa" no aviso de pronto quando o cliente retira.

## 7. Fluxo da cozinha

```
Pedido chega (bip curto) ──► coluna NOVOS: "PEDIDO #301 · CONTA #128" ou "COMPLEMENTO DA CONTA #128"
   [INICIAR PREPARO] ──► EM PREPARO
   [PRONTO] ──► PRONTOS (caixa recebe alerta sonoro + visual)
   [Voltar para preparo] se algo saiu errado
   [Problema] envia um aviso com texto ao caixa
```

A cozinha só vê itens de cozinha. Bebidas nunca aparecem no tablet.

## 8. Fluxo de pagamento

```
Conta ► [Receber] ► escolhe forma (PIX / Dinheiro / Cartão) ► valor (já vem o saldo)
      ► pode somar várias formas ► confirma
      ► saldo 0 → "Receber e encerrar" em um clique
      ► saldo > 0 → PARCIALMENTE PAGA (continua aberta) ou "Cliente saiu" → PENDENTE
Dinheiro: informa o valor entregue e o sistema mostra o troco.
Todo pagamento cai no caixa aberto no momento.
```

## 9. Estratégia de implantação

1. **Instalação no computador do caixa** com o guia `docs/INSTALACAO.md`: PostgreSQL, Node.js, sistema como tarefa que inicia com o Windows.
2. **Modo demonstração** separado (outro banco, faixa amarela "DEMONSTRAÇÃO"): a equipe treina sem sujar os dados reais.
3. **Semana 1 — em paralelo com o papel:** tudo é lançado no sistema e no papel. No fechamento, conferir os dois.
4. **Semana 2 — sistema como principal:** papel só se o sistema cair.
5. **Contingência:** se o computador desligar, volta ao papel; ao religar, os pedidos do papel são lançados.
6. **Backup automático** a cada fechamento de caixa + botão "Backup agora" (pendrive e pasta do Google Drive).
7. **Nuvem depois, se fizer sentido:** o mesmo sistema roda num servidor online, basta migrar o banco.

## 10. Roadmap de desenvolvimento

| Etapa | Entrega |
|---|---|
| 1 | Arquitetura e banco |
| 2 | Login, perfis e usuários |
| 3 | Cardápio com opções, disponibilidade e fotos (cardápio real cadastrado) |
| 4 | Contas e pedidos |
| 5 | Cozinha em tempo real |
| 6 | Pagamentos, descontos, cancelamentos, pendências |
| 7 | Abertura e fechamento de caixa |
| 8 | Dashboard e histórico |
| 9 | Cardápio digital/QR Code pronto e desligado |
| 10 | Teste automatizado dos 33 critérios de aceite |
| 11 | Pacote de instalação Windows + guia |

Fases futuras (fora da V1): QR Code em uso → WhatsApp oficial → Delivery → Gestão avançada (estoque, CMV, fornecedores).
