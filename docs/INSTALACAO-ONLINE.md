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

Leva de 3 a 6 minutos. No fim aparecem o endereço e as senhas (Dono, Caixa, Cozinha e o acesso ONE UP).
Elas ficam guardadas no servidor: `oneup acessos`. Se o DNS ainda não estiver valendo, o instalador avisa:
espere uns minutos e rode `oneup certificado` (o login só funciona com o cadeado/HTTPS).

O instalador pode rodar de novo a qualquer momento: não apaga dados nem troca senhas.

## Dia a dia (no terminal da VPS)

| Comando | Para quê |
|---|---|
| `oneup status` | está no ar? endereço, versão, última cópia, disco |
| `oneup atualizar` | baixa a versão nova (faz cópia antes; se a nova não ligar, volta sozinho) |
| `oneup backup` | cópia agora (automática todo dia às 03:30, guarda 14 dias em `/opt/oneup/backups`) |
| `oneup restaurar <arquivo>` | volta o banco para uma cópia (faz cópia do estado atual antes) |
| `oneup senha happy-alpha caixa` | senha nova para quem esqueceu (derruba os aparelhos conectados) |
| `oneup nova-empresa bom-sabor "Bom Sabor"` | cria outro restaurante (endereço próprio, cardápio em branco) |
| `oneup certificado` | HTTPS dos restaurantes (confere o DNS antes; renova sozinho) |
| `oneup logs` | últimos registros, para o suporte |

Cópia fora do servidor (recomendado 1×/mês): baixe o arquivo mais novo de `/opt/oneup/backups` pelo
gerenciador de arquivos/SFTP e guarde no Google Drive.

## Outro endereço-base

`DOMINIO=outro.dominio.com.br bash /opt/oneup/app/deploy/instalar.sh` (com o `*.outro` no DNS). Para testar sem
domínio: `DOMINIO=sslip` (vira `<IP>.sslip.io`). Trocar o endereço muda o link e o QR Code dos restaurantes.

## Segurança (já configurado)

- Banco só escuta dentro do servidor; em servidor só do ONE UP Comanda, firewall com só 22, 80 e 443.
- Sistema roda com usuário próprio sem privilégios; só escreve na pasta de imagens.
- Certificado HTTPS emitido só para endereço de restaurante que existe.
- Cada restaurante isolado no banco (RLS): um nunca vê dado do outro.
- Senhas e cópias de segurança só o root lê.
