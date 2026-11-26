-- Consulta Fácil 2.0 — migração 0012: reforço contra ataques automatizados (robôs e agentes de IA).
--
-- Bloqueio progressivo: quem estoura um limite (login, recuperação de senha, cadastro, busca,
-- exportação, marcação) fica bloqueado pela janela do limite; cada novo estouro dentro de 24 h
-- dobra o bloqueio, até 24 h. Durante o bloqueio as tentativas não contam nem passam. O nível
-- volta a zero depois de 24 h sem bloqueio, ou quando o login dá certo (limite_limpar).
--
-- Alerta de volume: a rotina de segurança (worker) registra na auditoria do município quem fez
-- ações demais em pouco tempo, uma vez por hora por conta, para o gestor ver e o suporte agir.

SET ROLE cf_owner;

ALTER TABLE app.limite_tentativa
  ADD COLUMN nivel smallint NOT NULL DEFAULT 0,
  ADD COLUMN bloqueado_em timestamptz,
  ADD COLUMN bloqueado_ate timestamptz;

CREATE OR REPLACE FUNCTION app.limite_consumir(p_chave text, p_limite integer, p_janela_segundos integer)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  l app.limite_tentativa%ROWTYPE;
  v_janela interval := make_interval(secs => p_janela_segundos);
BEGIN
  INSERT INTO app.limite_tentativa (chave, janela_inicio, contagem) VALUES (p_chave, now(), 0)
  ON CONFLICT (chave) DO NOTHING;
  SELECT * INTO l FROM app.limite_tentativa WHERE chave = p_chave FOR UPDATE;

  IF l.bloqueado_ate IS NOT NULL AND l.bloqueado_ate > now() THEN
    RETURN false;
  END IF;
  IF l.bloqueado_ate IS NOT NULL AND l.bloqueado_ate < now() - interval '24 hours' THEN
    l.nivel := 0;
  END IF;

  IF l.janela_inicio + v_janela <= now() THEN
    l.contagem := 1;
    l.janela_inicio := now();
  ELSE
    l.contagem := l.contagem + 1;
  END IF;

  IF l.contagem > p_limite THEN
    l.nivel := least(l.nivel + 1, 10);
    UPDATE app.limite_tentativa SET
      contagem = 0, janela_inicio = now(), nivel = l.nivel, bloqueado_em = now(),
      bloqueado_ate = now() + least(v_janela * power(2, l.nivel - 1)::integer, interval '24 hours')
    WHERE chave = p_chave;
    RETURN false;
  END IF;

  UPDATE app.limite_tentativa SET contagem = l.contagem, janela_inicio = l.janela_inicio, nivel = l.nivel
  WHERE chave = p_chave;
  RETURN true;
END
$$;

-- ---------------------------------------------------------------- rotina de segurança
-- A rotina roda como dona (definer) e lê a auditoria de todos os municípios; só insere alertas.
CREATE POLICY auditoria_seguranca_leitura_dono ON app.auditoria FOR SELECT TO cf_owner USING (true);
CREATE POLICY auditoria_seguranca_alerta_dono ON app.auditoria FOR INSERT TO cf_owner
  WITH CHECK (modulo = 'seguranca' AND acao LIKE 'seguranca.%');

-- Contas com volume anormal de ações nos últimos 10 minutos, por município. Registra uma vez
-- por hora por conta e devolve o que registrou (sem dado pessoal: só ids e contagens).
CREATE FUNCTION app.seguranca_volume_anormal(p_limite integer)
  RETURNS TABLE (tenant_id uuid, conta_id uuid, acoes integer)
  LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  WITH volume AS (
    SELECT a.tenant_id, a.conta_id, count(*)::integer AS acoes
    FROM app.auditoria a
    WHERE a.criado_em > now() - interval '10 minutes' AND a.conta_id IS NOT NULL AND a.modulo <> 'seguranca'
    GROUP BY a.tenant_id, a.conta_id
    HAVING count(*) > p_limite
  ), novos AS (
    SELECT v.* FROM volume v
    WHERE NOT EXISTS (
      SELECT 1 FROM app.auditoria x
      WHERE x.tenant_id = v.tenant_id AND x.acao = 'seguranca.volume_anormal'
        AND x.objeto_id = v.conta_id::text AND x.criado_em > now() - interval '1 hour')
  ), registro AS (
    INSERT INTO app.auditoria (tenant_id, conta_id, acao, modulo, objeto_tipo, objeto_id, detalhes)
    SELECT n.tenant_id, NULL, 'seguranca.volume_anormal', 'seguranca', 'conta', n.conta_id::text,
           jsonb_build_object('acoes_10min', n.acoes, 'limite', p_limite)
    FROM novos n
    RETURNING 1
  )
  SELECT n.tenant_id, n.conta_id, n.acoes FROM novos n, (SELECT count(*) FROM registro) r
$$;

-- Bloqueios progressivos que começaram nos últimos minutos, por tipo de limite (prefixo da chave).
CREATE FUNCTION app.seguranca_bloqueios_recentes(p_minutos integer)
  RETURNS TABLE (tipo text, bloqueios integer, nivel_maximo integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  SELECT split_part(chave, ':', 1), count(*)::integer, max(nivel)::integer
  FROM app.limite_tentativa
  WHERE bloqueado_em > now() - make_interval(mins => p_minutos)
  GROUP BY 1 ORDER BY 2 DESC
$$;

RESET ROLE;

REVOKE ALL ON FUNCTION app.seguranca_volume_anormal(integer), app.seguranca_bloqueios_recentes(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.seguranca_volume_anormal(integer), app.seguranca_bloqueios_recentes(integer) TO cf_app;
