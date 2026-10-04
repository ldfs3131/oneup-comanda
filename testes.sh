#!/usr/bin/env bash
# Roda todas as suítes de teste em bancos novos. Uso: ./testes.sh  (PostgreSQL local, usuário postgres/postgres)
set -u
cd "$(dirname "$0")/server"
PG=${PG:-postgres://postgres:postgres@localhost:5432}
falhas=0
novo() { psql "$PG/postgres" -qc "DROP DATABASE IF EXISTS $1 WITH (FORCE)" -c "CREATE DATABASE $1" >/dev/null; }
espera() { for _ in $(seq 1 60); do curl -sf "http://localhost:$1/api/health" >/dev/null && return 0; sleep 0.5; done; echo "servidor $1 não subiu"; return 1; }
roda() { local nome=$1; shift; echo "=== $nome"; if "$@" > "/tmp/teste-$nome.log" 2>&1; then tail -1 "/tmp/teste-$nome.log"; else echo "FALHOU ($nome) — veja /tmp/teste-$nome.log"; tail -15 "/tmp/teste-$nome.log"; falhas=$((falhas+1)); fi; }

# 1) Empresa única: e2e e insights
novo of_e2e; novo of_insights
DATABASE_URL=$PG/of_e2e node dist/scripts/setup.js --admin-name=Administrador --admin-pass=admin123 --caixa-pass=caixa123 --cozinha-pass=cozinha123 --cardapio=piloto >/dev/null
DATABASE_URL=$PG/of_e2e PORT=3100 INSIGHTS_ENABLED=true DEFAULT_EMPRESA=empresa-1 node dist/index.js > /tmp/srv-3100.log 2>&1 & S1=$!
espera 3100
roda e2e env DATABASE_URL=$PG/of_e2e BASE_URL=http://localhost:3100 node dist/scripts/e2e.js
roda migracoes env DATABASE_URL=$PG/of_e2e node dist/scripts/migracoes-test.js
roda insights env DATABASE_URL=$PG/of_insights node dist/scripts/insights-test.js
kill $S1 2>/dev/null; wait $S1 2>/dev/null

# 2) Duas empresas: vazamento, personalização e conexões
novo of_iso
for e in alfa beta; do DATABASE_URL=$PG/of_iso node dist/scripts/setup.js --empresa=$e --nome=$e --admin-pass=$e-admin --caixa-pass=$e-caixa --cozinha-pass=$e-coz --cardapio=piloto >/dev/null; done
DATABASE_URL=$PG/of_iso EMPRESA_HEADER=true PORT=3200 node dist/index.js > /tmp/srv-3200.log 2>&1 & S2=$!
espera 3200
roda isolamento env DATABASE_URL=$PG/of_iso BASE_URL=http://localhost:3200 node dist/scripts/isolamento-test.js
roda personalizacao env DATABASE_URL=$PG/of_iso BASE_URL=http://localhost:3200 node dist/scripts/personalizacao-test.js
roda conexoes env DATABASE_URL=$PG/of_iso node dist/scripts/conexao-test.js
roda comite env DATABASE_URL=$PG/of_iso BASE_URL=http://localhost:3200 node dist/scripts/comite-test.js
roda oneup env DATABASE_URL=$PG/of_iso BASE_URL=http://localhost:3200 node dist/scripts/oneup-test.js
roda ritmo env DATABASE_URL=$PG/of_iso BASE_URL=http://localhost:3200 node dist/scripts/ritmo-test.js
roda leva1 env DATABASE_URL=$PG/of_iso BASE_URL=http://localhost:3200 node dist/scripts/leva1-test.js
roda auditoria env DATABASE_URL=$PG/of_iso BASE_URL=http://localhost:3200 node dist/scripts/auditoria-test.js
kill $S2 2>/dev/null; wait $S2 2>/dev/null

# 3) Plataforma ONE UP: licença, Central de comando e cardápio genérico (recria o banco e sobe o próprio servidor na porta 3503)
roda plataforma env DATABASE_URL=$PG/of_plat node dist/scripts/plataforma-test.js

# 4) Central de Análise e Recuperação de vendas (cada uma recria o próprio banco e sobe o próprio servidor: 3501 e 3502)
roda analise node dist/scripts/analise-test.js
roda crm node dist/scripts/crm-test.js

echo; [ $falhas -eq 0 ] && echo "TUDO OK" || echo "$falhas suíte(s) falharam"
exit $falhas
