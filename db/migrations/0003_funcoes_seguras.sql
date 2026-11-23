-- Consulta Fácil 2.0 — migração 0003: ocupação global, limites de tentativa, catálogo de
-- permissões e funções SECURITY DEFINER de propósito único.
--
-- Regras para toda função SECURITY DEFINER deste arquivo:
--   * search_path fixo (app, pg_temp) para evitar sequestro de objetos;
--   * EXECUTE revogado de PUBLIC e concedido só a cf_app;
--   * devolve o mínimo necessário, nunca linhas inteiras de tabelas sensíveis.

SET ROLE cf_owner;

-- ---------------------------------------------------------------- ocupação global da pessoa
-- Regra de Baden (23/11/2026): médico e paciente podem ter vínculo com vários locais e
-- municípios, mas nunca dois compromissos sobrepostos. Esta tabela é a única ponte entre
-- municípios e não guarda nada além do período ocupado.
CREATE TABLE app.ocupacao_pessoa (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pessoa_id uuid NOT NULL REFERENCES app.pessoa (id),
  periodo   tstzrange NOT NULL CHECK (NOT isempty(periodo) AND lower_inc(periodo) AND NOT upper_inc(periodo)),
  tenant_id uuid NOT NULL REFERENCES app.tenant (id),
  referencia uuid NOT NULL UNIQUE,           -- id opaco do slot/agendamento que ocupou
  EXCLUDE USING gist (pessoa_id WITH =, periodo WITH &&)
);
ALTER TABLE app.ocupacao_pessoa ENABLE ROW LEVEL SECURITY;  -- sem política para cf_app

-- ---------------------------------------------------------------- limites de tentativa
CREATE TABLE app.limite_tentativa (
  chave        text PRIMARY KEY,              -- ex.: login:<hmac-do-identificador>, ip:<hmac-do-ip>
  janela_inicio timestamptz NOT NULL,
  contagem     integer NOT NULL
);
ALTER TABLE app.limite_tentativa ENABLE ROW LEVEL SECURITY;

-- Vínculos da própria conta, vistos por funções do dono mesmo com RLS forçado.
CREATE POLICY vinculo_da_propria_conta ON app.vinculo FOR SELECT TO cf_owner
  USING (conta_id = app.conta_atual());
CREATE POLICY tenant_dono ON app.tenant TO cf_owner USING (true) WITH CHECK (true);
CREATE POLICY vinculo_permissoes_dono ON app.vinculo_perfil FOR SELECT TO cf_owner
  USING (tenant_id = app.tenant_atual());
CREATE POLICY perfil_permissao_dono ON app.perfil_permissao FOR SELECT TO cf_owner
  USING (tenant_id = app.tenant_atual());

-- ---------------------------------------------------------------- catálogo de permissões
INSERT INTO app.permissao (codigo, modulo, descricao, clinica) VALUES
  ('agenda.ver',                 'agendamento', 'Ver agendas e vagas', false),
  ('agenda.marcar',              'agendamento', 'Marcar consultas para cidadãos', false),
  ('agenda.desmarcar',           'agendamento', 'Desmarcar consultas com motivo', false),
  ('agenda.remarcar',            'agendamento', 'Remarcar consultas', false),
  ('escala.editar',              'agendamento', 'Criar e publicar escalas', false),
  ('vagas.lote',                 'agendamento', 'Abrir e bloquear vagas em lote', false),
  ('ausencia.registrar',         'agendamento', 'Registrar ausência e remanejar', false),
  ('recepcao.checkin',           'recepcao',    'Fazer check-in de pacientes', false),
  ('recepcao.fechar_agenda',     'recepcao',    'Registrar presença e falta', false),
  ('recepcao.assistido',         'recepcao',    'Atender cidadão em modo assistido', false),
  ('cidadao.ver',                'cadastro',    'Ver cadastro de cidadãos', false),
  ('cidadao.editar',             'cadastro',    'Editar cadastro de cidadãos', false),
  ('cidadao.aprovar',            'cadastro',    'Aprovar residência e cadastro', false),
  ('cidadao.bloquear',           'cadastro',    'Bloquear e desbloquear cidadãos', false),
  ('gestao.painel',              'gestao',      'Ver painel e indicadores', false),
  ('gestao.exportar',            'gestao',      'Exportar relatórios', false),
  ('gestao.configurar',          'gestao',      'Alterar configurações do município', false),
  ('gestao.identidade_visual',   'gestao',      'Alterar logomarca, brasão e cores', false),
  ('gestao.unidades',            'gestao',      'Cadastrar unidades', false),
  ('gestao.perfis',              'gestao',      'Criar perfis e atribuir permissões', false),
  ('gestao.profissionais',       'gestao',      'Convidar e gerenciar profissionais', false),
  ('auditoria.ver',              'auditoria',   'Consultar a auditoria', false),
  ('auditoria.exportar',         'auditoria',   'Exportar a auditoria', false),
  ('clinico.observacao.ver',     'clinico',     'Ler observações clínicas internas', true),
  ('clinico.observacao.escrever','clinico',     'Registrar observações clínicas internas', true),
  ('enfermagem.triagem',         'enfermagem',  'Registrar triagem e sinais vitais', true);

-- ---------------------------------------------------------------- funções: pessoa e conta
CREATE FUNCTION app.pessoa_registrar(p_nome text, p_cpf_cifrado bytea, p_cpf_indice bytea, p_nascimento date)
  RETURNS TABLE (pessoa_id uuid, criada boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
BEGIN
  INSERT INTO app.pessoa (nome, cpf_cifrado, cpf_indice, nascimento)
  VALUES (p_nome, p_cpf_cifrado, p_cpf_indice, p_nascimento)
  ON CONFLICT (cpf_indice) DO NOTHING
  RETURNING id, true INTO pessoa_id, criada;
  IF pessoa_id IS NULL THEN
    SELECT p.id, false INTO pessoa_id, criada FROM app.pessoa p WHERE p.cpf_indice = p_cpf_indice;
  END IF;
  RETURN NEXT;
END
$$;

CREATE FUNCTION app.conta_criar(p_pessoa_id uuid, p_senha_hash text)
  RETURNS uuid
  LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  INSERT INTO app.conta (pessoa_id, senha_hash) VALUES (p_pessoa_id, p_senha_hash) RETURNING id
$$;

-- Dados mínimos para verificar uma tentativa de login. Nunca devolve CPF nem nome.
CREATE FUNCTION app.auth_buscar_conta(p_cpf_indice bytea)
  RETURNS TABLE (conta_id uuid, senha_hash text, mfa_ativo boolean, mfa_segredo_cifrado bytea, bloqueada boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  SELECT c.id, c.senha_hash, c.mfa_ativo, c.mfa_segredo_cifrado, c.bloqueada
  FROM app.conta c JOIN app.pessoa p ON p.id = c.pessoa_id
  WHERE p.cpf_indice = p_cpf_indice
$$;

CREATE FUNCTION app.conta_mfa_dados(p_conta_id uuid)
  RETURNS TABLE (mfa_ativo boolean, mfa_segredo_cifrado bytea)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$ SELECT mfa_ativo, mfa_segredo_cifrado FROM app.conta WHERE id = p_conta_id $$;

CREATE FUNCTION app.conta_definir_mfa(p_conta_id uuid, p_segredo_cifrado bytea, p_ativo boolean)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp
AS $$ UPDATE app.conta SET mfa_segredo_cifrado = p_segredo_cifrado, mfa_ativo = p_ativo WHERE id = p_conta_id $$;

-- ---------------------------------------------------------------- funções: sessão
CREATE FUNCTION app.sessao_criar(p_id_hash bytea, p_conta_id uuid, p_expira_absoluta timestamptz, p_mfa boolean)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  INSERT INTO app.sessao (id_hash, conta_id, expira_absoluta, mfa_verificado)
  VALUES (p_id_hash, p_conta_id, p_expira_absoluta, p_mfa)
$$;

-- Valida e renova a atividade. Sessão vencida por inatividade ou prazo absoluto é revogada.
CREATE FUNCTION app.sessao_validar(p_id_hash bytea, p_ocioso_segundos integer)
  RETURNS TABLE (conta_id uuid, tenant_id uuid, mfa_verificado boolean, super_admin boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  s app.sessao%ROWTYPE;
  c app.conta%ROWTYPE;
BEGIN
  SELECT * INTO s FROM app.sessao WHERE id_hash = p_id_hash FOR UPDATE;
  IF NOT FOUND OR s.revogada_em IS NOT NULL THEN
    RETURN;
  END IF;
  IF s.expira_absoluta <= now() OR s.ultima_atividade + make_interval(secs => p_ocioso_segundos) <= now() THEN
    UPDATE app.sessao SET revogada_em = now(), motivo_revogacao = 'expirada' WHERE id_hash = p_id_hash;
    RETURN;
  END IF;
  SELECT * INTO c FROM app.conta WHERE id = s.conta_id;
  IF c.bloqueada THEN
    UPDATE app.sessao SET revogada_em = now(), motivo_revogacao = 'conta_bloqueada' WHERE id_hash = p_id_hash;
    RETURN;
  END IF;
  UPDATE app.sessao SET ultima_atividade = now() WHERE id_hash = p_id_hash;
  conta_id := s.conta_id; tenant_id := s.tenant_id; mfa_verificado := s.mfa_verificado; super_admin := c.super_admin;
  RETURN NEXT;
END
$$;

CREATE FUNCTION app.sessao_marcar_mfa(p_id_hash bytea)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp
AS $$ UPDATE app.sessao SET mfa_verificado = true WHERE id_hash = p_id_hash AND revogada_em IS NULL $$;

CREATE FUNCTION app.sessao_revogar(p_id_hash bytea, p_motivo text)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  UPDATE app.sessao SET revogada_em = now(), motivo_revogacao = p_motivo
  WHERE id_hash = p_id_hash AND revogada_em IS NULL
$$;

-- Revoga todas as sessões ativas de uma conta (troca de senha, mudança de perfil, suspensão).
CREATE FUNCTION app.sessao_revogar_conta(p_conta_id uuid, p_motivo text)
  RETURNS integer
  LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  WITH r AS (
    UPDATE app.sessao SET revogada_em = now(), motivo_revogacao = p_motivo
    WHERE conta_id = p_conta_id AND revogada_em IS NULL RETURNING 1
  ) SELECT count(*)::integer FROM r
$$;

-- Revoga sessões de todas as contas que atuam no município (suspensão do município).
CREATE FUNCTION app.sessao_revogar_municipio(p_tenant_id uuid, p_motivo text)
  RETURNS integer
  LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  WITH r AS (
    UPDATE app.sessao SET revogada_em = now(), motivo_revogacao = p_motivo
    WHERE tenant_id = p_tenant_id AND revogada_em IS NULL RETURNING 1
  ) SELECT count(*)::integer FROM r
$$;

-- Escolha explícita do município de atuação. Exige município ativo e vínculo ativo.
CREATE FUNCTION app.sessao_definir_municipio(p_id_hash bytea, p_tenant_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_conta uuid;
BEGIN
  SELECT conta_id INTO v_conta FROM app.sessao WHERE id_hash = p_id_hash AND revogada_em IS NULL;
  IF v_conta IS NULL THEN RETURN false; END IF;
  PERFORM set_config('app.conta_id', v_conta::text, true);
  IF NOT EXISTS (
    SELECT 1 FROM app.vinculo v JOIN app.tenant t ON t.id = v.tenant_id
    WHERE v.conta_id = v_conta AND v.tenant_id = p_tenant_id AND v.estado = 'ativo' AND t.estado = 'ativo'
  ) THEN
    RETURN false;
  END IF;
  UPDATE app.sessao SET tenant_id = p_tenant_id WHERE id_hash = p_id_hash;
  RETURN true;
END
$$;

-- Municípios em que a conta autenticada tem vínculo ativo (para a tela de escolha).
CREATE FUNCTION app.meus_municipios()
  RETURNS TABLE (tenant_id uuid, slug text, nome text, papel text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  SELECT t.id, t.slug, t.nome, v.papel
  FROM app.vinculo v JOIN app.tenant t ON t.id = v.tenant_id
  WHERE v.conta_id = app.conta_atual() AND v.estado = 'ativo' AND t.estado = 'ativo'
  ORDER BY t.nome
$$;

-- ---------------------------------------------------------------- funções: autorização
-- Permissões efetivas da conta autenticada no município do contexto, para uma unidade
-- (ou NULL = permissões válidas em todo o município). Gestor ativo recebe todas as
-- permissões não clínicas; permissões clínicas só vêm de perfis atribuídos.
CREATE FUNCTION app.minhas_permissoes(p_unidade_id uuid)
  RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  SELECT p.codigo FROM app.permissao p
  WHERE NOT p.clinica AND EXISTS (
    SELECT 1 FROM app.vinculo v JOIN app.tenant t ON t.id = v.tenant_id
    WHERE v.conta_id = app.conta_atual() AND v.tenant_id = app.tenant_atual()
      AND v.papel = 'gestor' AND v.estado = 'ativo' AND t.estado = 'ativo')
  UNION
  SELECT pp.permissao
  FROM app.vinculo v
  JOIN app.tenant t ON t.id = v.tenant_id AND t.estado = 'ativo'
  JOIN app.vinculo_perfil vp ON vp.tenant_id = v.tenant_id AND vp.vinculo_id = v.id
  JOIN app.perfil_permissao pp ON pp.tenant_id = vp.tenant_id AND pp.perfil_id = vp.perfil_id
  WHERE v.conta_id = app.conta_atual() AND v.tenant_id = app.tenant_atual() AND v.estado = 'ativo'
    AND (vp.unidade_id IS NULL OR vp.unidade_id = p_unidade_id)
$$;

-- ---------------------------------------------------------------- funções: municípios
CREATE FUNCTION app.municipio_provisionar(p_slug text, p_nome text)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.conta WHERE id = app.conta_atual() AND super_admin AND NOT bloqueada) THEN
    RAISE EXCEPTION 'Somente o Super Admin provisiona municípios' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO app.tenant (slug, nome) VALUES (p_slug, p_nome) RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

CREATE FUNCTION app.municipio_alterar_estado(p_tenant_id uuid, p_estado text)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.conta WHERE id = app.conta_atual() AND super_admin AND NOT bloqueada) THEN
    RAISE EXCEPTION 'Somente o Super Admin altera o estado de municípios' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE app.tenant SET estado = p_estado, alterado_em = now() WHERE id = p_tenant_id;
  IF p_estado IN ('suspenso', 'encerrando', 'encerrado') THEN
    PERFORM app.sessao_revogar_municipio(p_tenant_id, 'municipio_' || p_estado);
  END IF;
END
$$;

-- ---------------------------------------------------------------- funções: ocupação global
-- Reserva o período para a pessoa no município do contexto. Devolve apenas livre/conflito,
-- sem revelar onde está o outro compromisso.
CREATE FUNCTION app.ocupacao_reservar(p_pessoa_id uuid, p_periodo tstzrange, p_referencia uuid)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
BEGIN
  IF app.tenant_atual() IS NULL THEN
    RAISE EXCEPTION 'Contexto de município ausente' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO app.ocupacao_pessoa (pessoa_id, periodo, tenant_id, referencia)
  VALUES (p_pessoa_id, p_periodo, app.tenant_atual(), p_referencia);
  RETURN true;
EXCEPTION WHEN exclusion_violation THEN
  RETURN false;
END
$$;

CREATE FUNCTION app.ocupacao_liberar(p_referencia uuid)
  RETURNS boolean
  LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  WITH d AS (
    DELETE FROM app.ocupacao_pessoa
    WHERE referencia = p_referencia AND tenant_id = app.tenant_atual() RETURNING 1
  ) SELECT count(*) > 0 FROM d
$$;

-- ---------------------------------------------------------------- funções: limite de tentativas
-- Janela fixa. Devolve true se a tentativa está dentro do limite.
CREATE FUNCTION app.limite_consumir(p_chave text, p_limite integer, p_janela_segundos integer)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_contagem integer;
BEGIN
  INSERT INTO app.limite_tentativa AS l (chave, janela_inicio, contagem)
  VALUES (p_chave, now(), 1)
  ON CONFLICT (chave) DO UPDATE SET
    contagem = CASE WHEN l.janela_inicio + make_interval(secs => p_janela_segundos) <= now() THEN 1 ELSE l.contagem + 1 END,
    janela_inicio = CASE WHEN l.janela_inicio + make_interval(secs => p_janela_segundos) <= now() THEN now() ELSE l.janela_inicio END
  RETURNING contagem INTO v_contagem;
  RETURN v_contagem <= p_limite;
END
$$;

CREATE FUNCTION app.limite_limpar(p_chave text)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp
AS $$ DELETE FROM app.limite_tentativa WHERE chave = p_chave $$;

-- ---------------------------------------------------------------- permissões de execução
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS assinatura
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.assinatura);
  END LOOP;
END
$$;

GRANT EXECUTE ON FUNCTION
  app.tenant_atual(), app.conta_atual(),
  app.pessoa_registrar(text, bytea, bytea, date), app.conta_criar(uuid, text),
  app.auth_buscar_conta(bytea), app.conta_mfa_dados(uuid), app.conta_definir_mfa(uuid, bytea, boolean),
  app.sessao_criar(bytea, uuid, timestamptz, boolean), app.sessao_validar(bytea, integer),
  app.sessao_marcar_mfa(bytea), app.sessao_revogar(bytea, text), app.sessao_revogar_conta(uuid, text),
  app.sessao_definir_municipio(bytea, uuid), app.meus_municipios(), app.minhas_permissoes(uuid),
  app.municipio_provisionar(text, text), app.municipio_alterar_estado(uuid, text),
  app.ocupacao_reservar(uuid, tstzrange, uuid), app.ocupacao_liberar(uuid),
  app.limite_consumir(text, integer, integer), app.limite_limpar(text)
TO cf_app;

RESET ROLE;
