# ONE UP online — instalação na VPS (Hostinger)

Tudo roda num servidor só: banco (PostgreSQL), sistema (Node.js) e HTTPS automático (Caddy).
Cada restaurante tem o próprio endereço: `https://<restaurante>.<endereço-base>`.

## O que contratar

- **VPS Hostinger KVM 1** (ou maior), sistema **Ubuntu 24.04** puro (sem painel nem aplicativo pré-instalado).
- Domínio é opcional. Sem domínio, o endereço-base é automático: `<IP-com-traços>.sslip.io`
  (ex.: `https://happy-alpha.203-0-113-5.sslip.io`). Com domínio, veja "Trocar para domínio próprio".

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
Elas ficam guardadas no servidor: `oneup acessos`.

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
| `oneup logs` | últimos registros, para o suporte |

Cópia fora do servidor (recomendado 1×/mês): baixe o arquivo mais novo de `/opt/oneup/backups` pelo
gerenciador de arquivos/SFTP e guarde no Google Drive.

## Trocar para domínio próprio

1. No DNS do domínio: registro **A** de `*.restaurantes.seudominio.com.br` apontando para o IP da VPS.
2. Na VPS: `DOMINIO=restaurantes.seudominio.com.br bash /opt/oneup/app/deploy/instalar.sh`
3. O endereço do Happy Alpha passa a ser `https://happy-alpha.restaurantes.seudominio.com.br`
   (refaça o QR Code em Configurações e avise o Rafael; o endereço antigo deixa de funcionar).

## Segurança (já configurado)

- Só as portas 22 (SSH), 80 e 443 abertas; banco só escuta dentro do servidor.
- Sistema roda com usuário próprio sem privilégios; só escreve na pasta de imagens.
- Certificado HTTPS emitido só para endereço de restaurante que existe.
- Cada restaurante isolado no banco (RLS): um nunca vê dado do outro.
- Senhas e cópias de segurança só o root lê.
