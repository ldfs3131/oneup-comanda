#!/usr/bin/env bash
# =====================================================================================
#  ONE UP — instalação online numa VPS Ubuntu 24.04 (Hostinger KVM ou similar)
#
#  Uso (como root, dentro da pasta do sistema já baixada em /opt/oneup/app):
#     bash /opt/oneup/app/deploy/instalar.sh
#  Opções (variáveis de ambiente, todas opcionais):
#     DOMINIO=restaurantes.seudominio.com.br   endereço base (padrão: <IP>.sslip.io, sem precisar de domínio)
#     EMAIL=voce@exemplo.com                   aviso de vencimento do certificado HTTPS
#     EMPRESA=happy-alpha  NOME="Happy Alpha"  primeira empresa criada (padrão: happy-alpha)
#
#  Pode rodar de novo: não apaga dados, não troca senhas já criadas, só completa o que falta.
# =====================================================================================
set -euo pipefail

APP=/opt/oneup/app
BASE=/opt/oneup
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
exec > >(tee -a "$LOG") 2>&1

[ "$(id -u)" = 0 ] || falha "Rode como root (no terminal da Hostinger você já entra como root)."
. /etc/os-release
[ "${ID:-}" = ubuntu ] || falha "Este instalador é para Ubuntu (encontrado: ${PRETTY_NAME:-desconhecido})."
[ -f "$APP/server/package.json" ] || falha "Não achei o sistema em $APP. Baixe o código antes (veja o guia)."
# senhas sem caracteres que confundem (0/O, 1/l/I); sem pipe que se interrompe (seguro com pipefail)
senha() { local s; s=$(head -c 600 /dev/urandom | LC_ALL=C tr -dc 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'); echo "${s:0:${1:-24}}"; }
pin() { local s; s=$(head -c 600 /dev/urandom | LC_ALL=C tr -dc '0-9'); echo "${s:0:${1:-6}}"; }
export DEBIAN_FRONTEND=noninteractive

# -------------------------------------------------------------------------------------
passo "1/9 Atualizando o servidor e instalando o básico"
timedatectl set-timezone America/Sao_Paulo 2>/dev/null || true
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git ufw postgresql postgresql-contrib debian-keyring debian-archive-keyring apt-transport-https >/dev/null
# memória extra de segurança (VPS pequena): 2 GB de swap, só se ainda não houver
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# -------------------------------------------------------------------------------------
passo "2/9 Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v

# -------------------------------------------------------------------------------------
passo "3/9 Caddy (HTTPS automático)"
if ! command -v caddy >/dev/null; then
  if curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null \
     && curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list; then
    apt-get update -qq || true
  fi
  apt-get install -y -qq caddy >/dev/null
fi
caddy version

# -------------------------------------------------------------------------------------
passo "4/9 Usuário do sistema e pastas"
id oneup >/dev/null 2>&1 || useradd --system --home "$BASE" --shell /usr/sbin/nologin oneup
mkdir -p "$BASE/uploads" "$BASE/backups"
chown -R oneup:oneup "$BASE/uploads"
chmod 750 "$BASE/backups"

# -------------------------------------------------------------------------------------
passo "5/9 Banco de dados (PostgreSQL)"
systemctl enable --now postgresql >/dev/null
if [ ! -f "$ENVF" ]; then
  DB_PASS=$(senha 32)
else
  DB_PASS=$(grep '^DATABASE_URL=' "$ENVF" | sed -E 's#.*://oneup_dono:([^@]+)@.*#\1#')
fi
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oneup_app') THEN CREATE ROLE oneup_app NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oneup_dono') THEN CREATE ROLE oneup_dono LOGIN CREATEROLE BYPASSRLS; END IF;
END \$\$;
ALTER ROLE oneup_dono PASSWORD '$DB_PASS';
GRANT oneup_app TO oneup_dono WITH ADMIN OPTION;
SQL
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='oneup'" | grep -q 1 || sudo -u postgres createdb -O oneup_dono oneup
# banco só escuta no próprio servidor (padrão do Ubuntu); conferido:
grep -Eq "^\s*listen_addresses\s*=\s*'\*'" /etc/postgresql/*/main/postgresql.conf && amarelo "Atenção: o PostgreSQL está aberto para a rede. Recomendado: listen_addresses = 'localhost'." || true

# -------------------------------------------------------------------------------------
passo "6/9 Endereço e configuração"
if [ -f "$ENVF" ] && grep -q '^BASE_DOMAIN=.' "$ENVF" && [ -z "${DOMINIO:-}" ]; then
  DOMINIO=$(grep '^BASE_DOMAIN=' "$ENVF" | cut -d= -f2)
fi
if [ -z "${DOMINIO:-}" ]; then
  IP=$(curl -4 -fsS --max-time 10 https://api.ipify.org || curl -4 -fsS --max-time 10 https://ifconfig.me || hostname -I | awk '{print $1}')
  [[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || falha "Não consegui descobrir o IP público deste servidor. Rode de novo com DOMINIO=seu.dominio."
  DOMINIO="${IP//./-}.sslip.io"
fi
DOMINIO=$(echo "$DOMINIO" | tr 'A-Z' 'a-z' | sed 's#^https\?://##; s#/.*##; s#^\.##')
cat > "$ENVF" <<ENV
# ONE UP — gerado pelo instalador em $(date '+%d/%m/%Y %H:%M'). Mudou algo? Rode: oneup reiniciar
NODE_ENV=production
PORT=3010
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
ENV
chown root:oneup "$ENVF"; chmod 640 "$ENVF"

# -------------------------------------------------------------------------------------
passo "7/9 Sistema (dependências e serviço)"
cd "$APP"
git config --global --add safe.directory "$APP" || true
npm ci --omit=dev -w server --no-audit --no-fund --loglevel=error
install -m 644 deploy/oneup.service /etc/systemd/system/oneup.service
install -m 644 deploy/oneup-backup.service /etc/systemd/system/oneup-backup.service
install -m 644 deploy/oneup-backup.timer /etc/systemd/system/oneup-backup.timer
install -m 755 deploy/oneup /usr/local/bin/oneup
systemctl daemon-reload
systemctl enable oneup oneup-backup.timer >/dev/null
systemctl restart oneup
systemctl start oneup-backup.timer
for i in $(seq 1 60); do curl -fsS http://127.0.0.1:3010/api/health >/dev/null 2>&1 && break; sleep 1; [ "$i" = 60 ] && { journalctl -u oneup -n 40 --no-pager; falha "O sistema não ligou."; }; done
verde "  sistema no ar (porta interna 3010)"

# -------------------------------------------------------------------------------------
passo "8/9 HTTPS e firewall"
sed -e "s#__EMAIL__#${EMAIL:-}#" deploy/Caddyfile > /etc/caddy/Caddyfile
[ -n "${EMAIL:-}" ] || sed -i '/^\s*email\s*$/d' /etc/caddy/Caddyfile
# ensaio sem internet (testes da ONE UP): certificado da autoridade local do Caddy
[ "${ONEUP_ENSAIO:-}" = 1 ] && sed -i '0,/^{/s//{\n\tlocal_certs/' /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable caddy >/dev/null; systemctl restart caddy
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
verde "  firewall: só SSH, 80 e 443 abertos"

# -------------------------------------------------------------------------------------
passo "9/9 Restaurante"
cd "$APP/server"
set -a; . "$ENVF"; set +a
EXISTE=$(sudo -u postgres psql -d oneup -tAc "SELECT 1 FROM empresas e WHERE e.slug='$EMPRESA' AND EXISTS (SELECT 1 FROM users u WHERE u.empresa_id=e.id)" 2>/dev/null || true)
if [ "$EXISTE" != 1 ]; then
  P_DONO=$(senha 10); P_CAIXA=$(pin 6); P_COZ=$(pin 6); P_ONEUP=$(senha 16)
  node dist/scripts/setup.js --empresa="$EMPRESA" --nome="$NOME" --admin-name="Rafael" --admin-user=rafael --admin-pass="$P_DONO" \
    --caixa-pass="$P_CAIXA" --cozinha-pass="$P_COZ" --cardapio=exemplo
  node dist/scripts/plataforma.js oneup-usuario --empresa="$EMPRESA" --login=lucas --nome="Lucas (ONE UP)" --senha="$P_ONEUP"
  [ -f "provisionamento/$EMPRESA.json" ] && node dist/scripts/plataforma.js provisionar --arquivo="provisionamento/$EMPRESA.json"
  umask 077
  cat >> "$ACESSOS" <<TXT
==================== $NOME — criado em $(date '+%d/%m/%Y %H:%M') ====================
Endereço:   https://$EMPRESA.$DOMINIO
Cardápio:   https://$EMPRESA.$DOMINIO/cardapio
Dono:       login rafael     senha $P_DONO
Caixa:      login caixa      senha $P_CAIXA
Cozinha:    login cozinha    senha $P_COZ
ONE UP:     login lucas      senha $P_ONEUP   (só você; o Dono não vê este acesso)

TXT
else
  amarelo "  $NOME já existe: dados e senhas mantidos."
  [ -f "provisionamento/$EMPRESA.json" ] && node dist/scripts/plataforma.js provisionar --arquivo="provisionamento/$EMPRESA.json" >/dev/null
fi

chown -R oneup:oneup "$BASE/uploads"   # imagens gravadas pela instalação continuam editáveis pelo sistema

# primeiro certificado: acessa o endereço para o Caddy emitir já (leva alguns segundos)
for i in $(seq 1 30); do curl -fsS -o /dev/null "https://$EMPRESA.$DOMINIO/api/health" 2>/dev/null && break; sleep 2; done

echo
verde "==================================================================="
verde "  ONE UP instalado e no ar."
verde "==================================================================="
cat "$ACESSOS"
echo "Estes acessos ficam guardados em $ACESSOS (para ver de novo: oneup acessos)."
echo "Comandos úteis: oneup status | oneup logs | oneup atualizar | oneup backup | oneup ajuda"
