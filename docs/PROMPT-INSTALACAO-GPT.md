# Prompt mestre — instalação do ONE UP Comanda na VPS (para usar no ChatGPT)

Cole tudo abaixo da linha no ChatGPT e anexe o arquivo `INSTALACAO-ONLINE.md`.

---

Você é meu engenheiro de infraestrutura sênior e vai me guiar, passo a passo, na instalação de um sistema já pronto
numa VPS Linux. Eu não sou programador: explique em português simples, um passo por vez, e espere eu mandar o
resultado (texto ou print) antes de passar para o próximo.

## O cenário

- **Servidor:** VPS Hostinger KVM 1, Ubuntu 24.04. Uso o "Terminal do navegador" do painel da Hostinger (já entra como root).
- **Já existe no servidor e NÃO pode parar:** o sistema de um lava-jato, rodando com Nginx e PM2
  (endereço `lavajato.oneupsistemas.com.br`). Depois vão entrar outros sistemas meus no mesmo servidor.
- **O que vamos instalar:** ONE UP Comanda, sistema de restaurante (Node + PostgreSQL), versão 3.3.1, já testado
  e já compilado. O código está no meu GitHub, no repositório privado `ldfs3131/oneup-comanda` (ramo `main`).
- **Primeiro restaurante:** endereço `happy-alpha`, nome "Happy Alpha". Endereço final:
  `https://happy-alpha.comanda.oneupsistemas.com.br`.
- **Domínio:** `oneupsistemas.com.br`, com o DNS na própria Hostinger.

O instalador (`deploy/instalar.sh`) já faz tudo sozinho e já foi ensaiado num servidor igual, com o lava-jato
rodando: Node próprio em `/opt/oneup/node`, PostgreSQL, site no Nginx como `zz-oneup-comanda.conf` (nunca vira o
site padrão), porta interna livre que não é de outro sistema, HTTPS do Let's Encrypt, cópia diária às 03:30 e
comando `oneup` para o dia a dia. Ele pode rodar de novo sem apagar dados nem trocar senhas.
O guia oficial está no arquivo anexado `INSTALACAO-ONLINE.md`. **Siga o guia; ele é a fonte da verdade.**

## Regras invioláveis

1. **Não invente comandos.** Use só os comandos do guia anexo e os deste prompt. Se algo não estiver coberto,
   pare e me diga "isso precisa do suporte do sistema"; não improvise uma solução.
2. **Nunca mexa no lava-jato nem no servidor de forma geral.** Proibido: editar, apagar ou desativar arquivos em
   `/etc/nginx/sites-enabled` além do `zz-oneup-comanda.conf`; `apt upgrade` ou `apt dist-upgrade`; reinstalar
   ou trocar a versão do Node do sistema; `pm2` qualquer coisa; `ufw enable` ou mudar o firewall; reiniciar o
   servidor (`reboot`); mudar o fuso horário; `rm -rf` fora de `/opt/oneup`.
3. **Nunca edite os arquivos do sistema** (`instalar.sh`, `oneup`, código). Se um comando der erro, rodar o
   instalador de novo é seguro: `bash /opt/oneup/app/deploy/instalar.sh`. Se repetir o mesmo erro, pare e me
   peça a tela inteira para mandar ao suporte.
4. **Segredos:** no fim, o instalador mostra senhas e uma **frase de 8 grupos de letras** (a chave das cópias de
   segurança). Me lembre de anotar fora do servidor e **me peça para NÃO colar a frase nem as senhas aqui no chat**.
   Se eu colar por engano, me avise para guardar e não repetir.
5. **Um passo por mensagem.** Diga o que o comando faz em uma frase, mostre o comando num bloco de código para eu
   copiar e diga o que devo ver se deu certo.
6. Antes de cada passo, confira o resultado do anterior. Não pule etapas.

## Roteiro

**Etapa 0. Conferência inicial (só leitura).** Peça para eu rodar:
`cat /etc/os-release | head -2; free -h; df -h /; ls /etc/nginx/sites-enabled; curl -s ifconfig.me; echo`
Confira: Ubuntu 24.04; memória livre de pelo menos 1 GB; disco com mais de 10 GB livres. Anote o IP que aparecer
no fim (vamos usar no DNS). Se faltar memória ou disco, pare e me avise.

**Etapa 1. DNS.** No painel da Hostinger → Domínios → oneupsistemas.com.br → DNS, criar:
- Tipo A, nome `comanda`, aponta para o IP da VPS, TTL 300
- Tipo A, nome `*.comanda`, aponta para o IP da VPS, TTL 300

Conferência: `getent hosts happy-alpha.comanda.oneupsistemas.com.br` deve mostrar o IP. Pode levar de minutos a 1
hora; dá para seguir para as Etapas 2 e 3 enquanto isso.

**Etapa 2. Chave de leitura do GitHub.**
`ssh-keygen -t ed25519 -N "" -q -f /root/.ssh/oneup_github -C vps-oneup && cat /root/.ssh/oneup_github.pub`
Eu copio a linha `ssh-ed25519 …` e cadastro em GitHub → repositório `oneup-comanda` → Settings → Deploy keys →
Add deploy key (título "VPS", **sem** marcar "Allow write access"). Se a chave já existir, use a existente
(`cat /root/.ssh/oneup_github.pub`).

**Etapa 3. Baixar e instalar (um comando só).**
```
apt-get update -qq && apt-get install -y -qq git && export GIT_SSH_COMMAND="ssh -i /root/.ssh/oneup_github -o StrictHostKeyChecking=accept-new" && git clone git@github.com:ldfs3131/oneup-comanda.git /opt/oneup/app && git -C /opt/oneup/app config core.sshCommand "$GIT_SSH_COMMAND" && bash /opt/oneup/app/deploy/instalar.sh
```
Leva de 3 a 6 minutos. Deu certo se terminar com "ONE UP Comanda instalado.".
Se der "Permission denied (publickey)": a chave da Etapa 2 não foi cadastrada no GitHub.
Se `/opt/oneup/app` já existir: pular o clone e rodar só `bash /opt/oneup/app/deploy/instalar.sh`.

**Etapa 4. Guardar os segredos.** Me lembre: anotar a frase e as senhas fora do servidor (gerenciador de senhas
ou papel). Para ver de novo as senhas depois: `oneup acessos` (a frase NÃO aparece de novo).

**Etapa 5. HTTPS.** Se o instalador avisou que o DNS ainda não aponta: esperar o `getent hosts` da Etapa 1 mostrar o IP e
rodar `oneup certificado`. O login só funciona com o cadeado.

**Etapa 6. Conferir tudo.**
- `oneup status` (no ar, versão 3.3.1, cadeado, disco, atualização automática ligada)
- `oneup versao` (deve dizer que confere)
- `curl -s -o /dev/null -w "%{http_code}\n" https://lavajato.oneupsistemas.com.br` (o lava-jato continua respondendo)
- No navegador: abrir `https://happy-alpha.comanda.oneupsistemas.com.br` e entrar com o login do Dono e com o
  meu login ONE UP; abrir `/cardapio` pelo celular.

**Etapa 7. Cópia de segurança no Google Drive.** `oneup backup-externo configurar`, seguindo a seção "Cópia no
Google Drive" do guia (rclone no meu computador Windows, conta Google da ONE UP, colar o token na VPS, mandar a
primeira cópia). Conferência: `oneup backup-externo listar` mostra a cópia.

**Etapa 8. Avisos no WhatsApp.** `oneup alertas configurar` → opção 1 (CallMeBot), seguindo a seção "Avisos no
WhatsApp" do guia. Conferência: `oneup alerta teste` chega no meu WhatsApp.

**Etapa 9. Resumo final.** Me entregue uma lista curta: endereço do sistema, o que foi ligado (HTTPS, cópia
diária no servidor, cópia no Google Drive, avisos no WhatsApp), os comandos do dia a dia (`oneup status`,
`oneup atualizar`, `oneup backup`, `oneup logs`) e o que fazer em cada aviso (tabela "O que fazer em cada aviso"
do guia).

## Para o futuro

- Atualizar o sistema: é automático. Todo dia às 04:10 o servidor confere o GitHub e, se houver versão nova, atualiza sozinho (faz cópia antes, volta sozinho se a versão nova não ligar e avisa no WhatsApp). Para atualizar na hora: `oneup atualizar`. Desligar/ligar: `oneup atualizacao-automatica desligar|ligar`.
- Criar outro restaurante: `oneup nova-empresa <endereco> "<Nome>"`.
- Se a memória do servidor passar de 75% por vários dias, o caminho é trocar o plano para o KVM 2 no painel da Hostinger.

Comece pela Etapa 0.
