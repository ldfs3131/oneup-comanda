# Instalação no computador do caixa (Windows)

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
   - pastas de backup (ex.: `C:\HappyAlpha-Backups;G:\Meu Drive\HappyAlpha-Backups`);
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
2. Vá em **Cardápio → Bebidas** e cadastre as bebidas e o chope **com os preços corretos** (a lista não veio com preços, então não foi cadastrada).
3. Confira os outros preços.
4. Em **Configurações**:
   - confira as pastas de backup e clique em **"Fazer backup agora"** para testar;
   - coloque o número do WhatsApp oficial (fica guardado para o futuro).
5. Crie usuários individuais para cada funcionário em **Usuários**. Assim o histórico mostra quem fez cada coisa.

## Treinamento (modo demonstração)

Dê dois cliques em **`windows\DEMONSTRACAO.bat`**. Abre um sistema de teste em `http://localhost:3011` com contas de exemplo e uma faixa amarela "MODO DEMONSTRAÇÃO". No tablet, use `http://IP-DO-CAIXA:3011/cozinha`.

- Logins: `admin`, `caixa`, `cozinha` — senha `1234`.
- Cada vez que abrir, os dados de teste são recriados.
- Nada do que acontecer ali afeta o sistema real.

## Implantação recomendada

- **Semana 1:** lançar tudo no sistema **e** no papel. No fechamento do caixa, conferir os dois.
- **Semana 2 em diante:** sistema como principal. Papel só como contingência.
- **Se o computador desligar:** volta para o papel. Quando religar, o sistema sobe sozinho e os pedidos do papel são lançados.

## Backups

- **Automático:** a cada fechamento de caixa, uma cópia vai para cada pasta configurada. As 30 mais recentes ficam guardadas.
- **Manual:** botão em Configurações, ou `windows\BACKUP-AGORA.bat`.
- **Dica:** uma pasta no Google Drive para computador (`G:\Meu Drive\...`) sobe a cópia para a nuvem sozinha quando houver internet.

**Restaurar um backup** (só em caso de perda do computador):

1. Instale tudo de novo (passos 1 a 4).
2. Abra o Prompt de Comando e rode, trocando o nome do arquivo (e o `16` pela versão instalada do PostgreSQL):
   ```
   "C:\Program Files\PostgreSQL\16\bin\pg_restore.exe" -U postgres -h localhost -d happy_alpha --clean --if-exists "C:\HappyAlpha-Backups\happy-alpha-AAAAMMDD-HHMM.dump"
   ```
3. Rode `windows\REINICIAR.bat`.

## Atualizar o sistema (quando houver versão nova)

1. Faça um backup (`BACKUP-AGORA.bat`).
2. Substitua as pastas `server` e `web` pelas novas. **Não apague** o `.env`, o `.env.demo` nem a pasta `data`.
3. Abra o Prompt de Comando em `C:\HappyAlpha` e rode `npm ci --omit=dev -w server`.
4. Rode `windows\REINICIAR.bat`. As mudanças no banco são aplicadas sozinhas.

## Problemas comuns

| Sintoma | O que fazer |
|---|---|
| Faixa vermelha "Sem conexão" | Confira o Wi-Fi do tablet e se o computador do caixa está ligado. |
| Tablet não abre o sistema | O IP do computador mudou: veja o IP novo (`ipconfig`) e reserve no roteador (passo 5). |
| Alerta de "pronto" sem som | Clique na faixa "Toque aqui para ativar o som" no caixa. Na cozinha, toque em "Iniciar turno". Confira o volume. |
| Sistema não abre em `localhost:3010` | Rode `windows\REINICIAR.bat`. Se continuar, veja `data\servidor.log`. |
| Backup falhou | Confira se o pendrive está conectado e se a pasta existe. O resultado aparece no Histórico. |
