-- Consulta Fácil 2.0 — migração 0005: barreiras contra vazamento nos links de ação.
--
-- Links enviados por e-mail (convite, recuperar senha, confirmar ou cancelar consulta,
-- documento) são credenciais ao portador. Aqui o banco garante, mesmo que a aplicação erre:
--   * prazo máximo por finalidade (link de recuperação de senha não vive mais que 1 hora);
--   * uso único: depois de usado não volta a valer, nem por UPDATE da aplicação;
--   * a aplicação só pode alterar a coluna usado_em (não estende prazo nem troca o objeto).

SET ROLE cf_owner;

ALTER TABLE app.token_acao ADD CONSTRAINT token_acao_prazo_maximo CHECK (
  expira_em > criado_em AND expira_em <= criado_em + CASE finalidade
    WHEN 'recuperar_senha'   THEN interval '1 hour'
    WHEN 'verificar_contato' THEN interval '1 hour'
    WHEN 'documento'         THEN interval '1 hour'
    WHEN 'checkin'           THEN interval '1 day'
    WHEN 'confirmar'         THEN interval '3 days'
    ELSE interval '7 days'
  END
);

CREATE FUNCTION app.token_acao_uso_unico() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.usado_em IS NOT NULL THEN
    RAISE EXCEPTION 'Link de ação já utilizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.usado_em IS NULL THEN
    RAISE EXCEPTION 'Atualização de link de ação só pode marcar uso' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.token_acao_uso_unico() FROM PUBLIC;

CREATE TRIGGER token_acao_uso_unico BEFORE UPDATE ON app.token_acao
  FOR EACH ROW EXECUTE FUNCTION app.token_acao_uso_unico();
CREATE TRIGGER token_acao_sem_truncate BEFORE TRUNCATE ON app.token_acao
  FOR EACH STATEMENT EXECUTE FUNCTION app.bloquear_alteracao();

CREATE INDEX token_acao_validos ON app.token_acao (tenant_id, expira_em) WHERE usado_em IS NULL;

RESET ROLE;

-- Privilégio por coluna: a aplicação marca o uso e nada mais.
REVOKE UPDATE ON app.token_acao FROM cf_app;
GRANT UPDATE (usado_em) ON app.token_acao TO cf_app;
