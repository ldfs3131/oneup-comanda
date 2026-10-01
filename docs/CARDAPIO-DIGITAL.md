# Cardápio digital online — ONE UP Comanda

O cliente abre um link no celular, vê o cardápio, monta o pedido e envia **direto para o caixa**.

## Como funciona

O cardápio segue o botão **ABERTO / FECHADO** do caixa (não depende de horário):

| No caixa | O cliente vê no link |
|---|---|
| **☀ Abrir o dia** (ou botão ABERTO) | Cardápio completo, pode montar e enviar o pedido |
| **🌙 Encerrar o dia** (ou botão FECHADO) | Página **“Estabelecimento fechado”** e botão do WhatsApp (se cadastrado) |

- A página confere o estado a cada 15 segundos. Quem já está com o link aberto vê a mudança sozinho.
- Mesmo que alguém tente enviar com a casa fechada, **o servidor recusa** o pedido.
- Preço, “Acabou?” e estoque zerado aparecem no link na hora (a lista vem do sistema).

## O pedido no caixa

1. O pedido chega em **Aguardando confirmação**, com o som de pedido novo, o nome do cliente e o local (“Consumo no local — mesa 4”).
2. O caixa **confirma** → vai para a cozinha. Ou **recusa**.
3. O pagamento é feito no balcão, como qualquer conta.

## Ligar (uma vez)

1. **Admin → Configurações → Cardápio digital (QR Code): Ligado.**
2. Na mesma tela, cadastre o **WhatsApp** (aparece na página de fechado).
3. No arquivo `.env` do computador do caixa, acrescente `PUBLIC_PORT=3012` e reinicie o sistema.
   A porta 3012 mostra **somente** o cardápio: qualquer outro endereço (caixa, admin) volta para o cardápio.

Teste na rede do restaurante: `http://IP-DO-CAIXA:3012/cardapio`.

## Publicar na internet (Tailscale Funnel)

Sem abrir porta no roteador:

1. Instale o Tailscale no computador do caixa (tailscale.com/download) e entre com uma conta.
2. No PowerShell como administrador:
   ```
   tailscale funnel --bg 3012
   ```
3. Ele mostra um endereço `https://NOME.xxxx.ts.net`. **Esse é o link do cliente**: `https://NOME.xxxx.ts.net/cardapio`.
   Use em QR Code, bio do Instagram, status do WhatsApp.

Com `--bg`, o Funnel volta sozinho quando o computador reinicia.

## Limite importante

O link funciona **enquanto o computador do caixa estiver ligado, com o sistema aberto e com internet**.
Com o computador desligado, o cliente vê uma página de erro do navegador, não a de “fechado”.
Se isso for um problema, dá para colocar uma página de entrada em hospedagem gratuita que mostra “fechado” mesmo com o computador desligado.

## Teste rápido

1. Abra `/cardapio` no celular com o dia **encerrado** → “Estabelecimento fechado”.
2. No caixa, **Abrir o dia** → em até 15 s o celular mostra o cardápio.
3. Envie um pedido com uma Jantinha → aparece no caixa em **Aguardando confirmação**.
4. **Encerrar o dia** → o celular volta para “fechado”.
