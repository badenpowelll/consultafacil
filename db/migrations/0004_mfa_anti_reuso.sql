-- Consulta Fácil 2.0 — migração 0004: impede reutilizar o mesmo código TOTP (ataque de repetição).

SET ROLE cf_owner;

ALTER TABLE app.conta ADD COLUMN mfa_ultimo_passo bigint NOT NULL DEFAULT 0;

-- Aceita o passo de tempo só se for posterior ao último usado. Atômico: dois usos simultâneos
-- do mesmo código não passam.
CREATE FUNCTION app.conta_mfa_consumir_passo(p_conta_id uuid, p_passo bigint)
  RETURNS boolean
  LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  WITH u AS (
    UPDATE app.conta SET mfa_ultimo_passo = p_passo
    WHERE id = p_conta_id AND mfa_ultimo_passo < p_passo RETURNING 1
  ) SELECT count(*) = 1 FROM u
$$;

REVOKE ALL ON FUNCTION app.conta_mfa_consumir_passo(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.conta_mfa_consumir_passo(uuid, bigint) TO cf_app;

RESET ROLE;
