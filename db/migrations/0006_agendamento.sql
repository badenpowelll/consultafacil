-- Consulta Fácil 2.0 — migração 0006: agendamento do paciente.
--
-- Profissionais, escalas (dias e horários de cada um), vagas geradas das escalas, consultas com
-- máquina de estados, histórico imutável de cada consulta e fila de notificações (e-mail).
--
-- Regras que o banco garante, mesmo que a aplicação erre:
--   * nenhuma vaga sobreposta para o mesmo profissional no município (exclusão GiST);
--   * a mesma pessoa (médico ou paciente) nunca ocupa dois horários sobrepostos, em nenhum
--     município (app.ocupacao_pessoa, via app.ocupacao_reservar);
--   * uma vaga tem no máximo uma consulta ativa;
--   * só transições de estado permitidas; toda transição gera evento no histórico;
--   * consulta marcada só deixa de valer por ação explícita de uma pessoa (não há expiração).

SET ROLE cf_owner;

-- ---------------------------------------------------------------- ajustes em tabelas existentes
-- Fuso do município: escalas são horários locais.
ALTER TABLE app.tenant ADD COLUMN fuso text NOT NULL DEFAULT 'America/Fortaleza'
  CHECK (fuso ~ '^[A-Za-z_]+(/[A-Za-z_]+)+$');

-- Contato para avisos. Cifrado como o CPF; só a função do worker o devolve.
ALTER TABLE app.pessoa ADD COLUMN email_cifrado bytea;

-- Funções do dono (gatilhos) precisam ler vínculos do município do contexto.
CREATE POLICY vinculo_municipio_dono ON app.vinculo FOR SELECT TO cf_owner
  USING (tenant_id = app.tenant_atual());

-- ---------------------------------------------------------------- profissionais
CREATE TABLE app.profissional (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES app.tenant (id),
  vinculo_id    uuid NOT NULL,
  pessoa_id     uuid NOT NULL REFERENCES app.pessoa (id),   -- preenchido por gatilho, nunca pela aplicação
  nome_exibicao text NOT NULL CHECK (length(nome_exibicao) BETWEEN 2 AND 120),
  especialidade text NOT NULL CHECK (length(especialidade) BETWEEN 2 AND 80),
  registro      text CHECK (registro IS NULL OR registro ~ '^[A-Z]{2,6}[- ]?[A-Z]{2}[- ]?[0-9]{1,8}$'),
  ativo         boolean NOT NULL DEFAULT true,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, vinculo_id),
  FOREIGN KEY (tenant_id, vinculo_id) REFERENCES app.vinculo (tenant_id, id)
);

-- ---------------------------------------------------------------- escalas
-- dia_semana segue extract(dow): 0 = domingo ... 6 = sábado. Horários locais do município.
CREATE TABLE app.escala (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES app.tenant (id),
  profissional_id uuid NOT NULL,
  unidade_id      uuid NOT NULL,
  dia_semana      smallint NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
  hora_inicio     time NOT NULL,
  hora_fim        time NOT NULL,
  duracao_min     smallint NOT NULL CHECK (duracao_min BETWEEN 5 AND 240),
  vigencia_inicio date NOT NULL,
  vigencia_fim    date,
  ativa           boolean NOT NULL DEFAULT true,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  CHECK (hora_fim > hora_inicio),
  CHECK (vigencia_fim IS NULL OR vigencia_fim >= vigencia_inicio),
  FOREIGN KEY (tenant_id, profissional_id) REFERENCES app.profissional (tenant_id, id),
  FOREIGN KEY (tenant_id, unidade_id) REFERENCES app.unidade (tenant_id, id)
);

-- ---------------------------------------------------------------- vagas
CREATE TABLE app.vaga (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES app.tenant (id),
  profissional_id uuid NOT NULL,
  unidade_id      uuid NOT NULL,
  escala_id       uuid,
  periodo         tstzrange NOT NULL CHECK (NOT isempty(periodo) AND lower_inc(periodo) AND NOT upper_inc(periodo)),
  estado          text NOT NULL DEFAULT 'livre' CHECK (estado IN ('livre', 'reservada', 'bloqueada')),
  criado_em       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, profissional_id) REFERENCES app.profissional (tenant_id, id),
  FOREIGN KEY (tenant_id, unidade_id) REFERENCES app.unidade (tenant_id, id),
  FOREIGN KEY (tenant_id, escala_id) REFERENCES app.escala (tenant_id, id),
  EXCLUDE USING gist (tenant_id WITH =, profissional_id WITH =, periodo WITH &&)
);
CREATE INDEX vaga_busca ON app.vaga (tenant_id, unidade_id, lower(periodo)) WHERE estado = 'livre';

-- ---------------------------------------------------------------- consultas
CREATE TABLE app.agendamento (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES app.tenant (id),
  vaga_id             uuid NOT NULL,
  cidadao_vinculo_id  uuid NOT NULL,
  pessoa_id           uuid NOT NULL REFERENCES app.pessoa (id),  -- preenchido por gatilho
  estado              text NOT NULL DEFAULT 'marcada' CHECK (estado IN (
                        'marcada', 'confirmada', 'aguardando_remanejamento', 'presente',
                        'atendida', 'faltou', 'cancelada_cidadao', 'cancelada_unidade', 'remarcada')),
  remarcada_de        uuid,
  marcada_por         uuid,          -- conta que marcou (o próprio cidadão ou alguém da equipe)
  motivo              text CHECK (motivo IS NULL OR length(motivo) <= 300),
  criado_em           timestamptz NOT NULL DEFAULT now(),
  alterado_em         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, vaga_id) REFERENCES app.vaga (tenant_id, id),
  FOREIGN KEY (tenant_id, cidadao_vinculo_id) REFERENCES app.vinculo (tenant_id, id),
  FOREIGN KEY (tenant_id, remarcada_de) REFERENCES app.agendamento (tenant_id, id)
);
-- Uma vaga, no máximo uma consulta ativa.
CREATE UNIQUE INDEX agendamento_vaga_ativa ON app.agendamento (vaga_id)
  WHERE estado IN ('marcada', 'confirmada', 'aguardando_remanejamento', 'presente', 'atendida', 'faltou');
CREATE INDEX agendamento_cidadao ON app.agendamento (tenant_id, cidadao_vinculo_id, criado_em DESC);

CREATE TABLE app.agendamento_evento (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES app.tenant (id),
  agendamento_id  uuid NOT NULL,
  estado_anterior text,
  estado_novo     text NOT NULL,
  conta_id        uuid,
  motivo          text,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, agendamento_id) REFERENCES app.agendamento (tenant_id, id)
);
CREATE TRIGGER agendamento_evento_somente_insercao BEFORE UPDATE OR DELETE ON app.agendamento_evento
  FOR EACH ROW EXECUTE FUNCTION app.bloquear_alteracao();
CREATE TRIGGER agendamento_evento_sem_truncate BEFORE TRUNCATE ON app.agendamento_evento
  FOR EACH STATEMENT EXECUTE FUNCTION app.bloquear_alteracao();

-- ---------------------------------------------------------------- fila de notificações
-- Guarda só identificadores e dados não pessoais. O endereço é resolvido pelo worker na hora do envio.
CREATE TABLE app.notificacao (
  id          uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES app.tenant (id),
  pessoa_id   uuid NOT NULL REFERENCES app.pessoa (id),
  canal       text NOT NULL DEFAULT 'email' CHECK (canal IN ('email')),
  modelo      text NOT NULL CHECK (modelo IN ('consulta_marcada', 'consulta_desmarcada', 'profissional_ausente', 'consulta_remarcada')),
  dados       jsonb NOT NULL DEFAULT '{}'::jsonb,
  estado      text NOT NULL DEFAULT 'pendente' CHECK (estado IN ('pendente', 'enviada', 'falhou', 'sem_contato')),
  tentativas  smallint NOT NULL DEFAULT 0,
  proxima_em  timestamptz NOT NULL DEFAULT now(),
  enviada_em  timestamptz,
  criado_em   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notificacao_pendente ON app.notificacao (proxima_em) WHERE estado = 'pendente';

-- ---------------------------------------------------------------- RLS municipal (forçado)
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['profissional', 'escala', 'vaga', 'agendamento', 'agendamento_evento', 'notificacao']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON app.%I TO cf_app USING (tenant_id = app.tenant_atual()) WITH CHECK (tenant_id = app.tenant_atual())',
      t || '_municipio', t);
  END LOOP;
END
$$;

-- UPDATE só nas colunas que podem mudar. pessoa_id, vaga e cidadão nunca são alterados pela aplicação
-- (e pessoa_id, mesmo no INSERT, é sobrescrito pelo gatilho a partir do vínculo).
GRANT SELECT, INSERT ON app.profissional, app.escala, app.vaga, app.agendamento TO cf_app;
GRANT UPDATE (nome_exibicao, especialidade, registro, ativo) ON app.profissional TO cf_app;
GRANT UPDATE (ativa, vigencia_fim) ON app.escala TO cf_app;
GRANT UPDATE (estado) ON app.vaga TO cf_app;
GRANT DELETE ON app.vaga TO cf_app;   -- só usado ao desfazer vaga recém-criada em conflito
GRANT UPDATE (estado, motivo, alterado_em) ON app.agendamento TO cf_app;
GRANT SELECT, INSERT ON app.agendamento_evento, app.notificacao TO cf_app;
GRANT UPDATE (modelo) ON app.notificacao TO cf_app;

-- ---------------------------------------------------------------- gatilhos
-- Pessoa do vínculo, sempre do município do contexto. Impede a aplicação de apontar outra pessoa.
CREATE FUNCTION app.preencher_pessoa_do_vinculo() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_vinculo uuid;
BEGIN
  -- A coluna do vínculo vem como argumento do gatilho (vinculo_id ou cidadao_vinculo_id).
  v_vinculo := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  SELECT c.pessoa_id INTO NEW.pessoa_id
  FROM app.vinculo v JOIN app.conta c ON c.id = v.conta_id
  WHERE v.id = v_vinculo AND v.tenant_id = NEW.tenant_id AND v.estado = 'ativo';
  IF NEW.pessoa_id IS NULL THEN
    RAISE EXCEPTION 'Vínculo inexistente ou inativo neste município' USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER profissional_pessoa BEFORE INSERT ON app.profissional
  FOR EACH ROW EXECUTE FUNCTION app.preencher_pessoa_do_vinculo('vinculo_id');
CREATE TRIGGER agendamento_pessoa BEFORE INSERT ON app.agendamento
  FOR EACH ROW EXECUTE FUNCTION app.preencher_pessoa_do_vinculo('cidadao_vinculo_id');

-- Máquina de estados da consulta. Qualquer outra transição é recusada pelo banco.
CREATE FUNCTION app.agendamento_transicao_valida(p_de text, p_para text) RETURNS boolean
  LANGUAGE sql IMMUTABLE
AS $$
  SELECT (p_de, p_para) IN (
    ('marcada', 'confirmada'), ('marcada', 'cancelada_cidadao'), ('marcada', 'cancelada_unidade'),
    ('marcada', 'aguardando_remanejamento'), ('marcada', 'presente'), ('marcada', 'faltou'),
    ('marcada', 'remarcada'),
    ('confirmada', 'cancelada_cidadao'), ('confirmada', 'cancelada_unidade'),
    ('confirmada', 'aguardando_remanejamento'), ('confirmada', 'presente'), ('confirmada', 'faltou'),
    ('confirmada', 'remarcada'),
    ('aguardando_remanejamento', 'remarcada'), ('aguardando_remanejamento', 'cancelada_cidadao'),
    ('aguardando_remanejamento', 'cancelada_unidade'),
    ('presente', 'atendida'), ('presente', 'faltou')
  )
$$;

CREATE FUNCTION app.agendamento_validar_transicao() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.estado = OLD.estado THEN
    RETURN NEW;
  END IF;
  IF NOT app.agendamento_transicao_valida(OLD.estado, NEW.estado) THEN
    RAISE EXCEPTION 'Transição de % para % não permitida', OLD.estado, NEW.estado USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.vaga_id <> OLD.vaga_id OR NEW.cidadao_vinculo_id <> OLD.cidadao_vinculo_id THEN
    RAISE EXCEPTION 'Vaga e cidadão de uma consulta não mudam; use remarcação' USING ERRCODE = 'check_violation';
  END IF;
  NEW.alterado_em := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER agendamento_maquina_estados BEFORE UPDATE ON app.agendamento
  FOR EACH ROW EXECUTE FUNCTION app.agendamento_validar_transicao();

-- Histórico: depois da gravação, para a chave estrangeira do evento já encontrar a consulta.
CREATE FUNCTION app.agendamento_registrar_evento() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.estado = OLD.estado THEN
    RETURN NULL;
  END IF;
  INSERT INTO app.agendamento_evento (tenant_id, agendamento_id, estado_anterior, estado_novo, conta_id, motivo)
  VALUES (NEW.tenant_id, NEW.id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.estado END, NEW.estado, app.conta_atual(), NEW.motivo);
  RETURN NULL;
END
$$;
CREATE TRIGGER agendamento_historico AFTER INSERT OR UPDATE ON app.agendamento
  FOR EACH ROW EXECUTE FUNCTION app.agendamento_registrar_evento();
-- Consultas não são apagadas: o histórico é a prova do que aconteceu.
CREATE TRIGGER agendamento_sem_exclusao BEFORE DELETE ON app.agendamento
  FOR EACH ROW EXECUTE FUNCTION app.bloquear_alteracao();

-- ---------------------------------------------------------------- operações (SECURITY INVOKER: valem as políticas de cf_app)
-- Limite de consultas futuras ativas por cidadão no município: evita que um robô ou uma
-- pessoa tome várias vagas de uma vez.
CREATE FUNCTION app.limite_consultas_futuras() RETURNS integer
  LANGUAGE sql IMMUTABLE AS $$ SELECT 3 $$;

CREATE FUNCTION app.agendamento_marcar(p_vaga_id uuid, p_cidadao_vinculo_id uuid, p_remarcada_de uuid DEFAULT NULL)
  RETURNS uuid
  LANGUAGE plpgsql
  SET search_path = app, pg_temp
AS $$
DECLARE
  v_vaga app.vaga%ROWTYPE;
  v_id uuid;
  v_pessoa uuid;
  v_ativas integer;
BEGIN
  IF app.tenant_atual() IS NULL THEN
    RAISE EXCEPTION 'Contexto de município ausente' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_vaga FROM app.vaga WHERE id = p_vaga_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vaga_inexistente' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_vaga.estado <> 'livre' THEN
    RAISE EXCEPTION 'vaga_indisponivel' USING ERRCODE = 'unique_violation';
  END IF;
  IF lower(v_vaga.periodo) <= now() THEN
    RAISE EXCEPTION 'vaga_no_passado' USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM app.vinculo WHERE id = p_cidadao_vinculo_id AND papel = 'cidadao' AND estado = 'ativo') THEN
    RAISE EXCEPTION 'sem_vinculo_cidadao' USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT count(*) INTO v_ativas
  FROM app.agendamento a JOIN app.vaga v ON v.id = a.vaga_id
  WHERE a.cidadao_vinculo_id = p_cidadao_vinculo_id
    AND a.estado IN ('marcada', 'confirmada', 'aguardando_remanejamento')
    AND lower(v.periodo) > now()
    AND a.id IS DISTINCT FROM p_remarcada_de;
  IF v_ativas >= app.limite_consultas_futuras() THEN
    RAISE EXCEPTION 'limite_consultas' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO app.agendamento (tenant_id, vaga_id, cidadao_vinculo_id, pessoa_id, marcada_por, remarcada_de)
  VALUES (app.tenant_atual(), p_vaga_id, p_cidadao_vinculo_id, '00000000-0000-0000-0000-000000000000', app.conta_atual(), p_remarcada_de)
  RETURNING id, pessoa_id INTO v_id, v_pessoa;

  -- O paciente não pode estar em dois atendimentos ao mesmo tempo, em nenhum município.
  IF NOT app.ocupacao_reservar(v_pessoa, v_vaga.periodo, v_id) THEN
    RAISE EXCEPTION 'conflito_horario' USING ERRCODE = 'exclusion_violation';
  END IF;

  UPDATE app.vaga SET estado = 'reservada' WHERE id = p_vaga_id;
  INSERT INTO app.notificacao (tenant_id, pessoa_id, modelo, dados)
  VALUES (app.tenant_atual(), v_pessoa, 'consulta_marcada', jsonb_build_object('agendamento_id', v_id));
  RETURN v_id;
END
$$;

-- Desmarcar (cidadão ou unidade): a consulta fica no histórico e a vaga volta a ficar livre,
-- se ainda estiver no futuro.
CREATE FUNCTION app.agendamento_desmarcar(p_agendamento_id uuid, p_por_cidadao boolean, p_motivo text)
  RETURNS void
  LANGUAGE plpgsql
  SET search_path = app, pg_temp
AS $$
DECLARE
  v_ag app.agendamento%ROWTYPE;
BEGIN
  SELECT * INTO v_ag FROM app.agendamento WHERE id = p_agendamento_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'consulta_inexistente' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) < 3 THEN
    RAISE EXCEPTION 'motivo_obrigatorio' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE app.agendamento
  SET estado = CASE WHEN p_por_cidadao THEN 'cancelada_cidadao' ELSE 'cancelada_unidade' END, motivo = p_motivo
  WHERE id = p_agendamento_id;

  PERFORM app.ocupacao_liberar(p_agendamento_id);
  UPDATE app.vaga SET estado = 'livre'
  WHERE id = v_ag.vaga_id AND estado = 'reservada' AND lower(periodo) > now();

  INSERT INTO app.notificacao (tenant_id, pessoa_id, modelo, dados)
  VALUES (app.tenant_atual(), v_ag.pessoa_id, 'consulta_desmarcada',
          jsonb_build_object('agendamento_id', p_agendamento_id, 'pela_unidade', NOT p_por_cidadao));
END
$$;

-- Remarcar: a consulta antiga vira "remarcada" e a nova aponta para ela. Atômico.
CREATE FUNCTION app.agendamento_remarcar(p_agendamento_id uuid, p_nova_vaga_id uuid)
  RETURNS uuid
  LANGUAGE plpgsql
  SET search_path = app, pg_temp
AS $$
DECLARE
  v_ag app.agendamento%ROWTYPE;
  v_novo uuid;
BEGIN
  SELECT * INTO v_ag FROM app.agendamento WHERE id = p_agendamento_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'consulta_inexistente' USING ERRCODE = 'no_data_found';
  END IF;

  UPDATE app.agendamento SET estado = 'remarcada', motivo = 'remarcada' WHERE id = p_agendamento_id;
  PERFORM app.ocupacao_liberar(p_agendamento_id);
  UPDATE app.vaga SET estado = 'livre'
  WHERE id = v_ag.vaga_id AND estado = 'reservada' AND lower(periodo) > now();

  v_novo := app.agendamento_marcar(p_nova_vaga_id, v_ag.cidadao_vinculo_id, p_agendamento_id);
  UPDATE app.notificacao SET modelo = 'consulta_remarcada'
  WHERE tenant_id = app.tenant_atual() AND modelo = 'consulta_marcada' AND dados ->> 'agendamento_id' = v_novo::text;
  RETURN v_novo;
END
$$;

-- Ausência do profissional: bloqueia as vagas livres do período, põe as consultas em
-- "aguardando remanejamento" (continuam valendo até alguém agir) e avisa cada paciente por e-mail.
CREATE FUNCTION app.ausencia_registrar(p_profissional_id uuid, p_unidade_id uuid, p_periodo tstzrange, p_motivo text)
  RETURNS integer
  LANGUAGE plpgsql
  SET search_path = app, pg_temp
AS $$
DECLARE
  r record;
  v_afetadas integer := 0;
BEGIN
  IF p_motivo IS NULL OR length(trim(p_motivo)) < 3 THEN
    RAISE EXCEPTION 'motivo_obrigatorio' USING ERRCODE = 'check_violation';
  END IF;

  -- Só na unidade informada: a permissão de quem registra vale por unidade.
  UPDATE app.vaga SET estado = 'bloqueada'
  WHERE profissional_id = p_profissional_id AND unidade_id = p_unidade_id AND periodo && p_periodo AND estado = 'livre';

  FOR r IN
    SELECT a.id, a.pessoa_id
    FROM app.agendamento a JOIN app.vaga v ON v.id = a.vaga_id
    WHERE v.profissional_id = p_profissional_id AND v.unidade_id = p_unidade_id AND v.periodo && p_periodo
      AND a.estado IN ('marcada', 'confirmada')
    FOR UPDATE OF a
  LOOP
    UPDATE app.agendamento SET estado = 'aguardando_remanejamento', motivo = p_motivo WHERE id = r.id;
    INSERT INTO app.notificacao (tenant_id, pessoa_id, modelo, dados)
    VALUES (app.tenant_atual(), r.pessoa_id, 'profissional_ausente', jsonb_build_object('agendamento_id', r.id));
    v_afetadas := v_afetadas + 1;
  END LOOP;
  RETURN v_afetadas;
END
$$;

-- Gera as vagas de uma escala até a data informada (inclusive), em horário local do município.
-- Cada vaga reserva o horário do profissional na ocupação global: se ele já tem compromisso
-- sobreposto em outro município, a vaga não é criada e entra na contagem de conflitos.
CREATE FUNCTION app.vagas_gerar(p_escala_id uuid, p_ate date)
  RETURNS TABLE (criadas integer, conflitos integer)
  LANGUAGE plpgsql
  SET search_path = app, pg_temp
AS $$
DECLARE
  e app.escala%ROWTYPE;
  p app.profissional%ROWTYPE;
  v_fuso text;
  v_dia date;
  v_min integer;
  v_fim integer;
  v_periodo tstzrange;
  v_vaga uuid;
BEGIN
  criadas := 0; conflitos := 0;
  SELECT * INTO e FROM app.escala WHERE id = p_escala_id AND ativa;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'escala_inexistente' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_ate > current_date + 120 THEN
    RAISE EXCEPTION 'horizonte_maximo_120_dias' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO p FROM app.profissional WHERE id = e.profissional_id;
  SELECT fuso INTO v_fuso FROM app.tenant WHERE id = app.tenant_atual();

  v_dia := greatest(e.vigencia_inicio, current_date);
  WHILE v_dia <= least(p_ate, coalesce(e.vigencia_fim, p_ate)) LOOP
    IF extract(dow FROM v_dia) = e.dia_semana THEN
      -- Em minutos inteiros desde 00:00: aritmética de time daria a volta na meia-noite.
      v_min := extract(epoch FROM e.hora_inicio)::integer / 60;
      v_fim := extract(epoch FROM e.hora_fim)::integer / 60;
      WHILE v_min + e.duracao_min <= v_fim LOOP
        v_periodo := tstzrange((v_dia + make_interval(mins => v_min)) AT TIME ZONE v_fuso,
                               (v_dia + make_interval(mins => v_min + e.duracao_min)) AT TIME ZONE v_fuso, '[)');
        IF lower(v_periodo) > now() THEN
          v_vaga := NULL;
          INSERT INTO app.vaga (tenant_id, profissional_id, unidade_id, escala_id, periodo)
          VALUES (app.tenant_atual(), e.profissional_id, e.unidade_id, e.id, v_periodo)
          ON CONFLICT DO NOTHING
          RETURNING id INTO v_vaga;
          IF v_vaga IS NOT NULL THEN
            IF app.ocupacao_reservar(p.pessoa_id, v_periodo, v_vaga) THEN
              criadas := criadas + 1;
            ELSE
              DELETE FROM app.vaga WHERE id = v_vaga;
              conflitos := conflitos + 1;
            END IF;
          END IF;
        END IF;
        v_min := v_min + e.duracao_min;
      END LOOP;
    END IF;
    v_dia := v_dia + 1;
  END LOOP;
  RETURN NEXT;
END
$$;

-- ---------------------------------------------------------------- worker de notificações
-- Único ponto que devolve o contato da pessoa, e só para notificações pendentes. Uso exclusivo do worker.
CREATE FUNCTION app.notificacao_reservar_lote(p_limite integer)
  RETURNS TABLE (id uuid, tenant_id uuid, modelo text, dados jsonb, pessoa_id uuid, email_cifrado bytea, tentativas smallint)
  LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  WITH lote AS (
    SELECT n.id FROM app.notificacao n
    WHERE n.estado = 'pendente' AND n.proxima_em <= now()
    ORDER BY n.proxima_em
    LIMIT least(p_limite, 100)
    FOR UPDATE SKIP LOCKED
  ), marcadas AS (
    UPDATE app.notificacao n SET tentativas = n.tentativas + 1, proxima_em = now() + interval '5 minutes'
    FROM lote WHERE n.id = lote.id
    RETURNING n.id, n.tenant_id, n.modelo, n.dados, n.pessoa_id, n.tentativas
  )
  SELECT m.id, m.tenant_id, m.modelo, m.dados, m.pessoa_id, p.email_cifrado, m.tentativas
  FROM marcadas m JOIN app.pessoa p ON p.id = m.pessoa_id
$$;

CREATE FUNCTION app.notificacao_concluir(p_id uuid, p_estado text)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  UPDATE app.notificacao
  SET estado = CASE
        WHEN p_estado = 'falhou' AND tentativas < 5 THEN 'pendente'
        ELSE p_estado END,
      proxima_em = now() + make_interval(mins => 5 * tentativas * tentativas),
      enviada_em = CASE WHEN p_estado = 'enviada' THEN now() END
  WHERE id = p_id AND p_estado IN ('enviada', 'falhou', 'sem_contato')
$$;

-- Políticas do dono para o worker (a tabela é forçada).
CREATE POLICY notificacao_worker_dono ON app.notificacao TO cf_owner USING (true) WITH CHECK (true);

REVOKE ALL ON FUNCTION app.preencher_pessoa_do_vinculo(), app.agendamento_registrar_evento(), app.agendamento_validar_transicao(),
  app.agendamento_transicao_valida(text, text), app.limite_consultas_futuras(),
  app.agendamento_marcar(uuid, uuid, uuid), app.agendamento_desmarcar(uuid, boolean, text),
  app.agendamento_remarcar(uuid, uuid), app.ausencia_registrar(uuid, uuid, tstzrange, text),
  app.vagas_gerar(uuid, date), app.notificacao_reservar_lote(integer), app.notificacao_concluir(uuid, text)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  app.agendamento_transicao_valida(text, text), app.limite_consultas_futuras(),
  app.agendamento_marcar(uuid, uuid, uuid), app.agendamento_desmarcar(uuid, boolean, text),
  app.agendamento_remarcar(uuid, uuid), app.ausencia_registrar(uuid, uuid, tstzrange, text),
  app.vagas_gerar(uuid, date), app.notificacao_reservar_lote(integer), app.notificacao_concluir(uuid, text)
TO cf_app;

-- ---------------------------------------------------------------- cadastro do cidadão e nomes
CREATE POLICY vinculo_cadastro_dono ON app.vinculo FOR INSERT TO cf_owner
  WITH CHECK (tenant_id = app.tenant_atual());

-- Autocadastro: cria pessoa, conta e vínculo de cidadão AGUARDANDO aprovação da unidade.
-- Se o CPF já existe, não cria nada e devolve NULL: quem já tem cadastro (inclusive feito
-- pela unidade) recupera o acesso presencialmente, para ninguém tomar o cadastro de outra pessoa.
CREATE FUNCTION app.cidadao_autocadastro(p_nome text, p_cpf_cifrado bytea, p_cpf_indice bytea, p_nascimento date,
                                         p_email_cifrado bytea, p_senha_hash text)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_pessoa uuid;
  v_conta uuid;
BEGIN
  IF app.tenant_atual() IS NULL THEN
    RAISE EXCEPTION 'Contexto de município ausente' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO app.pessoa (nome, cpf_cifrado, cpf_indice, nascimento, email_cifrado)
  VALUES (p_nome, p_cpf_cifrado, p_cpf_indice, p_nascimento, p_email_cifrado)
  ON CONFLICT (cpf_indice) DO NOTHING
  RETURNING id INTO v_pessoa;
  IF v_pessoa IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO app.conta (pessoa_id, senha_hash) VALUES (v_pessoa, p_senha_hash) RETURNING id INTO v_conta;
  INSERT INTO app.vinculo (tenant_id, conta_id, papel, estado) VALUES (app.tenant_atual(), v_conta, 'cidadao', 'convidado');
  RETURN v_conta;
END
$$;

-- Nomes das pessoas com vínculo no município do contexto. A aplicação confere a permissão
-- antes de chamar; a função só garante que nunca sai do município.
CREATE FUNCTION app.nomes_de_vinculos(p_vinculos uuid[])
  RETURNS TABLE (vinculo_id uuid, nome text, papel text, estado text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  SELECT v.id, p.nome, v.papel, v.estado
  FROM app.vinculo v JOIN app.conta c ON c.id = v.conta_id JOIN app.pessoa p ON p.id = c.pessoa_id
  WHERE v.tenant_id = app.tenant_atual() AND v.id = ANY (p_vinculos)
$$;

CREATE FUNCTION app.membros_do_municipio(p_papel text)
  RETURNS TABLE (vinculo_id uuid, nome text, papel text, estado text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  SELECT v.id, p.nome, v.papel, v.estado
  FROM app.vinculo v JOIN app.conta c ON c.id = v.conta_id JOIN app.pessoa p ON p.id = c.pessoa_id
  WHERE v.tenant_id = app.tenant_atual() AND v.papel = p_papel AND v.estado IN ('convidado', 'ativo')
  ORDER BY p.nome
  LIMIT 500
$$;

-- Nome da própria conta, para a saudação na tela.
CREATE FUNCTION app.meu_nome()
  RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$ SELECT p.nome FROM app.conta c JOIN app.pessoa p ON p.id = c.pessoa_id WHERE c.id = app.conta_atual() $$;

REVOKE ALL ON FUNCTION app.cidadao_autocadastro(text, bytea, bytea, date, bytea, text), app.nomes_de_vinculos(uuid[]),
  app.membros_do_municipio(text), app.meu_nome() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.cidadao_autocadastro(text, bytea, bytea, date, bytea, text), app.nomes_de_vinculos(uuid[]),
  app.membros_do_municipio(text), app.meu_nome() TO cf_app;

RESET ROLE;
