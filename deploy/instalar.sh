#!/usr/bin/env bash
# =====================================================================================
#  ONE UP Comanda — instalação online numa VPS Ubuntu 24.04 (Hostinger KVM ou similar)
#
#  Uso (como root, com o sistema já baixado em /opt/oneup/app):
#     bash /opt/oneup/app/deploy/instalar.sh
#  Opções (variáveis de ambiente, todas opcionais):
#     DOMINIO=comanda.oneupsistemas.com.br   endereço base (padrão). Cada restaurante: <empresa>.<DOMINIO>
#                                            DOMINIO=sslip usa <IP>.sslip.io (teste sem domínio)
#     EMAIL=voce@exemplo.com                 aviso de vencimento do certificado HTTPS
#     EMPRESA=happy-alpha  NOME="Happy Alpha"  primeira empresa criada
#
#  Convive com o que já está no servidor: se já houver Nginx (ex.: outro sistema com PM2), usa o Nginx
#  com certificado do Let's Encrypt; em servidor vazio, usa o Caddy. Tem o próprio Node (não mexe no Node
#  dos outros sistemas), escolhe uma porta interna livre e não liga firewall em servidor compartilhado.
#  Pode rodar de novo: não apaga dados, não troca senhas já criadas, não reescreve o .env (só acrescenta
#  chaves novas) e não reinicia o sistema se nada mudou.
# =====================================================================================
set -euo pipefail

APP=/opt/oneup/app
BASE=/opt/oneup
NODEDIR=$BASE/node
ENVF=$BASE/.env
ACESSOS=/root/oneup-acessos.txt
EMPRESA=${EMPRESA:-happy-alpha}
NOME=${NOME:-Happy Alpha}
LOG=/var/log/oneup-instalacao.log
ESTADO=$BASE/estado
# o que foi pedido explicitamente nesta execução (só isso pode trocar um valor que já está no .env)
DOMINIO_PEDIDO=${DOMINIO:-}
EMAIL_PEDIDO=${EMAIL:-}
WEB_PEDIDO=${WEB:-}

# verde() e amarelo() vêm do deploy/oneup (carregado logo abaixo)
vermelho() { printf '\033[1;31m%s\033[0m\n' "$*"; }
passo() { echo; verde "▶ $*"; }
falha() { vermelho "✖ $*"; echo "Detalhes em $LOG"; exit 1; }
trap 'falha "A instalação parou na linha $LINENO. Rode o mesmo comando de novo; se repetir, mande a tela para o suporte."' ERR
# registro da instalação só para o root (o resumo final com as senhas NÃO vai para ele)
touch "$LOG" && chmod 600 "$LOG"
exec 3>&1
exec > >(tee -a "$LOG") 2>&1

[ "$(id -u)" = 0 ] || falha "Rode como root (no terminal da Hostinger você já entra como root)."
. /etc/os-release
[ "${ID:-}" = ubuntu ] || falha "Este instalador é para Ubuntu (encontrado: ${PRETTY_NAME:-desconhecido})."
[ -f "$APP/server/package.json" ] || falha "Não achei o sistema em $APP. Baixe o código antes (veja o guia)."
# funções do comando oneup (ler/mudar o .env sem reescrever, cópia externa, avisos, conferência de versão)
# shellcheck source=deploy/oneup
ONEUP_SO_FUNCOES=1 . "$APP/deploy/oneup"
# senhas sem caracteres que confundem (0/O, 1/l/I); sem pipe que se interrompe (seguro com pipefail)
senha() { local s; s=$(head -c 600 /dev/urandom | LC_ALL=C tr -dc 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'); echo "${s:0:${1:-24}}"; }
pin() { local s; s=$(head -c 600 /dev/urandom | LC_ALL=C tr -dc '0-9'); echo "${s:0:${1:-6}}"; }
# porta em uso agora OU reservada por outro sistema (proxy do Nginx, PM2), mesmo que ele esteja desligado neste momento
porta_reservada() { grep -RhoE --exclude="zz-oneup*" "(127\.0\.0\.1|localhost):[0-9]+" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | grep -qE ":$1\$"; }
porta_pm2() { command -v pm2 >/dev/null 2>&1 && pm2 jlist 2>/dev/null | grep -qE "\"PORT\":\"?$1\"?[,}]"; }
porta_ocupada() { ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q . || porta_reservada "$1" || porta_pm2 "$1"; }
export DEBIAN_FRONTEND=noninteractive

# Servidor web: o que já existe manda. Nginx instalado (ou alguém já usando a porta 80/443) = modo Nginx.
WEB=${WEB:-$(envget ONEUP_WEB)}
if [ -z "$WEB" ]; then
  if command -v nginx >/dev/null 2>&1; then WEB=nginx
  elif command -v caddy >/dev/null 2>&1 || ! { porta_ocupada 80 || porta_ocupada 443; }; then WEB=caddy
  else falha "Já existe outro programa usando as portas 80/443 (não é Nginx nem Caddy). Fale com o suporte."; fi
fi
[ "$WEB" = nginx ] || [ "$WEB" = caddy ] || falha "WEB deve ser nginx ou caddy."

# -------------------------------------------------------------------------------------
passo "1/9 Pacotes do sistema (servidor web: $WEB)"
# Não mexe no fuso do servidor (o Lava Jato e outros sistemas dependem dele): o ONE UP já usa America/Sao_Paulo
# internamente e o backup diário roda às 03:30 de Brasília pelo próprio timer.
export NEEDRESTART_MODE=l   # o apt não reinicia serviços de outros sistemas sozinho
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git xz-utils ufw postgresql postgresql-contrib dnsutils >/dev/null
# memória extra de segurança (VPS pequena): 2 GB de swap, só se ainda não houver
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# -------------------------------------------------------------------------------------
passo "2/9 Node.js 22 próprio do ONE UP Comanda (em $NODEDIR — o Node dos outros sistemas não muda)"
if [ ! -x "$NODEDIR/bin/node" ] || [ "$("$NODEDIR/bin/node" -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  case "$(uname -m)" in x86_64) ARQ=x64 ;; aarch64|arm64) ARQ=arm64 ;; *) falha "Processador não suportado: $(uname -m)";; esac
  URL=https://nodejs.org/dist/latest-v22.x
  ARQUIVO=$(curl -fsSL "$URL/SHASUMS256.txt" | grep -o "node-v22[0-9.]*-linux-$ARQ.tar.xz" | head -1)
  [ -n "$ARQUIVO" ] || falha "Não consegui achar o Node 22 em nodejs.org."
  TMP=$(mktemp -d)
  curl -fsSL -o "$TMP/$ARQUIVO" "$URL/$ARQUIVO"
  (cd "$TMP" && curl -fsSL "$URL/SHASUMS256.txt" | grep " $ARQUIVO\$" | sha256sum -c - >/dev/null) || falha "Download do Node corrompido. Rode de novo."
  rm -rf "$NODEDIR.novo" && mkdir -p "$NODEDIR.novo" && tar -xJf "$TMP/$ARQUIVO" -C "$NODEDIR.novo" --strip-components=1
  rm -rf "$NODEDIR" && mv "$NODEDIR.novo" "$NODEDIR"; rm -rf "$TMP"
fi
export PATH="$NODEDIR/bin:$PATH"
node -v

# -------------------------------------------------------------------------------------
passo "3/9 Servidor web"
if [ "$WEB" = caddy ]; then
  if ! command -v caddy >/dev/null; then
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
    if curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null \
       && curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list; then
      apt-get update -qq || true
    fi
    apt-get install -y -qq caddy >/dev/null
  fi
  caddy version
else
  command -v nginx >/dev/null || apt-get install -y -qq nginx >/dev/null
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  nginx -v
fi

# -------------------------------------------------------------------------------------
passo "4/9 Usuário do sistema e pastas"
id oneup >/dev/null 2>&1 || useradd --system --home "$BASE" --shell /usr/sbin/nologin oneup
mkdir -p "$BASE/uploads" "$BASE/backups" "$ESTADO"
chown -R oneup:oneup "$BASE/uploads"
chmod 750 "$BASE/backups"; chmod 700 "$ESTADO"
# frase que tranca as cópias enviadas ao Google Drive: criada uma vez e mostrada UMA vez no fim
CHAVE_NOVA=
if [ ! -s "$CHAVE" ]; then
  ( umask 077; gerar_frase > "$CHAVE" )
  CHAVE_NOVA=$(cat "$CHAVE")
fi
chown root:root "$CHAVE"; chmod 600 "$CHAVE"

# -------------------------------------------------------------------------------------
passo "5/9 Banco de dados (PostgreSQL)"
systemctl enable --now postgresql >/dev/null
# senhas do .env são mantidas; se alguém trocou a conexão à mão (outro usuário), a senha no banco não é mexida
DB_PASS=$(envget DATABASE_URL | sed -nE 's#.*://oneup_dono:([^@]+)@.*#\1#p')
MEXER_DONO=1
if [ -z "$DB_PASS" ]; then
  if env_tem DATABASE_URL; then MEXER_DONO=0; amarelo "  DATABASE_URL personalizado no .env: senha do dono do banco mantida."; fi
  DB_PASS=$(senha 32)
fi
# usuário da APLICAÇÃO (sem BYPASSRLS): só entra como oneup_app; o dono (oneup_dono) fica para migrações e plataforma
APP_PASS=$(envget APP_DATABASE_URL | sed -nE 's#.*://oneup_app_login:([^@]+)@.*#\1#p')
MEXER_APP=1
if [ -z "$APP_PASS" ]; then
  if [ -n "$(envget APP_DATABASE_URL)" ]; then MEXER_APP=0; amarelo "  APP_DATABASE_URL personalizado no .env: mantido."; fi
  APP_PASS=$(senha 32)
fi
DONO_ATUAL=$(sudo -u postgres psql -tAc "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='oneup'" || true)
[ -z "$DONO_ATUAL" ] || [ "$DONO_ATUAL" = oneup_dono ] || falha "Já existe um banco 'oneup' de outro sistema (dono: $DONO_ATUAL). Fale com o suporte."
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oneup_app') THEN CREATE ROLE oneup_app NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oneup_dono') THEN CREATE ROLE oneup_dono LOGIN CREATEROLE BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oneup_app_login') THEN CREATE ROLE oneup_app_login LOGIN; END IF;
END \$\$;
$(if [ "$MEXER_DONO" = 1 ]; then echo "ALTER ROLE oneup_dono PASSWORD '$DB_PASS';"; fi)
GRANT oneup_app TO oneup_dono WITH ADMIN OPTION;
-- login da aplicação: nunca superusuário nem BYPASSRLS; a conexão vira oneup_app (-c role=oneup_app)
ALTER ROLE oneup_app_login LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
$(if [ "$MEXER_APP" = 1 ]; then echo "ALTER ROLE oneup_app_login PASSWORD '$APP_PASS';"; fi)
GRANT oneup_app TO oneup_app_login;
SQL
[ -n "$DONO_ATUAL" ] || sudo -u postgres createdb -O oneup_dono oneup
# banco só escuta no próprio servidor (padrão do Ubuntu); conferido:
grep -Eq "^\s*listen_addresses\s*=\s*'\*'" /etc/postgresql/*/main/postgresql.conf && amarelo "Atenção: o PostgreSQL está aberto para a rede. Recomendado: listen_addresses = 'localhost'." || true

# -------------------------------------------------------------------------------------
passo "6/9 Endereço, porta e configuração"
[ -n "${DOMINIO:-}" ] || DOMINIO=$(envget BASE_DOMAIN)
[ -n "${DOMINIO:-}" ] || DOMINIO=comanda.oneupsistemas.com.br
if [ "$DOMINIO" = sslip ]; then
  IP=$(curl -4 -fsS --max-time 10 https://api.ipify.org || curl -4 -fsS --max-time 10 https://ifconfig.me || hostname -I | awk '{print $1}')
  [[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || falha "Não consegui descobrir o IP público deste servidor."
  DOMINIO="${IP//./-}.sslip.io"
fi
DOMINIO=$(echo "$DOMINIO" | tr '[:upper:]' '[:lower:]' | sed 's#^https\?://##; s#/.*##; s#^\.##')
[[ "$DOMINIO" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || falha "Endereço inválido: $DOMINIO"
# porta interna: a de antes, ou a primeira livre a partir de 3010 (o Lava Jato e outros sistemas continuam nas deles)
PORTA=$(envget PORT)
if [ -z "$PORTA" ]; then
  PORTA=3010; while porta_ocupada "$PORTA"; do PORTA=$((PORTA + 1)); [ "$PORTA" -gt 3099 ] && falha "Nenhuma porta livre entre 3010 e 3099."; done
fi
# .env: NUNCA é reescrito. Chave que já existe fica como está; só entram as que faltam.
# Troca de valor só quando pedida nesta execução (DOMINIO=, EMAIL=, WEB=).
ENV_ANTES=$(sha256sum "$ENVF" 2>/dev/null || true)
[ -f "$ENVF" ] || printf '# ONE UP Comanda — criado pelo instalador em %s. Mudou algo? Rode: oneup reiniciar\n' "$(date '+%d/%m/%Y %H:%M')" > "$ENVF"
cp -p "$ENVF" "$ESTADO/env.antes-da-instalacao" 2>/dev/null || true
env_completar NODE_ENV production
env_completar PORT "$PORTA"
env_completar HOST 127.0.0.1
env_completar DATABASE_URL "postgres://oneup_dono:$DB_PASS@127.0.0.1:5432/oneup"
[ -n "$(envget APP_DATABASE_URL)" ] || env_definir APP_DATABASE_URL "postgres://oneup_app_login:$APP_PASS@127.0.0.1:5432/oneup"
env_completar APP_DB_ROLE oneup_app
env_completar DB_POOL_SIZE 20
env_completar BASE_DOMAIN "$DOMINIO"
[ -z "$DOMINIO_PEDIDO" ] || env_definir BASE_DOMAIN "$DOMINIO"
env_completar DEFAULT_EMPRESA ""
env_completar COOKIE_SECURE true
env_completar TRUST_PROXY privado
env_completar EMPRESA_HEADER false
env_completar INSIGHTS_ENABLED false
env_completar UPLOADS_DIR "$BASE/uploads"
env_completar BACKUP_DIRS ""
env_completar ONEUP_WEB "$WEB"
[ -z "$WEB_PEDIDO" ] || env_definir ONEUP_WEB "$WEB"
env_completar ONEUP_EMAIL "$EMAIL_PEDIDO"
[ -z "$EMAIL_PEDIDO" ] || env_definir ONEUP_EMAIL "$EMAIL_PEDIDO"
# cópia externa e avisos (configurados depois com: oneup backup-externo configurar · oneup alertas configurar)
env_completar BACKUP_EXTERNO ""
env_completar ALERTA_URL ""
env_completar ALERTA_EMAIL ""
chown root:oneup "$ENVF"; chmod 640 "$ENVF"
DOMINIO=$(envget BASE_DOMAIN); PORTA=$(envget PORT); WEB=$(envget ONEUP_WEB)
if [ "$ENV_ANTES" = "$(sha256sum "$ENVF")" ]; then verde "  .env sem mudanças"
else verde "  .env completado (o que já existia foi mantido; cópia de antes em $ESTADO/env.antes-da-instalacao)"; fi
verde "  endereço base: $DOMINIO · porta interna: $PORTA"

# -------------------------------------------------------------------------------------
passo "7/9 Sistema (dependências e serviço)"
cd "$APP"
git config --global --add safe.directory "$APP" || true
# dependências: só reinstala se a lista mudou (o npm ci apaga e recria a pasta inteira)
LOCK=$(sha256sum package-lock.json | cut -d' ' -f1)
if [ ! -d node_modules ] || [ "$LOCK" != "$(cat "$ESTADO/dependencias.sha" 2>/dev/null)" ]; then
  npm ci --omit=dev -w server --no-audit --no-fund --loglevel=error
  echo "$LOCK" > "$ESTADO/dependencias.sha"
else
  verde "  dependências já instaladas (sem mudanças)"
fi
if instalar_unidades; then systemctl daemon-reload; fi
install -m 755 deploy/oneup /usr/local/bin/oneup.novo && mv -f /usr/local/bin/oneup.novo /usr/local/bin/oneup
systemctl enable -q oneup oneup-backup.timer oneup-vigia.timer oneup-autoatualizar.timer
systemctl start oneup-backup.timer oneup-vigia.timer oneup-autoatualizar.timer
# reinicia só se algo que o sistema usa mudou (código compilado, dependências, .env, serviço, Node)
impressao() {
  { cat "$ENVF" package-lock.json deploy/oneup.service; "$NODEDIR/bin/node" -v
    find server/dist web/dist -type f -print0 2>/dev/null | sort -z | xargs -0 sha256sum; } | sha256sum | cut -d' ' -f1
}
IMPRESSAO=$(impressao)
if systemctl is-active -q oneup && [ "$IMPRESSAO" = "$(cat "$ESTADO/instalacao.sha" 2>/dev/null)" ] && saude 3; then
  verde "  nada mudou no sistema: continua no ar, sem reiniciar"
else
  systemctl restart oneup
  for i in $(seq 1 60); do curl -fsS "http://127.0.0.1:$PORTA/api/health" >/dev/null 2>&1 && break; sleep 1; [ "$i" = 60 ] && { journalctl -u oneup -n 40 --no-pager; falha "O sistema não ligou."; }; done
fi
echo "$IMPRESSAO" > "$ESTADO/instalacao.sha"
verde "  sistema no ar (porta interna $PORTA)"

# -------------------------------------------------------------------------------------
passo "8/9 Endereço na internet e firewall"
if [ "$WEB" = caddy ]; then
  NOVO=$(mktemp)
  EMAIL_CADDY=$(envget ONEUP_EMAIL)
  sed -e "s#__EMAIL__#$EMAIL_CADDY#; s#__PORTA__#$PORTA#g" deploy/Caddyfile > "$NOVO"
  [ -n "$EMAIL_CADDY" ] || sed -i '/^\s*email\s*$/d' "$NOVO"
  # ensaio sem internet (testes da ONE UP): certificado da autoridade local do Caddy
  [ "${ONEUP_ENSAIO:-}" = 1 ] && sed -i '0,/^{/s//{\n\tlocal_certs/' "$NOVO"
  caddy validate --config "$NOVO" --adapter caddyfile >/dev/null
  systemctl enable -q caddy
  if ! cmp -s "$NOVO" /etc/caddy/Caddyfile; then
    install -m 644 "$NOVO" /etc/caddy/Caddyfile
    if systemctl is-active -q caddy; then systemctl reload caddy; else systemctl restart caddy; fi
  else
    systemctl is-active -q caddy || systemctl start caddy
  fi
  rm -f "$NOVO"
else
  # nome começando com zz-: nunca vira o site padrão do Nginx por ordem alfabética (o Lava Jato continua sendo)
  CONF=/etc/nginx/sites-available/zz-oneup-comanda.conf
  ANTIGO=/etc/nginx/sites-available/oneup-comanda.conf
  LINK=/etc/nginx/sites-enabled/zz-oneup-comanda.conf
  MUDOU_NGINX=0
  # instalação antiga: renomeia (mantém as linhas de HTTPS que o certbot já escreveu)
  if [ -f "$ANTIGO" ] && [ ! -f "$CONF" ]; then mv "$ANTIGO" "$CONF"; MUDOU_NGINX=1; fi
  if [ -e /etc/nginx/sites-enabled/oneup-comanda.conf ] || [ -L /etc/nginx/sites-enabled/oneup-comanda.conf ]; then rm -f /etc/nginx/sites-enabled/oneup-comanda.conf; MUDOU_NGINX=1; fi
  if [ -f "$ANTIGO" ]; then rm -f "$ANTIGO"; MUDOU_NGINX=1; fi
  # não sobrescreve o que o certbot já completou (linhas de HTTPS); só cria ou atualiza o que ainda é nosso
  if [ ! -f "$CONF" ] || ! grep -q "managed by Certbot" "$CONF"; then
    NOVO=$(mktemp)
    sed -e "s#__DOMINIO__#$DOMINIO#g; s#__PORTA__#$PORTA#g" deploy/nginx-comanda.conf > "$NOVO"
    if ! cmp -s "$NOVO" "$CONF"; then install -m 644 "$NOVO" "$CONF"; MUDOU_NGINX=1; fi
    rm -f "$NOVO"
  fi
  if [ "$(readlink "$LINK" 2>/dev/null)" != "$CONF" ]; then ln -sf "$CONF" "$LINK"; MUDOU_NGINX=1; fi
  if [ "$MUDOU_NGINX" = 1 ]; then
    nginx -t 2>&1 | tail -2 || { rm -f "$LINK"; falha "A configuração do Nginx não passou no teste (nada foi alterado nos outros sites)."; }
    systemctl reload nginx   # recarga suave: os outros sites não caem
    verde "  Nginx: *.$DOMINIO → porta $PORTA (os outros sites do servidor não mudam)"
  else
    verde "  Nginx sem mudanças (nada recarregado)"
  fi
  if ! nginx -T 2>/dev/null | grep -Eq '^\s*listen\s[^;]*default_server'; then
    amarelo "  Atenção: nenhum site do Nginx está marcado como padrão (default_server). Quem abrir o IP do servidor ou um"
    amarelo "  endereço desconhecido cai no primeiro site em ordem alfabética (o ONE UP Comanda fica por último de propósito)."
    amarelo "  Não mexi em nada dos outros sistemas. Recomendado: o suporte marcar o site principal com 'default_server'."
  fi
fi
if ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  verde "  firewall ativo: portas 80 e 443 liberadas"
elif [ "$WEB" = caddy ] && [ -z "$(envget ONEUP_COMPARTILHADO)" ]; then
  ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
  verde "  firewall ligado: só SSH, 80 e 443 abertos"
else
  amarelo "  firewall desligado neste servidor: não liguei para não bloquear os outros sistemas. Peça ao suporte para revisar."
fi

# -------------------------------------------------------------------------------------
passo "9/9 Restaurante"
cd "$APP/server"
carregar_env
EXISTE=$(sudo -u postgres psql -d oneup -tAc "SELECT 1 FROM empresas e WHERE e.slug='$EMPRESA' AND EXISTS (SELECT 1 FROM users u WHERE u.empresa_id=e.id)" 2>/dev/null || true)
if [ "$EXISTE" != 1 ]; then
  P_DONO=$(senha 10); P_CAIXA=$(pin 6); P_COZ=$(pin 6); P_ONEUP=$(senha 16)
  node dist/scripts/setup.js --empresa="$EMPRESA" --nome="$NOME" --admin-name="Rafael" --admin-user=rafael --admin-pass="$P_DONO" \
    --caixa-pass="$P_CAIXA" --cozinha-pass="$P_COZ" --cardapio=piloto
  # senhas guardadas JÁ (se algo abaixo falhar, elas não se perdem)
  ( umask 077; cat >> "$ACESSOS" <<TXT
==================== $NOME — criado em $(date '+%d/%m/%Y %H:%M') ====================
Endereço:   https://$EMPRESA.$DOMINIO
Cardápio:   https://$EMPRESA.$DOMINIO/cardapio
Dono:       login rafael     senha $P_DONO
Caixa:      login caixa      senha $P_CAIXA
Cozinha:    login cozinha    senha $P_COZ
ONE UP:     login lucas      senha $P_ONEUP   (seu acesso de suporte: não aparece na lista de usuários do Dono; o que você fizer fica na Auditoria)

TXT
  )
  node dist/scripts/plataforma.js oneup-usuario --empresa="$EMPRESA" --login=lucas --nome="Lucas (ONE UP)" --senha="$P_ONEUP"
  [ -f "provisionamento/$EMPRESA.json" ] && node dist/scripts/plataforma.js provisionar --arquivo="provisionamento/$EMPRESA.json"
else
  amarelo "  $NOME já existe: dados e senhas mantidos."
  # instalação anterior parou antes de criar o acesso ONE UP: cria agora com senha nova
  TEM_ONEUP=$(sudo -u postgres psql -d oneup -tAc "SELECT 1 FROM users u JOIN empresas e ON e.id=u.empresa_id WHERE e.slug='$EMPRESA' AND u.oneup LIMIT 1" || true)
  if [ "$TEM_ONEUP" != 1 ]; then
    P_ONEUP=$(senha 16)
    node dist/scripts/plataforma.js oneup-usuario --empresa="$EMPRESA" --login=lucas --nome="Lucas (ONE UP)" --senha="$P_ONEUP"
    ( umask 077; printf 'ONE UP (%s): login lucas   senha %s\n\n' "$NOME" "$P_ONEUP" >> "$ACESSOS" )
  fi
  [ -f "provisionamento/$EMPRESA.json" ] && node dist/scripts/plataforma.js provisionar --arquivo="provisionamento/$EMPRESA.json" >/dev/null
fi

chown -R oneup:oneup "$BASE/uploads"   # imagens gravadas pela instalação continuam editáveis pelo sistema

# certificado HTTPS: Caddy emite na primeira visita; no Nginx o comando confere o DNS e pede ao Let's Encrypt
CERT_OK=1
if [ "$WEB" = nginx ]; then
  /usr/local/bin/oneup certificado || CERT_OK=0
else
  for i in $(seq 1 30); do curl -fsS -o /dev/null "https://$EMPRESA.$DOMINIO/api/health" 2>/dev/null && break; sleep 2; done
fi

echo
verde "==================================================================="
verde "  ONE UP Comanda instalado."
verde "==================================================================="
cat "$ACESSOS" >&3   # só na tela, não no registro
echo "Estes acessos ficam guardados em $ACESSOS (para ver de novo: oneup acessos)."
if [ -n "$CHAVE_NOVA" ]; then
  {
    echo
    vermelho "==================================================================="
    vermelho "  ANOTE ESTA FRASE AGORA — ela aparece só esta vez:"
    echo
    echo "      $CHAVE_NOVA"
    echo
    echo "  Ela tranca as cópias de segurança enviadas ao Google Drive. Guarde FORA do servidor"
    echo "  (gerenciador de senhas ou papel). Sem ela as cópias não abrem — nem a ONE UP recupera."
    vermelho "==================================================================="
  } >&3
fi
[ -n "$(envget BACKUP_EXTERNO)" ] || amarelo "Falta ligar a cópia no Google Drive: oneup backup-externo configurar"
[ -n "$(envget ALERTA_URL)$(envget ALERTA_EMAIL)" ] || amarelo "Falta ligar os avisos no WhatsApp: oneup alertas configurar"
conferir_versao >/dev/null || amarelo "Atenção: a versão no ar não confere com a baixada. Rode: oneup versao"
[ "$CERT_OK" = 1 ] || amarelo "Falta o HTTPS (veja a mensagem acima sobre o DNS). Depois de criar o registro no DNS, rode: oneup certificado"
echo "Comandos úteis: oneup status | oneup logs | oneup atualizar | oneup backup | oneup ajuda"
