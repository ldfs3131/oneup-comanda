# Prompt — APQR com o mesmo fluxo de atualização do ONE UP Comanda

Cole na conversa do APQR (Claude). Antes, crie no GitHub (conta `ldfs3131`) um repositório **privado** e **vazio**
chamado `apqr` (sem README) e libere-o para o Claude em https://github.com/apps/claude/installations/select_target
→ Configure → "Only select repositories" → adicionar `apqr` → Save.

---

Quero que o APQR passe a ser alterado e atualizado do mesmo jeito que o meu sistema de restaurante (ONE UP Comanda):
eu peço a mudança aqui no chat, você altera, testa e envia para o meu GitHub; no servidor eu rodo UM comando que
baixa a versão nova com segurança. Faça isso de forma completa e sem me pedir decisões que você pode tomar sozinho.

## Contexto

- O APQR já está online e em fase de teste, numa VPS Hostinger KVM 1 (Ubuntu 24.04) que também hospeda o sistema
  de restaurante (`/opt/oneup`, Nginx `zz-oneup-comanda.conf`, PostgreSQL, usuário `oneup`), o Lava Jato (Nginx + PM2)
  e, futuramente, o site da ONE UP. Nada desses outros sistemas pode ser tocado.
- Eu NÃO sou programador. Comandos que eu rodar no servidor devem ser copiados e colados, um por vez, com o que
  devo ver se deu certo.
- Repositório do APQR no GitHub: `ldfs3131/apqr` (privado, vazio, já liberado para o Claude). Ramo principal `main`.
- Modelo a seguir: o restaurante tem o comando `oneup` com `oneup atualizar`, `oneup backup`, `oneup restaurar`,
  `oneup status`, `oneup logs`, `oneup backup-externo` (cópia cifrada no Google Drive) e um vigia que avisa no
  WhatsApp. Quero o equivalente para o APQR, com o nome `apqr`.

## O que você deve fazer, nesta ordem

### 1. Código no GitHub
- Confira que o projeto está completo, compilado e sem segredos no código (senhas, chaves, tokens ficam só no `.env`
  do servidor; o `.env` entra no `.gitignore`; crie um `.env.exemplo` documentado).
- Envie tudo para `ldfs3131/apqr`, ramo `main`, com uma tag de versão (ex.: `v1.0.0`). Me confirme o endereço.
- O repositório deve conter o sistema **já compilado** (pastas `dist`/`build` versionadas): o servidor nunca deve
  compilar nem instalar ferramentas de desenvolvimento; o KVM 1 é compartilhado e um build pode estourar a memória.

### 2. Comando `apqr` no servidor (arquivo `deploy/apqr` no repositório)
Um único script de administração, em português, com estes subcomandos:
- `apqr status` — no ar? versão, última cópia (servidor e Google Drive), cadeado HTTPS, memória e disco.
- `apqr atualizar` — o coração do fluxo. Regras obrigatórias:
  1. `git fetch` do GitHub; se já estiver na versão mais nova, dizer isso e parar.
  2. Fazer cópia de segurança do banco ANTES; sem cópia, não atualiza.
  3. Trocar o código para a versão nova e instalar só dependências de produção (até 3 tentativas).
  4. Reiniciar o serviço e esperar ele responder (checagem de saúde por até 90 s).
  5. Se a versão nova não ligar: voltar automaticamente para a versão anterior, reinstalar as dependências dela,
     reiniciar e confirmar que voltou. Dados preservados. Se nem a anterior ligar, dizer qual cópia restaurar.
  6. Marcar "manutenção" durante a atualização para o vigia não avisar "fora do ar" à toa.
  7. No fim, conferir que a versão no ar é a mesma do código baixado.
- `apqr backup` — cópia do banco agora (e automática todo dia às 03:40, guardando 14 dias).
- `apqr restaurar <arquivo>` — volta o banco para uma cópia (faz cópia do estado atual antes; pede confirmação).
- `apqr backup-externo configurar|agora|listar` e `apqr restaurar-externo <nome>` — cópia diária cifrada
  (AES-256, frase guardada só no servidor e comigo) enviada ao Google Drive da ONE UP via rclone, na pasta
  `ONEUP-backups/apqr/` (30 diárias + 12 mensais). Pode reutilizar a autorização do rclone já feita para o
  restaurante, se existir no servidor.
- `apqr alertas configurar` e `apqr alerta teste` — avisos no meu WhatsApp (CallMeBot) quando: cópia falhou,
  sistema fora do ar, disco acima de 85 %, certificado vencendo, última cópia com mais de 26 h. Vigia a cada 5 min,
  sem repetir o mesmo aviso por 6 h, e avisa quando voltar.
- `apqr logs`, `apqr reiniciar`, `apqr certificado`, `apqr acessos`, `apqr versao`, `apqr ajuda`.

### 3. Instalador/adaptador (`deploy/instalar.sh`)
Como o APQR já está no servidor, o script deve **adaptar a instalação existente** sem perder dados nem parar os
outros sistemas: mover (ou apontar) o código para um clone do GitHub, criar/ajustar o serviço do systemd com
reinício automático e `TimeoutStopSec`, instalar o comando `apqr` em `/usr/local/bin`, os timers de cópia e vigia,
e manter o site no Nginx como está (sem virar `default_server`). Deve poder rodar de novo sem efeitos colaterais.
Antes de qualquer coisa, fazer uma cópia completa do estado atual.

### 4. Convivência no servidor compartilhado
- Nunca usar a porta de outro sistema (conferir os sites do Nginx e o PM2, mesmo com eles desligados).
- Não mudar fuso horário, firewall, Node do sistema, PM2 nem arquivos de outros sites.
- Serviço com usuário próprio sem privilégios; banco só escuta dentro do servidor.
- Limites de memória no serviço do systemd compatíveis com o KVM 1 compartilhado.

### 5. Ensaio antes de me entregar
Ensaie tudo num ambiente igual ao servidor (Ubuntu 24.04 com um Nginx e um PM2 de mentira ocupando portas):
instalar/adaptar, `apqr atualizar` com versão boa, `apqr atualizar` com uma versão quebrada (tem de voltar
sozinho), `apqr backup` e `apqr restaurar`, `apqr backup-externo`, `apqr alerta teste`. Me mostre o resultado.

### 6. Entrega
- `docs/INSTALACAO-ONLINE.md`: guia em português simples, com a tabela de comandos e "o que fazer em cada aviso".
- Passo a passo para mim, no terminal da Hostinger: chave de leitura do GitHub (deploy key, sem escrita), um
  comando de adaptação e as conferências finais. Nunca me peça para colar senhas, tokens ou a frase das cópias
  no chat.
- A partir daí, o fluxo fixo é: eu peço a mudança → você altera, roda os testes, envia ao GitHub e me diz
  "pronto, rode `apqr atualizar`" → eu rodo e te mando a tela se der erro.

Decisões técnicas não cobertas aqui: decida como um comitê de especialistas em infraestrutura decidiria, priorizando
não perder dados e não derrubar os outros sistemas. Comece pelo item 1.
