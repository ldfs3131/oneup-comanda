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
#  Pode rodar de novo: não apaga dados, não troca senhas já criadas, só completa o que falta.
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

verde() { printf '\033[1;32m%s\033[0m\n' "$*"; }
amarelo() { printf '\033[1;33m%s\033[0m\n' "$*"; }
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
# senhas sem caracteres que confundem (0/O, 1/l/I); sem pipe que se interrompe (seguro com pipefail)
senha() { local s; s=$(head -c 600 /dev/urandom | LC_ALL=C tr -dc 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'); echo "${s:0:${1:-24}}"; }
pin() { local s; s=$(head -c 600 /dev/urandom | LC_ALL=C tr -dc '0-9'); echo "${s:0:${1:-6}}"; }
porta_ocupada() { ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q .; }
export DEBIAN_FRONTEND=noninteractive
envget() { [ -f "$ENVF" ] && grep "^$1=" "$ENVF" | head -1 | cut -d= -f2- || true; }

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
mkdir -p "$BASE/uploads" "$BASE/backups"
chown -R oneup:oneup "$BASE/uploads"
chmod 750 "$BASE/backups"

# -------------------------------------------------------------------------------------
passo "5/9 Banco de dados (PostgreSQL)"
systemctl enable --now postgresql >/dev/null
DB_PASS=$(envget DATABASE_URL | sed -nE 's#.*://oneup_dono:([^@]+)@.*#\1#p')
[ -n "$DB_PASS" ] || DB_PASS=$(senha 32)
DONO_ATUAL=$(sudo -u postgres psql -tAc "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='oneup'" || true)
[ -z "$DONO_ATUAL" ] || [ "$DONO_ATUAL" = oneup_dono ] || falha "Já existe um banco 'oneup' de outro sistema (dono: $DONO_ATUAL). Fale com o suporte."
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oneup_app') THEN CREATE ROLE oneup_app NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oneup_dono') THEN CREATE ROLE oneup_dono LOGIN CREATEROLE BYPASSRLS; END IF;
END \$\$;
ALTER ROLE oneup_dono PASSWORD '$DB_PASS';
GRANT oneup_app TO oneup_dono WITH ADMIN OPTION;
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
DOMINIO=$(echo "$DOMINIO" | tr 'A-Z' 'a-z' | sed 's#^https\?://##; s#/.*##; s#^\.##')
[[ "$DOMINIO" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || falha "Endereço inválido: $DOMINIO"
# porta interna: a de antes, ou a primeira livre a partir de 3010 (o Lava Jato e outros sistemas continuam nas deles)
PORTA=$(envget PORT)
if [ -z "$PORTA" ]; then
  PORTA=3010; while porta_ocupada "$PORTA"; do PORTA=$((PORTA + 1)); [ "$PORTA" -gt 3099 ] && falha "Nenhuma porta livre entre 3010 e 3099."; done
fi
cat > "$ENVF" <<ENV
# ONE UP Comanda — gerado pelo instalador em $(date '+%d/%m/%Y %H:%M'). Mudou algo? Rode: oneup reiniciar
NODE_ENV=production
PORT=$PORTA
HOST=127.0.0.1
DATABASE_URL=postgres://oneup_dono:$DB_PASS@127.0.0.1:5432/oneup
APP_DB_ROLE=oneup_app
DB_POOL_SIZE=20
BASE_DOMAIN=$DOMINIO
DEFAULT_EMPRESA=
COOKIE_SECURE=true
TRUST_PROXY=privado
EMPRESA_HEADER=false
INSIGHTS_ENABLED=false
UPLOADS_DIR=$BASE/uploads
BACKUP_DIRS=
ONEUP_WEB=$WEB
ONEUP_EMAIL=${EMAIL:-$(envget ONEUP_EMAIL)}
ENV
chown root:oneup "$ENVF"; chmod 640 "$ENVF"
verde "  endereço base: $DOMINIO · porta interna: $PORTA"

# -------------------------------------------------------------------------------------
passo "7/9 Sistema (dependências e serviço)"
cd "$APP"
git config --global --add safe.directory "$APP" || true
npm ci --omit=dev -w server --no-audit --no-fund --loglevel=error
install -m 644 deploy/oneup.service /etc/systemd/system/oneup.service
install -m 644 deploy/oneup-backup.service /etc/systemd/system/oneup-backup.service
install -m 644 deploy/oneup-backup.timer /etc/systemd/system/oneup-backup.timer
install -m 755 deploy/oneup /usr/local/bin/oneup.novo && mv -f /usr/local/bin/oneup.novo /usr/local/bin/oneup
systemctl daemon-reload
systemctl enable oneup oneup-backup.timer >/dev/null
systemctl restart oneup
systemctl start oneup-backup.timer
for i in $(seq 1 60); do curl -fsS "http://127.0.0.1:$PORTA/api/health" >/dev/null 2>&1 && break; sleep 1; [ "$i" = 60 ] && { journalctl -u oneup -n 40 --no-pager; falha "O sistema não ligou."; }; done
verde "  sistema no ar (porta interna $PORTA)"

# -------------------------------------------------------------------------------------
passo "8/9 Endereço na internet e firewall"
if [ "$WEB" = caddy ]; then
  sed -e "s#__EMAIL__#${EMAIL:-}#; s#__PORTA__#$PORTA#g" deploy/Caddyfile > /etc/caddy/Caddyfile
  [ -n "${EMAIL:-}" ] || sed -i '/^\s*email\s*$/d' /etc/caddy/Caddyfile
  # ensaio sem internet (testes da ONE UP): certificado da autoridade local do Caddy
  [ "${ONEUP_ENSAIO:-}" = 1 ] && sed -i '0,/^{/s//{\n\tlocal_certs/' /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  systemctl enable caddy >/dev/null; systemctl restart caddy
else
  CONF=/etc/nginx/sites-available/oneup-comanda.conf
  # não sobrescreve o que o certbot já completou (linhas de HTTPS); só cria ou atualiza o que ainda é nosso
  if [ ! -f "$CONF" ] || ! grep -q "managed by Certbot" "$CONF"; then
    sed -e "s#__DOMINIO__#$DOMINIO#g; s#__PORTA__#$PORTA#g" deploy/nginx-comanda.conf > "$CONF"
  fi
  ln -sf "$CONF" /etc/nginx/sites-enabled/oneup-comanda.conf
  nginx -t 2>&1 | tail -2 || { rm -f /etc/nginx/sites-enabled/oneup-comanda.conf; falha "A configuração do Nginx não passou no teste (nada foi alterado nos outros sites)."; }
  systemctl reload nginx
  verde "  Nginx: *.$DOMINIO → porta $PORTA (os outros sites do servidor não mudam)"
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
set -a; . "$ENVF"; set +a
EXISTE=$(sudo -u postgres psql -d oneup -tAc "SELECT 1 FROM empresas e WHERE e.slug='$EMPRESA' AND EXISTS (SELECT 1 FROM users u WHERE u.empresa_id=e.id)" 2>/dev/null || true)
if [ "$EXISTE" != 1 ]; then
  P_DONO=$(senha 10); P_CAIXA=$(pin 6); P_COZ=$(pin 6); P_ONEUP=$(senha 16)
  node dist/scripts/setup.js --empresa="$EMPRESA" --nome="$NOME" --admin-name="Rafael" --admin-user=rafael --admin-pass="$P_DONO" \
    --caixa-pass="$P_CAIXA" --cozinha-pass="$P_COZ" --cardapio=exemplo
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
[ "$CERT_OK" = 1 ] || amarelo "Falta o HTTPS (veja a mensagem acima sobre o DNS). Depois de criar o registro no DNS, rode: oneup certificado"
echo "Comandos úteis: oneup status | oneup logs | oneup atualizar | oneup backup | oneup ajuda"
