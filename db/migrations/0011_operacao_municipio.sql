-- Consulta Fácil 2.0 — migração 0011: prontidão operacional.
--
-- Município fora do estado 'ativo' (suspenso, encerrando, encerrado) não recebe e-mail: as
-- notificações pendentes ficam guardadas e saem quando o município volta a 'ativo'. As
-- rotinas (lista de espera, lembretes) já ignoravam municípios inativos (0010).

SET ROLE cf_owner;

CREATE OR REPLACE FUNCTION app.notificacao_reservar_lote(p_limite integer)
  RETURNS TABLE (id uuid, tenant_id uuid, modelo text, dados jsonb, pessoa_id uuid, email_cifrado bytea, tentativas smallint)
  LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  WITH lote AS (
    SELECT n.id FROM app.notificacao n
    JOIN app.tenant t ON t.id = n.tenant_id AND t.estado = 'ativo'
    WHERE n.estado = 'pendente' AND n.proxima_em <= now()
    ORDER BY n.proxima_em
    LIMIT least(p_limite, 100)
    FOR UPDATE OF n SKIP LOCKED
  ), marcadas AS (
    UPDATE app.notificacao n SET tentativas = n.tentativas + 1, proxima_em = now() + interval '5 minutes'
    FROM lote WHERE n.id = lote.id
    RETURNING n.id, n.tenant_id, n.modelo, n.dados, n.pessoa_id, n.tentativas
  )
  SELECT m.id, m.tenant_id, m.modelo, m.dados, m.pessoa_id, p.email_cifrado, m.tentativas
  FROM marcadas m JOIN app.pessoa p ON p.id = m.pessoa_id
$$;

-- Situação pública do município pelo endereço: só nome e estado, para mostrar o aviso de
-- suspensão em vez de "endereço desconhecido". Não revela nada de município provisionando.
CREATE FUNCTION app.municipio_situacao(p_slug text)
  RETURNS TABLE (nome text, estado text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  SELECT nome, estado FROM app.tenant
  WHERE slug = p_slug AND estado IN ('suspenso', 'encerrando', 'encerrado')
$$;

RESET ROLE;

REVOKE ALL ON FUNCTION app.municipio_situacao(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.municipio_situacao(text) TO cf_app;
