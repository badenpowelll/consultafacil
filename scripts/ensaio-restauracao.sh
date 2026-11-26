#!/usr/bin/env bash
# Ensaio de restauração em ambiente isolado (incremento 7).
#
# Copia o banco de ORIGEM com pg_dump, restaura num banco NOVO no servidor de DESTINO (que deve
# ser outro servidor, sem acesso público: nunca o de produção) e confere se a cópia é fiel:
# migrações e checksums, contagem de linhas por tabela, RLS forçado e políticas. Mede o tempo.
#
#   CF_ORIGEM_URL=postgres://…/consultafacil \
#   CF_DESTINO_URL=postgres://…/postgres \
#   scripts/ensaio-restauracao.sh
#
# Para restaurar de verdade depois de um incidente, siga docs/operacao/restauracao.md: o mesmo
# caminho, mas a partir do backup do provedor e com a troca da DATABASE_URL no fim.
set -euo pipefail
umask 077

: "${CF_ORIGEM_URL:?defina CF_ORIGEM_URL (banco a copiar)}"
: "${CF_DESTINO_URL:?defina CF_DESTINO_URL (servidor isolado, banco postgres)}"
MANTER="${CF_MANTER_COPIA:-0}"

for cmd in pg_dump pg_restore psql; do command -v "$cmd" >/dev/null || { echo "falta $cmd"; exit 1; }; done

NOME="cf_restauro_$(date -u +%Y%m%d%H%M%S)"
TRABALHO="$(mktemp -d)"
DUMP="$TRABALHO/copia.dump"
trap 'rm -rf "$TRABALHO"' EXIT

destino_db() { printf '%s' "$CF_DESTINO_URL" | sed -E "s#/[^/?]+(\?|$)#/${NOME}\1#"; }
q() { psql "$1" -X -q -At -v ON_ERROR_STOP=1 -c "$2"; }

inicio=$(date +%s)
echo "1/5 Copiando a origem (pg_dump, formato custom)…"
pg_dump --format=custom --no-comments --file="$DUMP" "$CF_ORIGEM_URL"
echo "    tamanho da cópia: $(du -h "$DUMP" | cut -f1)"

echo "2/5 Criando $NOME no destino (papéis sem login, se faltarem)…"
q "$CF_DESTINO_URL" "DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cf_owner') THEN CREATE ROLE cf_owner NOLOGIN NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cf_app') THEN CREATE ROLE cf_app NOLOGIN NOBYPASSRLS; END IF;
END \$\$"
q "$CF_DESTINO_URL" "CREATE DATABASE ${NOME}"
DESTINO_DB="$(destino_db)"

echo "3/5 Restaurando…"
pg_restore --exit-on-error --single-transaction --dbname="$DESTINO_DB" "$DUMP"
fim_restauro=$(date +%s)

echo "4/5 Conferindo a cópia…"
CONTAGEM="SELECT string_agg(format('%s=%s', c.relname,
  (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM app.%I', c.relname), false, true, '')))[1]::text), ',' ORDER BY c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'app' AND c.relkind = 'r'"
MIGRACOES="SELECT string_agg(arquivo || ':' || checksum, ',' ORDER BY arquivo) FROM public.schema_migrations"
SEGURANCA="SELECT string_agg(format('%s:%s:%s', c.relname, c.relrowsecurity, c.relforcerowsecurity), ',' ORDER BY c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'app' AND c.relkind = 'r'"
POLITICAS="SELECT count(*) || ':' || md5(string_agg(tablename || policyname || coalesce(qual, '') || coalesce(with_check, ''), ',' ORDER BY tablename, policyname)) FROM pg_policies WHERE schemaname = 'app'"

falhas=0
for nome in CONTAGEM MIGRACOES SEGURANCA POLITICAS; do
  a="$(q "$CF_ORIGEM_URL" "${!nome}")"; b="$(q "$DESTINO_DB" "${!nome}")"
  if [ "$a" = "$b" ]; then echo "    ok  $nome"; else echo "    ERRO $nome difere"; falhas=$((falhas + 1)); fi
done
tabelas="$(q "$DESTINO_DB" "SELECT count(*) FROM pg_tables WHERE schemaname = 'app'")"
linhas="$(q "$DESTINO_DB" "SELECT sum(n_live_tup) FROM pg_stat_user_tables WHERE schemaname = 'app'")"
echo "    tabelas: $tabelas · migrações: $(q "$DESTINO_DB" "SELECT count(*) FROM public.schema_migrations")"

echo "5/5 Limpando…"
if [ "$MANTER" = "1" ]; then
  echo "    cópia mantida em ${NOME} (CF_MANTER_COPIA=1); apague quando terminar"
else
  q "$CF_DESTINO_URL" "DROP DATABASE ${NOME}"
fi

echo "Tempo total: $(( $(date +%s) - inicio )) s (até a cópia restaurada: $(( fim_restauro - inicio )) s); linhas estimadas: ${linhas:-0}"
if [ "$falhas" -gt 0 ]; then echo "FALHOU: $falhas conferência(s) diferente(s)"; exit 1; fi
echo "OK: a cópia restaurada é fiel à origem"
