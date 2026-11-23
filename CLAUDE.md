# Instruções para assistentes de código

- Leia `docs/seguranca/politica-seguranca-informacao.md` antes de mexer em autenticação, banco ou dados pessoais.
- Só dados fictícios. Nunca use, copie ou peça dados reais nem credenciais do sistema antigo.
- Toda tabela municipal: `tenant_id`, RLS forçado com política `<tabela>_municipio`, FKs compostas e teste de isolamento em `tests/integration/`.
- Acesso a dados municipais só dentro de `comMunicipio`. Identidade só por funções `SECURITY DEFINER` (`search_path = app, pg_temp`, `REVOKE ... FROM PUBLIC`, `GRANT EXECUTE ... TO cf_app`).
- SQL sempre parametrizado; o lint bloqueia interpolação em `.query()`.
- Migrações são imutáveis depois de aplicadas (o checksum é conferido): crie uma nova.
- Dependência nova: versão exata, conferir que o pacote existe e é o conhecido, justificar no PR.
- Antes do PR: `npm run lint && npm run typecheck && npm test && npm run build`.
