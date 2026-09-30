# Instalação no computador do caixa (Windows) — Gourmet R2

> **Já usa a V1.1?** Pule para [Atualizar da V1.1 para a R2](#atualizar-da-v11-para-a-r2). O banco é o mesmo e nada do histórico se perde.

Tempo estimado: 40 minutos. Precisa de internet **só durante a instalação**. Depois o sistema funciona apenas com o Wi-Fi do restaurante.

## O que você precisa

- O computador do caixa (Windows 10 ou 11)
- O tablet Android da cozinha, no mesmo Wi-Fi
- Esta pasta `happy-alpha` (descompactada do .zip)
- Acesso ao roteador (para reservar o IP) — ou alguém que tenha

## Passo 1 — Instalar o PostgreSQL (o banco de dados)

1. Baixe o instalador do PostgreSQL 16 (ou mais novo) para Windows em **postgresql.org/download/windows** (versão da EDB).
2. Instale com as opções padrão. Ele vai pedir uma **senha para o usuário `postgres`**: crie uma senha forte e **anote num lugar seguro**. O instalador do Happy Alpha vai pedir essa senha.
3. Porta: deixe **5432**. No final, desmarque o "Stack Builder" (não é necessário).

## Passo 2 — Instalar o Node.js

1. Baixe o **Node.js 22 LTS** em **nodejs.org** (instalador .msi).
2. Instale com as opções padrão.

## Passo 3 — Copiar o sistema

Copie a pasta `happy-alpha` para **`C:\HappyAlpha`** (fica mais fácil achar depois).

## Passo 4 — Rodar o instalador

1. Abra `C:\HappyAlpha\windows`.
2. Dê dois cliques em **`INSTALAR.bat`** e aceite a permissão de administrador.
3. Responda o que ele perguntar:
   - senha do `postgres` (do passo 1);
   - pasta de backup: aperte **Enter** para usar `C:\HappyAlpha-Backups` (recomendado; veja “Backups” para levar a cópia à nuvem);
   - nome e **senha do administrador**, senha do **caixa** e senha da **cozinha**.
4. No final ele abre o sistema no navegador e mostra o endereço para o tablet, algo como `http://192.168.0.10:3010/cozinha`. **Anote esse endereço.**

O instalador já deixa tudo pronto:

- sistema iniciando sozinho quando o computador liga (tarefa "Happy Alpha" do Windows);
- se o sistema cair, ele volta sozinho em 5 segundos;
- firewall liberado para o tablet;
- cardápio oficial cadastrado;
- modo demonstração preparado para treinamento.

## Passo 5 — Fixar o IP do computador no roteador

Se o IP do computador mudar, o tablet para de encontrar o sistema. Para evitar isso:

1. Entre no painel do roteador (geralmente `192.168.0.1` ou `192.168.1.1`, a senha costuma estar na etiqueta).
2. Procure **"Reserva de DHCP"**, "IP fixo" ou "Address Reservation".
3. Reserve para o computador do caixa o IP que o instalador mostrou.

## Passo 6 — Preparar o tablet da cozinha

1. Instale o **Fully Kiosk Browser** (gratuito, Play Store).
2. Em "Start URL", coloque o endereço anotado: `http://IP-DO-CAIXA:3010/cozinha`.
3. Nas configurações do Fully Kiosk, ative **"Keep Screen On"** (tela sempre ligada).
4. Deixe o tablet **sempre no carregador**.
5. Entre com o login `cozinha` e toque em **TOCAR PARA INICIAR O TURNO**. Isso libera o som dos pedidos novos.

Sem o Fully Kiosk também funciona pelo Chrome, mas a tela pode apagar sozinha.

## Passo 7 — Primeiro acesso do administrador

1. No computador do caixa, abra `http://localhost:3010` e entre como administrador.
2. **Cardápio:** confira os preços. Cadastre o **custo** de cada produto (sem custo, o financeiro mostra o lucro bruto só dos itens que têm custo). Ative os sabores de **Monster** que vocês vendem (vêm desativados).
3. **Contagem inicial do estoque (obrigatória antes de abrir):** em **Caixa → Estoque → 📋 Contagem geral**, conte bebidas, cervejas, sucos e águas e salve. Sem isso, o sistema vai avisar “estoque insuficiente” na primeira venda.
4. **Configurações:** confira nome e subtítulo, as pastas de backup e clique em **“Fazer backup agora”** para testar. Ligue o **indicador do MEI** só se quiser acompanhar o limite anual.
5. **Usuários:** crie um usuário para cada funcionário. Assim o histórico mostra quem fez cada coisa. Esqueceu a senha? O administrador redefine em **Usuários**.

## Treinamento (modo demonstração)

Dê dois cliques em **`windows\DEMONSTRACAO.bat`**. Abre um sistema de teste em `http://localhost:3011` com contas de exemplo e uma faixa amarela "MODO DEMONSTRAÇÃO". No tablet, use `http://IP-DO-CAIXA:3011/cozinha`.

- Logins: `admin`, `caixa`, `cozinha` — senha `1234`.
- Cada vez que abrir, os dados de teste são recriados.
- Nada do que acontecer ali afeta o sistema real.

## Implantação recomendada

- **Semana 1:** lançar tudo no sistema **e** no papel. No **Encerrar o dia**, conferir os dois.
- **Semana 2 em diante:** sistema como principal. Papel só como contingência.
- **Se o computador desligar:** volta para o papel. Quando religar, o sistema sobe sozinho e os pedidos do papel são lançados.

## Backups

- **Automático:** a cada **Encerrar o dia**, uma cópia vai para cada pasta configurada. As 30 mais recentes ficam guardadas.
- **Manual:** botão em Configurações, ou `windows\BACKUP-AGORA.bat`.
- **Cópia na nuvem (recomendado):** instale o **Google Drive para computador**, entre com a conta do restaurante e, em *Preferências → Meu computador → Adicionar pasta*, escolha `C:\HappyAlpha-Backups`. O Drive sobe cada backup sozinho quando houver internet.
- **Não use `G:\Meu Drive\...` no `BACKUP_DIRS`:** o sistema roda como serviço do Windows e **não enxerga** a unidade G: do Google Drive (ela só existe na sessão do usuário). O backup falharia nessa pasta.
- **Pendrive:** pode entrar no `BACKUP_DIRS` (ex.: `C:\HappyAlpha-Backups;E:\HappyAlpha-Backups`), mas precisa ficar sempre conectado; se ele sair, o painel mostra “O último backup falhou”. Alternativa: uma vez por semana, copie à mão a pasta `C:\HappyAlpha-Backups` para o pendrive.
- **Aviso no painel:** o dashboard avisa quando o último backup falhou em **qualquer** pasta ou tem mais de 2 dias. Clique em **Fazer backup** para ver pasta por pasta o que deu certo.

**Restaurar um backup** (só em caso de perda do computador):

1. Instale tudo de novo (passos 1 a 4).
2. Abra o Prompt de Comando e rode, trocando o nome do arquivo (e o `16` pela versão instalada do PostgreSQL):
   ```
   "C:\Program Files\PostgreSQL\16\bin\pg_restore.exe" -U postgres -h localhost -d happy_alpha --clean --if-exists "C:\HappyAlpha-Backups\happy-alpha-AAAAMMDD-HHMM.dump"
   ```
3. Rode `windows\REINICIAR.bat`.

## Atualizar da V1.1 para a R2

A R2 usa **o mesmo banco** da V1.1: contas, pedidos, pagamentos e histórico continuam lá. As tabelas novas (estoque, custos, despesas, tempos, insights) são criadas sozinhas ao iniciar.

1. **Backup antes de tudo:** `windows\BACKUP-AGORA.bat` (confira que o arquivo apareceu na pasta de backup).
2. Guarde a V1.1: renomeie `C:\HappyAlpha` para `C:\HappyAlpha-V1.1` (é o seu “voltar atrás”).
3. Descompacte a R2 em `C:\HappyAlpha` e **copie da pasta antiga** os arquivos `.env`, `.env.demo` e a pasta `data`.
4. Abra o Prompt de Comando em `C:\HappyAlpha` e rode `npm ci --omit=dev -w server`.
5. Rode `windows\REINICIAR.bat`. Na primeira vez o sistema aplica as mudanças no banco e adiciona ao cardápio os itens novos (bebidas, drinks, Monster desativados) **sem mexer** nos produtos e preços que você já tinha.
6. Faça o **Passo 7** (custos, contagem inicial do estoque, Monster).
7. Se algo der errado: pare o sistema, volte a pasta `C:\HappyAlpha-V1.1` para `C:\HappyAlpha` e restaure o backup do item 1 (veja “Restaurar um backup”).

## Atualizar o sistema (versões futuras)

1. Faça um backup (`BACKUP-AGORA.bat`).
2. Substitua as pastas `server` e `web` pelas novas. **Não apague** o `.env`, o `.env.demo` nem a pasta `data`.
3. Abra o Prompt de Comando em `C:\HappyAlpha` e rode `npm ci --omit=dev -w server`.
4. Rode `windows\REINICIAR.bat`. As mudanças no banco são aplicadas sozinhas.

## Configurações do arquivo `.env`

| Variável | Para que serve | Padrão |
|---|---|---|
| `PORT` | Porta do sistema na rede local | `3010` |
| `DATABASE_URL` | Banco de produção | — |
| `BACKUP_DIRS` | Pastas de backup separadas por `;` | — |
| `PG_DUMP_PATH` | Caminho do `pg_dump.exe` | PostgreSQL 16 |
| `PUBLIC_PORT` | Porta pública separada, só com o cardápio do cliente (0 = desligada) | `0` |
| `COOKIE_SECURE` | `true` só se acessar por HTTPS (internet) | `false` |

Depois de mudar o `.env`, rode `windows\REINICIAR.bat`.

## Cardápio pelo celular do cliente (QR Code) — opcional

Está **pronto, mas desligado**. Todo pedido do cliente cai no caixa para **confirmação** antes de ir para a cozinha.

- **Só no Wi-Fi do restaurante:** em Configurações ligue “Cardápio digital” e imprima o QR Code mostrado.
- **Clientes no 4G (sem abrir o sistema inteiro para a internet):**
  1. No `.env`, coloque `PUBLIC_PORT=3012` e reinicie. Essa porta só serve o cardápio e o envio de pedidos — caixa, admin e cozinha **não** ficam acessíveis por ela.
  2. Instale o **Tailscale** no computador do caixa (tailscale.com, conta gratuita) e entre com a conta do restaurante.
  3. No Prompt de Comando: `tailscale funnel --bg 3012`. Ele mostra um endereço `https://NOME.ts.net`.
  4. Use esse endereço + `/cardapio` no QR Code (gere em qualquer gerador de QR).
  5. Para desligar: `tailscale funnel --bg 3012 off` (ou desligue o cardápio em Configurações).

## Colocar o sistema inteiro na internet (futuro)

Hoje o sistema roda no computador do caixa, na rede local — é o mais seguro e não depende de internet. Se um dia quiser acessar de fora (admin em casa, várias unidades):

- **Mais simples:** Tailscale no computador do caixa e no seu celular/notebook (rede privada, sem abrir portas). Não precisa de domínio.
- **Hospedagem na nuvem:** servidor Linux (VPS) com PostgreSQL, domínio próprio, **HTTPS obrigatório** (ex.: Caddy ou Nginx com Let's Encrypt) e `COOKIE_SECURE=true`. Aí o computador do caixa vira só um navegador — e sem internet, o restaurante para. Recomendo conversar antes de migrar.

## Problemas comuns

| Sintoma | O que fazer |
|---|---|
| Faixa vermelha "Sem conexão" | Confira o Wi-Fi do tablet e se o computador do caixa está ligado. |
| Tablet não abre o sistema | O IP do computador mudou: veja o IP novo (`ipconfig`) e reserve no roteador (passo 5). |
| Alerta de "pronto" sem som | Clique na faixa "Toque aqui para ativar o som" no caixa. Na cozinha, toque em "Iniciar turno". Confira o volume. |
| Sistema não abre em `localhost:3010` | Rode `windows\REINICIAR.bat`. Se continuar, veja `data\servidor.log`. |
| Backup falhou | Em Configurações → **Fazer backup agora** veja qual pasta falhou. Pendrive: confira se está conectado. Pasta `G:\...`: troque por `C:\HappyAlpha-Backups` no `.env` e use a sincronização do Google Drive (seção Backups). Depois rode `REINICIAR.bat`. |
| “Estoque insuficiente” toda hora | Faça a contagem geral em Caixa → Estoque. Use “+ Entrada” sempre que chegar mercadoria. |
| Não consigo lançar pedido | O estabelecimento está **FECHADO** (botão no topo) ou o dia não foi aberto. |
