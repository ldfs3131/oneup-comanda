# Prompt — Religar o servidor ao GitHub e atualizar o ONE UP Comanda (para usar no ChatGPT)

Cole tudo abaixo da linha no ChatGPT. Não precisa anexar arquivo.

---

Você é meu engenheiro de infraestrutura e vai me guiar, um passo por vez, para religar meu servidor ao GitHub e
atualizar um sistema. Eu não sou programador: explique em português simples, mostre o comando num bloco para eu
copiar, diga o que devo ver se deu certo e espere eu mandar o print antes do próximo passo.

## Cenário

- VPS Hostinger (Ubuntu 24.04). Uso o "Terminal do navegador" do painel da Hostinger, que já entra como root.
- Sistema: **ONE UP Comanda**, instalado em `/opt/oneup/app`, com o comando `oneup` para administrar.
- O código vem do meu GitHub: repositório privado **`ldfs3131/oneup-comanda`**, ramo `main`.
- O servidor baixa o código com uma **chave de leitura** (deploy key) guardada em `/root/.ssh/oneup_github`
  (a parte pública é `/root/.ssh/oneup_github.pub`).
- **Problema:** `oneup atualizar` dá `git@github.com: Permission denied (publickey)`. A chave existe no servidor, mas o
  GitHub não a aceita mais (provavelmente foi removida da lista de chaves do repositório).
- No mesmo servidor também estão o sistema **APQR** (chaves `/root/.ssh/apqr_deploy` e `/root/.ssh/apqr_producao`) e
  um sistema de lava-jato. **Nada deles pode ser tocado.**
- Objetivo final: o servidor na versão **3.3.2** e a **atualização automática** ligada.

## Regras invioláveis

1. **Não mexa nas chaves do APQR** (`apqr_deploy`, `apqr_producao`) nem nas chaves dele no GitHub. Não apague
   nenhuma chave de nenhum repositório.
2. Não edite arquivos do sistema, não rode `apt upgrade`, `do-release-upgrade`, `reboot`, `pm2`, nem mude firewall.
3. A chave do restaurante é **só de leitura**: no GitHub, **nunca** marque "Allow write access".
4. **Nunca** me peça para colar a chave **privada** (arquivo sem `.pub`) no chat ou no GitHub. Só a pública (`.pub`).
5. Um passo por mensagem. Não invente comandos fora deste roteiro; se algo sair do previsto, peça o print e diga
   "isso precisa do suporte do sistema".

## Roteiro

**Passo 1 — Mostrar a chave pública do restaurante.**
```
cat /root/.ssh/oneup_github.pub
```
Deve aparecer uma linha começando com `ssh-ed25519` (normalmente terminando em `vps-oneup`). Eu copio essa linha.

**Passo 2 — Cadastrar no GitHub.** Logado como `ldfs3131`, abrir
`https://github.com/ldfs3131/oneup-comanda/settings/keys` → **Add deploy key** → Title `VPS` → colar a linha →
**sem** marcar "Allow write access" → **Add key**.
- Se o GitHub disser **"Key is already in use"**: essa chave está em outro repositório (provavelmente o `apqr`).
  **Não remova de lá.** Vá para o Passo 2B.
- Se aceitou: vá para o Passo 3.

**Passo 2B — (só se deu "Key is already in use") Criar uma chave nova só para o restaurante.**
```
ssh-keygen -t ed25519 -N "" -q -f /root/.ssh/oneup_comanda_github -C vps-oneup-comanda && cat /root/.ssh/oneup_comanda_github.pub
```
Cadastrar essa linha nova no GitHub como no Passo 2 (Title `VPS restaurante`, sem escrita). Depois apontar o sistema
para a chave nova:
```
git -C /opt/oneup/app config core.sshCommand "ssh -i /root/.ssh/oneup_comanda_github -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
```
Nos passos seguintes, use `/root/.ssh/oneup_comanda_github` no lugar de `/root/.ssh/oneup_github`.

**Passo 3 — Gravar a chave no sistema (para as próximas atualizações) e testar.**
```
git -C /opt/oneup/app config core.sshCommand "ssh -i /root/.ssh/oneup_github -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"; ssh -i /root/.ssh/oneup_github -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -T git@github.com
```
(Se veio do Passo 2B, troque `oneup_github` por `oneup_comanda_github` nos dois lugares.)
Deu certo se aparecer: **"Hi ldfs3131/oneup-comanda! You've successfully authenticated, but GitHub does not provide
shell access."** Se aparecer "Hi ldfs3131/apqr!", a chave está no repositório errado: volte ao Passo 2B.
Se continuar "Permission denied", peça o print da página de Deploy keys do repositório.

**Passo 4 — Atualizar o sistema.**
```
oneup atualizar
```
Leva de 1 a 3 minutos (faz cópia de segurança antes e volta sozinho se a versão nova não ligar).
Deu certo se terminar com **"Versão no ar confere: 3.3.2."**

**Passo 5 — Conferir a atualização automática e a saúde.**
```
oneup atualizacao-automatica status; oneup status
```
Deve aparecer **"Ligada (todo dia às 04:10)"**, "Sistema respondendo" e a versão 3.3.2.

**Passo 6 — Conferir no navegador.** Abrir `https://happy-alpha.comanda.oneupsistemas.com.br`, entrar com o login do
Dono e abrir **Financeiro**: devem aparecer os gráficos "Acompanhamento do mês", "Semana a semana" e
"O que o cliente compra". Se aparecer a tela antiga, recarregar com Ctrl+Shift+R.

**Passo 7 — Resumo.** Me diga em 3 linhas: versão no ar, atualização automática ligada, e que **não** é para rodar
`oneup zerar` agora (ele é só para sexta, antes da entrega ao cliente).

Comece pelo Passo 1.
