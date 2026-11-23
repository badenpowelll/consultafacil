-- Consulta Fácil 2.0 — migração 0007: comprovante de agendamento com validação pública.
--
-- O comprovante traz um código de validação. O código em claro só existe no PDF e no QR code;
-- o banco guarda apenas o SHA-256 dele. A página pública de validação recebe o código, confere
-- o hash e mostra o mínimo para quem recebe o papel (situação, data, unidade, profissional e as
-- iniciais do paciente). Nome completo, CPF, contato e motivo nunca saem por esse caminho.

CREATE TABLE app.comprovante (
  tenant_id      uuid NOT NULL REFERENCES app.tenant (id),
  agendamento_id uuid NOT NULL,
  token_hash     bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  emitido_em     timestamptz NOT NULL DEFAULT now(),
  emitido_por    uuid REFERENCES app.conta (id),
  PRIMARY KEY (tenant_id, agendamento_id),
  FOREIGN KEY (tenant_id, agendamento_id) REFERENCES app.agendamento (tenant_id, id)
);
CREATE TRIGGER comprovante_somente_insercao BEFORE UPDATE OR DELETE ON app.comprovante
  FOR EACH ROW EXECUTE FUNCTION app.bloquear_alteracao();
CREATE TRIGGER comprovante_sem_truncate BEFORE TRUNCATE ON app.comprovante
  FOR EACH STATEMENT EXECUTE FUNCTION app.bloquear_alteracao();

ALTER TABLE app.comprovante ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.comprovante FORCE ROW LEVEL SECURITY;
CREATE POLICY comprovante_municipio ON app.comprovante TO cf_app
  USING (tenant_id = app.tenant_atual()) WITH CHECK (tenant_id = app.tenant_atual());
GRANT SELECT, INSERT ON app.comprovante TO cf_app;

-- Validação pública (sem sessão). O município vem do endereço acessado: um código de outro
-- município não é aceito. Devolve as iniciais, nunca o nome.
CREATE FUNCTION app.comprovante_validar(p_tenant uuid, p_token_hash bytea)
  RETURNS TABLE (estado text, inicio timestamptz, unidade text, profissional text, especialidade text,
                 iniciais text, municipio text, fuso text, emitido_em timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  SELECT a.estado, lower(v.periodo), u.nome, p.nome_exibicao, p.especialidade,
         (SELECT string_agg(upper(left(w, 1)) || '.', ' ')
            FROM regexp_split_to_table(pe.nome, '\s+') AS w
           WHERE length(w) > 2),
         t.nome, t.fuso, c.emitido_em
  FROM app.comprovante c
  JOIN app.agendamento a ON a.tenant_id = c.tenant_id AND a.id = c.agendamento_id
  JOIN app.vaga v ON v.tenant_id = a.tenant_id AND v.id = a.vaga_id
  JOIN app.unidade u ON u.tenant_id = v.tenant_id AND u.id = v.unidade_id
  JOIN app.profissional p ON p.tenant_id = v.tenant_id AND p.id = v.profissional_id
  JOIN app.vinculo vc ON vc.tenant_id = a.tenant_id AND vc.id = a.cidadao_vinculo_id
  JOIN app.conta co ON co.id = vc.conta_id
  JOIN app.pessoa pe ON pe.id = co.pessoa_id
  JOIN app.tenant t ON t.id = c.tenant_id
  WHERE c.tenant_id = p_tenant AND c.token_hash = p_token_hash AND length(p_token_hash) = 32
$$;

REVOKE ALL ON FUNCTION app.comprovante_validar(uuid, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.comprovante_validar(uuid, bytea) TO cf_app;
