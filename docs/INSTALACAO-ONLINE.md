# ONE UP Comanda online — instalação na VPS (Hostinger)

Cada restaurante tem o próprio endereço: `https://<restaurante>.comanda.oneupsistemas.com.br`
(o Happy Alpha: `https://happy-alpha.comanda.oneupsistemas.com.br`).

**Convive com o que já está na VPS** (ex.: o Lava Jato com Nginx e PM2): se o servidor já tem Nginx, o
ONE UP Comanda entra como mais um site no Nginx, com certificado do Let's Encrypt; usa um Node próprio
(em `/opt/oneup/node`, sem mexer no Node dos outros sistemas), escolhe uma porta interna livre e não liga
firewall por conta própria. Em servidor vazio, usa o Caddy (HTTPS automático).

## Antes: DNS (uma vez)

No hPanel da Hostinger → **Domínios → oneupsistemas.com.br → DNS / Nameservers**, crie:

| Tipo | Nome | Aponta para | TTL |
|---|---|---|---|
| A | `*.comanda` | IP da VPS | 300 |
| A | `comanda` | IP da VPS | 300 |

O `*.comanda` faz qualquer restaurante novo já ter endereço. Leva de minutos a 1 hora para valer.

## Instalar (uma vez)

No hPanel da Hostinger: **VPS → Terminal do navegador** (já entra como root).

**1. Chave de acesso ao repositório (só leitura).** Cole e dê Enter:

```bash
ssh-keygen -t ed25519 -N "" -q -f /root/.ssh/oneup_github -C vps-oneup && cat /root/.ssh/oneup_github.pub
```

Copie a linha que começa com `ssh-ed25519` e cadastre no GitHub: repositório → **Settings → Deploy keys →
Add deploy key** (deixe *Allow write access* desmarcado). Ou mande para a ONE UP cadastrar.

**2. Baixar e instalar.** Troque `USUARIO/REPOSITORIO` e cole:

```bash
apt-get update -qq && apt-get install -y -qq git && export GIT_SSH_COMMAND="ssh -i /root/.ssh/oneup_github -o StrictHostKeyChecking=accept-new" && git clone git@github.com:USUARIO/REPOSITORIO.git /opt/oneup/app && git -C /opt/oneup/app config core.sshCommand "$GIT_SSH_COMMAND" && bash /opt/oneup/app/deploy/instalar.sh
```

Leva de 3 a 6 minutos. No fim aparecem o endereço e as senhas (Dono, Caixa, Cozinha e o acesso ONE UP)
e a **frase das cópias de segurança** (8 grupos de letras, ex.: `abcde-fghij-…`). **Anote a frase na hora,
fora do servidor** (gerenciador de senhas ou papel): ela aparece só essa vez e sem ela as cópias do
Google Drive não abrem — nem a ONE UP consegue recuperar.
Elas ficam guardadas no servidor: `oneup acessos`. Se o DNS ainda não estiver valendo, o instalador avisa:
espere uns minutos e rode `oneup certificado` (o login só funciona com o cadeado/HTTPS).

O instalador pode rodar de novo a qualquer momento: não apaga dados, não troca senhas, **não reescreve o
`.env`** (o que já está lá fica; só entram as linhas novas — cópia de antes em `/opt/oneup/estado/env.antes-da-instalacao`)
e **não reinicia o sistema se nada mudou**. No Nginx, o site do ONE UP se chama `zz-oneup-comanda.conf` (fica por
último na ordem alfabética, nunca vira o site "padrão" no lugar do Lava Jato). Se nenhum site do servidor estiver
marcado como padrão (`default_server`), o instalador só avisa — não mexe nos outros sistemas.

**Depois de instalar, ligue as duas proteções (5 minutos cada):**
1. `oneup backup-externo configurar` — cópia diária no Google Drive da ONE UP (veja abaixo).
2. `oneup alertas configurar` — avisos no seu WhatsApp quando algo der errado (veja abaixo).

## Dia a dia (no terminal da VPS)

| Comando | Para quê |
|---|---|
| `oneup status` | está no ar? endereço, versão, última cópia (servidor e Google Drive), avisos, cadeado, disco |
| `oneup atualizar` | baixa a versão nova agora (faz cópia antes; se a nova não ligar, volta sozinho) |
| `oneup atualizacao-automatica status` | a atualização sozinha de madrugada está ligada? qual foi a última? (`ligar` / `desligar`) |
| `oneup backup` | cópia agora no servidor (automática todo dia às 03:30, guarda 14 dias em `/opt/oneup/backups`) |
| `oneup restaurar <arquivo>` | volta o banco para uma cópia do servidor (faz cópia do estado atual antes) |
| `oneup backup-externo agora` | faz uma cópia e manda para o Google Drive agora |
| `oneup backup-externo listar` | mostra as cópias que estão no Google Drive |
| `oneup restaurar-externo <nome>` | baixa uma cópia do Google Drive, abre com a frase e volta o banco |
| `oneup alerta teste` | manda um aviso de teste para o seu WhatsApp/e-mail |
| `oneup versao` | confere se a versão no ar é a mesma que foi baixada |
| `oneup senha happy-alpha caixa` | senha nova para quem esqueceu (derruba os aparelhos conectados) |
| `oneup nova-empresa bom-sabor "Bom Sabor"` | cria outro restaurante (endereço próprio, cardápio em branco) |
| `oneup certificado` | HTTPS dos restaurantes (confere o DNS antes; renova sozinho) |
| `oneup logs` | últimos registros, para o suporte |

## Atualização automática (ligada de fábrica)

Todo dia às **04:10** o servidor confere o GitHub. Se houver versão nova, ele mesmo roda o `oneup atualizar`: faz a
cópia de segurança antes, instala e, se a versão nova não ligar, volta sozinho para a anterior. O resultado chega no
WhatsApp ("atualizado para a versão X" ou "falhou e voltou para a anterior").
- Se teve pedido nos últimos 20 minutos (restaurante aberto até tarde), ele não mexe e tenta na madrugada seguinte.
- Uma versão que falhou não é tentada de novo toda noite: o servidor espera a correção chegar.
- Precisa na hora (erro no meio do expediente)? `oneup atualizar`. Não quer automático? `oneup atualizacao-automatica desligar`.

## Cópia no Google Drive (fora do servidor)

Todo dia, logo depois da cópia das 03:30, o servidor **tranca a cópia com a sua frase** (criptografia AES-256)
e manda para a pasta `ONEUP-backups` do Google Drive da ONE UP. Se a VPS sumir, os dados estão lá.
Ficam guardadas as **30 últimas diárias** (pasta `diarias`) e **a primeira de cada mês por 12 meses** (pasta
`mensais`). Cada envio é conferido (tamanho e assinatura do arquivo) antes de ser dado como feito.

**Ligar (uma vez):** `oneup backup-externo configurar` e siga a tela. Resumo do que ela pede:
1. No **seu computador**, baixe o rclone em https://rclone.org/downloads/ (Windows: "Intel/AMD - 64 Bit"),
   descompacte, abra a pasta, botão direito → "Abrir no Terminal".
2. Cole o comando que aparece na tela da VPS (começa com `./rclone authorize "drive"`). O navegador abre: entre
   com a conta Google da ONE UP e clique em **Permitir**. O servidor só enxerga a pasta de cópias que ele mesmo
   criar — o resto do seu Drive fica invisível para ele.
3. O terminal do seu computador mostra um texto `{"access_token": … }`: copie e cole na tela da VPS.
4. Ela testa, liga e pergunta se já quer mandar a primeira cópia (diga sim).

Sem isso configurado, a cópia no servidor continua normal e o `oneup status` mostra
"Cópia externa NÃO configurada".

**Voltar uma cópia do Drive:** `oneup backup-externo listar` (mostra os nomes) e
`oneup restaurar-externo oneup-2026-10-04_033012.tar.gpg`. Ele baixa, abre com a frase, faz uma cópia do estado
atual antes, pede para digitar RESTAURAR e pergunta se quer voltar também as fotos dos produtos.

**Servidor novo (a VPS antiga sumiu):** instale normalmente, rode `oneup backup-externo configurar` (quando
perguntar a frase, **cole a frase antiga**) e depois `oneup restaurar-externo <nome>`. Se o servidor já tiver
criado uma frase nova, o restaurar percebe e pede a frase antiga na hora.

**Abrir uma cópia no seu computador (emergência):** baixe o arquivo `.tar.gpg` do Drive e abra com o GnuPG
(Windows: Gpg4win/Kleopatra → "Decifrar", usando a frase). Dentro há o banco (`.dump`) e as fotos (`.tar.gz`).

## Avisos no WhatsApp

O servidor manda mensagem quando: **a cópia de segurança falhou**, **o disco passou de 85%**, **a última cópia
(no servidor ou no Drive) tem mais de 26 horas**, **o cadeado HTTPS vence em menos de 14 dias** ou **o sistema
saiu do ar** (conferido de hora em hora, com uma segunda tentativa 1 minuto depois; e na hora, se o sistema
cair e não religar sozinho). O mesmo aviso não se repete por 6 horas. Quando o sistema volta, chega
"voltou a responder normalmente".

**Ligar:** `oneup alertas configurar` e escolha:
- **1) WhatsApp (CallMeBot, grátis):** no celular, abra https://www.callmebot.com/blog/free-api-whatsapp-messages/,
  salve o número do CallMeBot que aparece lá, mande para ele pelo WhatsApp `I allow callmebot to send me messages`
  e espere a resposta com a **apikey**. Na VPS, informe seu número (ex.: `5561999998888`) e a apikey.
- 2) Telegram (um robô seu, criado no @BotFather), 3) app ntfy, 4) uma URL pronta com `{msg}`, 5) e-mail
  (só funciona se o servidor tiver programa de e-mail configurado — peça ao suporte).

No fim ele manda uma mensagem de teste. Para testar de novo: `oneup alerta teste`. Os envios ficam
registrados em `/var/log/oneup-alertas.log`. A configuração fica no `.env` (`ALERTA_URL`, `ALERTA_EMAIL`).

## O que fazer em cada aviso

| Aviso | O que fazer |
|---|---|
| **A cópia de segurança falhou** | No terminal da VPS: `oneup backup`. Se der erro, mande a tela para o suporte. Se a cópia local deu certo e só o envio falhou: `oneup backup-externo agora`. |
| **Nenhuma cópia chega no Google Drive há X h** | `oneup backup-externo agora`. Se falar de autorização/token, rode `oneup backup-externo configurar` (refaz a ligação com o Google; a frase continua a mesma). |
| **A última cópia é de X h atrás** | `oneup backup` e depois `oneup status`. Se o backup automático parou, rode o instalador de novo (religa o relógio das cópias). |
| **Disco com X% ocupado** | `oneup status` mostra o tamanho da pasta de cópias. Não apague nada do Lava Jato. Chame o suporte para limpar ou aumente o plano da VPS na Hostinger. |
| **O cadeado (HTTPS) vence em X dias** | `oneup certificado`. Se der erro de DNS, confira o registro `*.comanda` no painel da Hostinger. |
| **O sistema está FORA DO AR / CAIU** | `oneup reiniciar`. Se não voltar: `oneup logs` e mande a tela para o suporte. Se a resposta for 503, o banco parou: `sudo systemctl restart postgresql` e `oneup reiniciar`. |

## Outro endereço-base

`DOMINIO=outro.dominio.com.br bash /opt/oneup/app/deploy/instalar.sh` (com o `*.outro` no DNS). Para testar sem
domínio: `DOMINIO=sslip` (vira `<IP>.sslip.io`). Trocar o endereço muda o link e o QR Code dos restaurantes.

## Segurança (já configurado)

- Banco só escuta dentro do servidor; em servidor só do ONE UP Comanda, firewall com só 22, 80 e 443.
- O sistema entra no banco com um usuário próprio (`oneup_app_login`) que **não consegue desligar o isolamento**
  entre restaurantes (sem BYPASSRLS); o usuário dono do banco fica só para atualizações e para a plataforma.
- Cópias no Google Drive trancadas com a sua frase (AES-256); a frase fica só no servidor (`/opt/oneup/.chave-backup`,
  só o root lê) e com você.
- Sistema roda com usuário próprio sem privilégios; só escreve na pasta de imagens.
- Certificado HTTPS emitido só para endereço de restaurante que existe.
- Cada restaurante isolado no banco (RLS): um nunca vê dado do outro.
- Senhas e cópias de segurança só o root lê.
