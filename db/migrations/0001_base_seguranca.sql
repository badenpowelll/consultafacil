-- Consulta Fácil 2.0 — migração 0001: papéis, contexto de município e funções de apoio.
--
-- Modelo de privilégios:
--   cf_owner : dono do esquema e das tabelas. NOLOGIN. Usado só por migrações (SET ROLE).
--   cf_app   : papel com LOGIN usado pela aplicação e pelo worker. Não é dono de nada,
--              não tem BYPASSRLS e só recebe os GRANTs explícitos abaixo.
-- A senha de cf_app NÃO fica aqui: é definida por `npm run db:app-password`.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cf_owner') THEN
    CREATE ROLE cf_owner NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cf_app') THEN
    CREATE ROLE cf_app LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- O usuário que executa as migrações precisa poder assumir cf_owner.
GRANT cf_owner TO CURRENT_USER;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION cf_owner;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO cf_app;

-- Ninguém além dos papéis explícitos cria objetos no esquema public.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

SET ROLE cf_owner;

-- Município do contexto da transação atual. NULL quando ausente: toda política
-- compara com tenant_id, e comparação com NULL nunca é verdadeira (falha fechada).
CREATE FUNCTION app.tenant_atual() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- Conta autenticada no contexto da transação atual.
CREATE FUNCTION app.conta_atual() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.conta_id', true), '')::uuid $$;

-- Impede UPDATE e DELETE em tabelas somente-inserção (auditoria, eventos).
CREATE FUNCTION app.bloquear_alteracao() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Tabela % é somente inserção', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END
$$;

RESET ROLE;
