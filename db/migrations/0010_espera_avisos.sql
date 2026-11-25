-- Consulta Fácil 2.0 — migração 0010: lista de espera, oferta exclusiva com prazo e lembrete da véspera.
--
-- Regras que o banco garante:
--   * quem está na lista de espera recebe a vaga que abriu (desmarque, remarcação, escala nova)
--     só para si, por um prazo que conta só das 7h às 20h do município;
--   * a disponibilidade é calculada na hora: oferta vencida já conta como vaga livre, mesmo que
--     nenhuma rotina tenha passado;
--   * uma vaga tem no máximo uma oferta ativa e cada pedido na lista, no máximo uma;
--   * ninguém marca vaga oferecida a outra pessoa (nem a equipe);
--   * marcar a especialidade por outro caminho tira a pessoa da lista (não segura duas vagas);
--   * prioridade (idoso, gestante, PcD) só a equipe marca;
--   * o lembrete da véspera sai uma vez por consulta, mesmo com a rotina rodando várias vezes.

SET ROLE cf_owner;

-- ---------------------------------------------------------------- lista de espera
CREATE TABLE app.espera (
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES app.tenant (id),
  cidadao_vinculo_id uuid NOT NULL,            -- titular
  dependente_id      uuid,                     -- quem será atendido, quando não é o titular
  pessoa_id          uuid NOT NULL REFERENCES app.pessoa (id),   -- preenchido por gatilho
  especialidade      text NOT NULL CHECK (length(especialidade) BETWEEN 2 AND 80),
  unidade_id         uuid,                     -- NULL: qualquer unidade do município
  turno              text NOT NULL DEFAULT 'qualquer' CHECK (turno IN ('manha', 'tarde', 'qualquer')),
  prioridade         text CHECK (prioridade IS NULL OR prioridade IN ('idoso', 'gestante', 'pcd', 'remanejamento', 'outra')),
  estado             text NOT NULL DEFAULT 'aguardando' CHECK (estado IN ('aguardando', 'atendida', 'cancelada')),
  valida_ate         date NOT NULL DEFAULT (current_date + 60),
  incluida_por       uuid,
  criado_em          timestamptz NOT NULL DEFAULT now(),
  encerrada_em       timestamptz,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, cidadao_vinculo_id) REFERENCES app.vinculo (tenant_id, id),
  FOREIGN KEY (tenant_id, dependente_id) REFERENCES app.dependente (tenant_id, id),
  FOREIGN KEY (tenant_id, unidade_id) REFERENCES app.unidade (tenant_id, id),
  CHECK (valida_ate <= criado_em::date + 120)
);
-- Um pedido vigente por pessoa e especialidade.
CREATE UNIQUE INDEX espera_vigente ON app.espera (tenant_id, pessoa_id, lower(especialidade)) WHERE estado = 'aguardando';
CREATE INDEX espera_fila ON app.espera (tenant_id, lower(especialidade), criado_em) WHERE estado = 'aguardando';

CREATE FUNCTION app.limite_espera() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 3 $$;

-- A pessoa vem do titular ou do dependente ativo dele (mesma regra da consulta).
CREATE TRIGGER espera_pessoa BEFORE INSERT ON app.espera
  FOR EACH ROW EXECUTE FUNCTION app.preencher_pessoa_do_agendamento();

CREATE FUNCTION app.espera_validar() RETURNS trigger
  LANGUAGE plpgsql SET search_path = app, pg_temp
AS $$
DECLARE
  v_equipe boolean := app.pode_no_municipio('agenda.marcar');
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- O cidadão só entra na lista por si (ou por dependente dele); para outra pessoa, só a equipe.
    IF NOT v_equipe AND NOT EXISTS (
      SELECT 1 FROM app.vinculo WHERE id = NEW.cidadao_vinculo_id AND conta_id = app.conta_atual() AND papel = 'cidadao' AND estado = 'ativo'
    ) THEN
      RAISE EXCEPTION 'sem_permissao' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM app.vinculo WHERE id = NEW.cidadao_vinculo_id AND papel = 'cidadao' AND estado = 'ativo') THEN
      RAISE EXCEPTION 'sem_vinculo_cidadao' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM app.profissional WHERE ativo AND lower(especialidade) = lower(NEW.especialidade)) THEN
      RAISE EXCEPTION 'especialidade_inexistente' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.unidade_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.unidade WHERE id = NEW.unidade_id AND ativa) THEN
      RAISE EXCEPTION 'unidade_inexistente' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.prioridade IS NOT NULL AND NOT v_equipe THEN
      RAISE EXCEPTION 'sem_permissao' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF (SELECT count(*) FROM app.espera WHERE pessoa_id = NEW.pessoa_id AND estado = 'aguardando' AND valida_ate >= current_date)
       >= app.limite_espera() THEN
      RAISE EXCEPTION 'limite_espera' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM app.espera WHERE pessoa_id = NEW.pessoa_id AND estado = 'aguardando'
               AND lower(especialidade) = lower(NEW.especialidade)) THEN
      RAISE EXCEPTION 'ja_na_espera' USING ERRCODE = 'unique_violation';
    END IF;
    NEW.estado := 'aguardando';
    NEW.criado_em := now();
    NEW.encerrada_em := NULL;
    NEW.incluida_por := app.conta_atual();
    RETURN NEW;
  END IF;

  -- UPDATE: só sai de "aguardando", e prioridade é da equipe.
  IF NEW.prioridade IS DISTINCT FROM OLD.prioridade THEN
    IF NOT v_equipe THEN
      RAISE EXCEPTION 'sem_permissao' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.estado <> 'aguardando' THEN
      RAISE EXCEPTION 'espera_encerrada' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.estado <> OLD.estado THEN
    IF OLD.estado <> 'aguardando' THEN
      RAISE EXCEPTION 'espera_encerrada' USING ERRCODE = 'check_violation';
    END IF;
    -- Tirar da lista: o próprio titular ou a equipe ("atendida" vem da marcação, de quem marcou).
    IF NEW.estado = 'cancelada' AND NOT v_equipe AND NOT EXISTS (
      SELECT 1 FROM app.vinculo WHERE id = OLD.cidadao_vinculo_id AND conta_id = app.conta_atual()
    ) THEN
      RAISE EXCEPTION 'sem_permissao' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.encerrada_em := now();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER espera_regras BEFORE INSERT OR UPDATE ON app.espera
  FOR EACH ROW EXECUTE FUNCTION app.espera_validar();
CREATE TRIGGER espera_sem_exclusao BEFORE DELETE ON app.espera
  FOR EACH ROW EXECUTE FUNCTION app.bloquear_alteracao();

-- ---------------------------------------------------------------- ofertas
CREATE TABLE app.oferta (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES app.tenant (id),
  vaga_id        uuid NOT NULL,
  espera_id      uuid NOT NULL,
  expira_em      timestamptz NOT NULL,
  estado         text NOT NULL DEFAULT 'ativa' CHECK (estado IN ('ativa', 'aceita', 'recusada', 'vencida', 'cancelada')),
  agendamento_id uuid,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  respondida_em  timestamptz,
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, vaga_id) REFERENCES app.vaga (tenant_id, id),
  FOREIGN KEY (tenant_id, espera_id) REFERENCES app.espera (tenant_id, id),
  FOREIGN KEY (tenant_id, agendamento_id) REFERENCES app.agendamento (tenant_id, id),
  CHECK (estado <> 'aceita' OR agendamento_id IS NOT NULL)
);
CREATE UNIQUE INDEX oferta_ativa_vaga ON app.oferta (vaga_id) WHERE estado = 'ativa';
CREATE UNIQUE INDEX oferta_ativa_espera ON app.oferta (espera_id) WHERE estado = 'ativa';
-- A mesma vaga não é oferecida duas vezes ao mesmo pedido (quem recusou não recebe de novo).
CREATE UNIQUE INDEX oferta_uma_vez ON app.oferta (espera_id, vaga_id);
CREATE INDEX oferta_vencimento ON app.oferta (tenant_id, expira_em) WHERE estado = 'ativa';

-- Prazo da oferta: 2 horas contadas só entre 7h e 20h no fuso do município, e nunca depois
-- de 2 horas antes da consulta. NULL quando não dá tempo de oferecer (a vaga fica livre).
CREATE FUNCTION app.prazo_oferta(p_inicio timestamptz, p_fuso text, p_consulta timestamptz)
  RETURNS timestamptz
  LANGUAGE plpgsql STABLE SET search_path = app, pg_temp
AS $$
DECLARE
  v_local timestamp := p_inicio AT TIME ZONE p_fuso;
  v_restante interval := interval '2 hours';
  v_fim_dia timestamp;
  v_prazo timestamptz;
BEGIN
  LOOP
    IF v_local::time < time '07:00' THEN
      v_local := v_local::date + time '07:00';
    ELSIF v_local::time >= time '20:00' THEN
      v_local := (v_local::date + 1) + time '07:00';
    END IF;
    v_fim_dia := v_local::date + time '20:00';
    IF v_local + v_restante <= v_fim_dia THEN
      v_local := v_local + v_restante;
      EXIT;
    END IF;
    v_restante := v_restante - (v_fim_dia - v_local);
    v_local := (v_local::date + 1) + time '07:00';
  END LOOP;
  v_prazo := least(v_local AT TIME ZONE p_fuso, p_consulta - interval '2 hours');
  IF v_prazo < p_inicio + interval '30 minutes' THEN
    RETURN NULL;
  END IF;
  RETURN v_prazo;
END
$$;

-- Compatibilidade entre a vaga e o pedido: especialidade, unidade e turno (horário local).
CREATE FUNCTION app.espera_combina(p_vaga uuid, p_espera uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = app, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM app.vaga v
    JOIN app.profissional p ON p.id = v.profissional_id AND p.ativo
    JOIN app.unidade u ON u.id = v.unidade_id AND u.ativa
    JOIN app.tenant t ON t.id = v.tenant_id
    JOIN app.espera e ON e.id = p_espera
    WHERE v.id = p_vaga
      AND lower(p.especialidade) = lower(e.especialidade)
      AND (e.unidade_id IS NULL OR e.unidade_id = v.unidade_id)
      AND (e.turno = 'qualquer'
           OR (e.turno = 'manha' AND (lower(v.periodo) AT TIME ZONE t.fuso)::time < time '12:00')
           OR (e.turno = 'tarde' AND (lower(v.periodo) AT TIME ZONE t.fuso)::time >= time '12:00'))
  )
$$;

-- Toda oferta nova passa por aqui, inclusive se a aplicação tentar gravar direto:
-- vaga livre e futura, pedido vigente e compatível, prazo calculado pelo banco.
CREATE FUNCTION app.oferta_validar_insercao() RETURNS trigger
  LANGUAGE plpgsql SET search_path = app, pg_temp
AS $$
DECLARE
  v_inicio timestamptz;
  v_fuso text;
BEGIN
  SELECT lower(v.periodo), t.fuso INTO v_inicio, v_fuso
  FROM app.vaga v JOIN app.tenant t ON t.id = v.tenant_id
  WHERE v.id = NEW.vaga_id AND v.estado = 'livre';
  IF v_inicio IS NULL THEN
    RAISE EXCEPTION 'vaga_indisponivel' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.espera WHERE id = NEW.espera_id AND estado = 'aguardando' AND valida_ate >= current_date)
     OR NOT app.espera_combina(NEW.vaga_id, NEW.espera_id) THEN
    RAISE EXCEPTION 'espera_incompativel' USING ERRCODE = 'check_violation';
  END IF;
  NEW.expira_em := app.prazo_oferta(now(), v_fuso, v_inicio);
  IF NEW.expira_em IS NULL THEN
    RAISE EXCEPTION 'sem_tempo_para_oferta' USING ERRCODE = 'check_violation';
  END IF;
  NEW.estado := 'ativa';
  NEW.criado_em := now();
  NEW.agendamento_id := NULL;
  NEW.respondida_em := NULL;
  RETURN NEW;
END
$$;
CREATE TRIGGER oferta_insercao BEFORE INSERT ON app.oferta
  FOR EACH ROW EXECUTE FUNCTION app.oferta_validar_insercao();

-- Uma oferta só sai de "ativa". "vencida" só depois do prazo; "aceita" só com a consulta
-- daquela vaga para a pessoa do pedido.
CREATE FUNCTION app.oferta_validar_transicao() RETURNS trigger
  LANGUAGE plpgsql SET search_path = app, pg_temp
AS $$
BEGIN
  IF NEW.vaga_id <> OLD.vaga_id OR NEW.espera_id <> OLD.espera_id OR NEW.expira_em <> OLD.expira_em THEN
    RAISE EXCEPTION 'oferta_imutavel' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.estado = OLD.estado THEN
    RETURN NEW;
  END IF;
  IF OLD.estado <> 'ativa' THEN
    RAISE EXCEPTION 'oferta_encerrada' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.estado = 'recusada' AND NOT app.pode_no_municipio('agenda.marcar') AND NOT EXISTS (
    SELECT 1 FROM app.espera e JOIN app.vinculo v ON v.id = e.cidadao_vinculo_id
    WHERE e.id = OLD.espera_id AND v.conta_id = app.conta_atual()
  ) THEN
    RAISE EXCEPTION 'sem_permissao' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.estado = 'vencida' AND OLD.expira_em > now() THEN
    RAISE EXCEPTION 'oferta_no_prazo' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.estado = 'aceita' AND NOT EXISTS (
    SELECT 1 FROM app.agendamento a JOIN app.espera e ON e.id = NEW.espera_id
    WHERE a.id = NEW.agendamento_id AND a.vaga_id = NEW.vaga_id AND a.pessoa_id = e.pessoa_id
  ) THEN
    RAISE EXCEPTION 'oferta_invalida' USING ERRCODE = 'check_violation';
  END IF;
  NEW.respondida_em := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER oferta_transicao BEFORE UPDATE ON app.oferta
  FOR EACH ROW EXECUTE FUNCTION app.oferta_validar_transicao();
CREATE TRIGGER oferta_sem_exclusao BEFORE DELETE ON app.oferta
  FOR EACH ROW EXECUTE FUNCTION app.bloquear_alteracao();

-- ---------------------------------------------------------------- RLS municipal (forçado)
ALTER TABLE app.espera ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.espera FORCE ROW LEVEL SECURITY;
CREATE POLICY espera_municipio ON app.espera TO cf_app
  USING (tenant_id = app.tenant_atual()) WITH CHECK (tenant_id = app.tenant_atual());
ALTER TABLE app.oferta ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.oferta FORCE ROW LEVEL SECURITY;
CREATE POLICY oferta_municipio ON app.oferta TO cf_app
  USING (tenant_id = app.tenant_atual()) WITH CHECK (tenant_id = app.tenant_atual());
-- Funções do dono (destinatário do aviso, nomes) leem no município do contexto.
CREATE POLICY espera_dono ON app.espera FOR SELECT TO cf_owner USING (tenant_id = app.tenant_atual());
CREATE POLICY oferta_dono ON app.oferta FOR SELECT TO cf_owner USING (tenant_id = app.tenant_atual());

-- ---------------------------------------------------------------- distribuir vagas
-- Cria a oferta (o gatilho valida) e o aviso. Vencidas da vaga são encerradas antes.
CREATE FUNCTION app.oferta_criar(p_vaga uuid, p_espera uuid) RETURNS uuid
  LANGUAGE plpgsql SET search_path = app, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_pessoa uuid;
BEGIN
  UPDATE app.oferta SET estado = 'vencida' WHERE vaga_id = p_vaga AND estado = 'ativa' AND expira_em <= now();
  UPDATE app.oferta SET estado = 'vencida' WHERE espera_id = p_espera AND estado = 'ativa' AND expira_em <= now();
  INSERT INTO app.oferta (tenant_id, vaga_id, espera_id, expira_em)
  VALUES (app.tenant_atual(), p_vaga, p_espera, now())
  RETURNING id INTO v_id;
  SELECT pessoa_id INTO v_pessoa FROM app.espera WHERE id = p_espera;
  INSERT INTO app.notificacao (tenant_id, pessoa_id, modelo, dados)
  VALUES (app.tenant_atual(), v_pessoa, 'vaga_oferecida', jsonb_build_object('oferta_id', v_id));
  RETURN v_id;
END
$$;

-- A vaga ficou livre: oferece ao primeiro da fila compatível (prioridade, depois ordem de entrada).
-- Devolve a oferta criada, ou NULL quando ninguém combina, a vaga já tem oferta no prazo ou não
-- há tempo hábil (a vaga continua livre para quem procurar).
CREATE FUNCTION app.oferecer_vaga(p_vaga uuid) RETURNS uuid
  LANGUAGE plpgsql SET search_path = app, pg_temp
AS $$
DECLARE
  v_vaga app.vaga%ROWTYPE;
  v_fuso text;
  v_espera uuid;
BEGIN
  IF app.tenant_atual() IS NULL THEN
    RAISE EXCEPTION 'Contexto de município ausente' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_vaga FROM app.vaga WHERE id = p_vaga FOR UPDATE;
  IF NOT FOUND OR v_vaga.estado <> 'livre' THEN
    RETURN NULL;
  END IF;
  SELECT fuso INTO v_fuso FROM app.tenant WHERE id = v_vaga.tenant_id;
  IF app.prazo_oferta(now(), v_fuso, lower(v_vaga.periodo)) IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE app.oferta SET estado = 'vencida' WHERE vaga_id = p_vaga AND estado = 'ativa' AND expira_em <= now();
  IF EXISTS (SELECT 1 FROM app.oferta WHERE vaga_id = p_vaga AND estado = 'ativa') THEN
    RETURN NULL;
  END IF;

  SELECT e.id INTO v_espera
  FROM app.espera e
  WHERE e.estado = 'aguardando' AND e.valida_ate >= current_date
    AND app.espera_combina(p_vaga, e.id)
    AND NOT EXISTS (SELECT 1 FROM app.oferta o WHERE o.espera_id = e.id AND (o.vaga_id = p_vaga OR (o.estado = 'ativa' AND o.expira_em > now())))
    -- Não oferece horário em que a pessoa já tem outro atendimento.
    AND NOT EXISTS (SELECT 1 FROM app.agendamento a JOIN app.vaga x ON x.id = a.vaga_id
                    WHERE a.pessoa_id = e.pessoa_id AND a.estado IN ('marcada', 'confirmada', 'aguardando_remanejamento')
                      AND x.periodo && v_vaga.periodo)
  ORDER BY (e.prioridade IS NOT NULL) DESC, e.criado_em, e.id
  LIMIT 1
  FOR UPDATE OF e SKIP LOCKED;
  IF v_espera IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN app.oferta_criar(p_vaga, v_espera);
END
$$;

-- Rotina: para cada pedido sem oferta no prazo (prioridade primeiro), procura a vaga livre
-- compatível mais próxima, sem oferta e que nunca foi oferecida a ele. Cobre escala nova,
-- oferta vencida ou recusada e vaga que abriu sem ninguém na fila na hora.
CREATE FUNCTION app.espera_distribuir(p_limite integer DEFAULT 50) RETURNS integer
  LANGUAGE plpgsql SET search_path = app, pg_temp
AS $$
DECLARE
  e record;
  v_vaga uuid;
  v_fuso text;
  v_criadas integer := 0;
BEGIN
  IF app.tenant_atual() IS NULL THEN
    RAISE EXCEPTION 'Contexto de município ausente' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT fuso INTO v_fuso FROM app.tenant WHERE id = app.tenant_atual();
  UPDATE app.oferta SET estado = 'vencida' WHERE estado = 'ativa' AND expira_em <= now();

  FOR e IN
    SELECT x.id, x.pessoa_id FROM app.espera x
    WHERE x.estado = 'aguardando' AND x.valida_ate >= current_date
      AND NOT EXISTS (SELECT 1 FROM app.oferta o WHERE o.espera_id = x.id AND o.estado = 'ativa')
    ORDER BY (x.prioridade IS NOT NULL) DESC, x.criado_em, x.id
    LIMIT least(p_limite, 200)
  LOOP
    SELECT v.id INTO v_vaga
    FROM app.vaga v
    WHERE v.estado = 'livre' AND lower(v.periodo) > now() AND lower(v.periodo) < now() + interval '60 days'
      AND app.prazo_oferta(now(), v_fuso, lower(v.periodo)) IS NOT NULL
      AND app.espera_combina(v.id, e.id)
      AND NOT EXISTS (SELECT 1 FROM app.oferta o WHERE o.vaga_id = v.id AND (o.estado = 'ativa' OR o.espera_id = e.id))
      AND NOT EXISTS (SELECT 1 FROM app.agendamento a JOIN app.vaga y ON y.id = a.vaga_id
                      WHERE a.pessoa_id = e.pessoa_id AND a.estado IN ('marcada', 'confirmada', 'aguardando_remanejamento')
                        AND y.periodo && v.periodo)
    ORDER BY lower(v.periodo)
    LIMIT 1
    FOR UPDATE OF v SKIP LOCKED;
    IF v_vaga IS NOT NULL THEN
      PERFORM app.oferta_criar(v_vaga, e.id);
      v_criadas := v_criadas + 1;
    END IF;
  END LOOP;
  RETURN v_criadas;
END
$$;

-- ---------------------------------------------------------------- consulta x oferta x espera
-- Depois de gravar uma consulta: a vaga oferecida a outra pessoa é recusada; a oferta da própria
-- pessoa vira "aceita"; e o pedido da mesma especialidade sai da lista (liberando outra oferta dele).
CREATE FUNCTION app.agendamento_oferta_e_espera() RETURNS trigger
  LANGUAGE plpgsql SET search_path = app, pg_temp
AS $$
DECLARE
  o record;
  v_oferta uuid;
  v_dono uuid;
  v_especialidade text;
BEGIN
  UPDATE app.oferta SET estado = 'vencida' WHERE vaga_id = NEW.vaga_id AND estado = 'ativa' AND expira_em <= now();
  SELECT x.id, e.pessoa_id INTO v_oferta, v_dono
  FROM app.oferta x JOIN app.espera e ON e.id = x.espera_id
  WHERE x.vaga_id = NEW.vaga_id AND x.estado = 'ativa';
  IF v_oferta IS NOT NULL THEN
    IF v_dono <> NEW.pessoa_id THEN
      RAISE EXCEPTION 'vaga_indisponivel' USING ERRCODE = 'unique_violation';
    END IF;
    UPDATE app.oferta SET estado = 'aceita', agendamento_id = NEW.id WHERE id = v_oferta;
  END IF;

  SELECT p.especialidade INTO v_especialidade
  FROM app.vaga v JOIN app.profissional p ON p.id = v.profissional_id WHERE v.id = NEW.vaga_id;
  FOR o IN
    SELECT e.id, (SELECT x.vaga_id FROM app.oferta x WHERE x.espera_id = e.id AND x.estado = 'ativa') AS outra_vaga
    FROM app.espera e
    WHERE e.pessoa_id = NEW.pessoa_id AND e.estado = 'aguardando' AND lower(e.especialidade) = lower(v_especialidade)
    FOR UPDATE OF e
  LOOP
    UPDATE app.espera SET estado = 'atendida' WHERE id = o.id;
    IF o.outra_vaga IS NOT NULL THEN
      UPDATE app.oferta SET estado = 'cancelada' WHERE espera_id = o.id AND estado = 'ativa';
      PERFORM app.oferecer_vaga(o.outra_vaga);
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;
CREATE TRIGGER agendamento_oferta AFTER INSERT ON app.agendamento
  FOR EACH ROW EXECUTE FUNCTION app.agendamento_oferta_e_espera();

-- Recusar a oferta ou sair da lista devolvem a vaga para o próximo.
CREATE FUNCTION app.oferta_recusar(p_oferta uuid) RETURNS void
  LANGUAGE plpgsql SET search_path = app, pg_temp
AS $$
DECLARE
  v_vaga uuid;
BEGIN
  UPDATE app.oferta SET estado = 'recusada' WHERE id = p_oferta AND estado = 'ativa' AND expira_em > now()
  RETURNING vaga_id INTO v_vaga;
  IF v_vaga IS NULL THEN
    RAISE EXCEPTION 'oferta_encerrada' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM app.oferecer_vaga(v_vaga);
END
$$;

CREATE FUNCTION app.espera_sair(p_espera uuid) RETURNS void
  LANGUAGE plpgsql SET search_path = app, pg_temp
AS $$
DECLARE
  v_vaga uuid;
BEGIN
  UPDATE app.espera SET estado = 'cancelada' WHERE id = p_espera AND estado = 'aguardando';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'espera_encerrada' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE app.oferta SET estado = 'cancelada' WHERE espera_id = p_espera AND estado = 'ativa'
  RETURNING vaga_id INTO v_vaga;
  IF v_vaga IS NOT NULL THEN
    PERFORM app.oferecer_vaga(v_vaga);
  END IF;
END
$$;

-- Desmarcar e remarcar: a vaga que abriu vai primeiro para a lista de espera.
CREATE OR REPLACE FUNCTION app.agendamento_desmarcar(p_agendamento_id uuid, p_por_cidadao boolean, p_motivo text)
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
  PERFORM app.oferecer_vaga(v_ag.vaga_id);
END
$$;

CREATE OR REPLACE FUNCTION app.agendamento_remarcar(p_agendamento_id uuid, p_nova_vaga_id uuid)
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

  v_novo := app.agendamento_marcar(p_nova_vaga_id, v_ag.cidadao_vinculo_id, p_agendamento_id, v_ag.dependente_id);
  UPDATE app.notificacao SET modelo = 'consulta_remarcada'
  WHERE tenant_id = app.tenant_atual() AND modelo = 'consulta_marcada' AND dados ->> 'agendamento_id' = v_novo::text;
  PERFORM app.oferecer_vaga(v_ag.vaga_id);
  RETURN v_novo;
END
$$;

-- ---------------------------------------------------------------- avisos
ALTER TABLE app.notificacao DROP CONSTRAINT notificacao_modelo_check;
ALTER TABLE app.notificacao ADD CONSTRAINT notificacao_modelo_check CHECK (modelo IN (
  'consulta_marcada', 'consulta_desmarcada', 'profissional_ausente', 'consulta_remarcada', 'recuperar_senha',
  'vaga_oferecida', 'lembrete_vespera'));
-- "descartada": o aviso perdeu o sentido antes de sair (consulta desmarcada, oferta encerrada).
ALTER TABLE app.notificacao DROP CONSTRAINT notificacao_estado_check;
ALTER TABLE app.notificacao ADD CONSTRAINT notificacao_estado_check CHECK (estado IN (
  'pendente', 'enviada', 'falhou', 'sem_contato', 'descartada'));
-- Um lembrete por consulta, por mais que a rotina rode.
CREATE UNIQUE INDEX notificacao_lembrete_unico ON app.notificacao ((dados ->> 'agendamento_id')) WHERE modelo = 'lembrete_vespera';
CREATE INDEX notificacao_por_consulta ON app.notificacao (tenant_id, (dados ->> 'agendamento_id'));

-- O aviso da oferta também vai para o titular quando o pedido é de dependente.
CREATE OR REPLACE FUNCTION app.notificacao_destinatario() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_pessoa uuid;
BEGIN
  IF NEW.dados ? 'agendamento_id' THEN
    SELECT c.pessoa_id INTO v_pessoa
    FROM app.agendamento a
    JOIN app.vinculo v ON v.tenant_id = a.tenant_id AND v.id = a.cidadao_vinculo_id
    JOIN app.conta c ON c.id = v.conta_id
    WHERE a.tenant_id = NEW.tenant_id AND a.id = (NEW.dados ->> 'agendamento_id')::uuid;
  ELSIF NEW.dados ? 'oferta_id' THEN
    SELECT c.pessoa_id INTO v_pessoa
    FROM app.oferta o
    JOIN app.espera e ON e.tenant_id = o.tenant_id AND e.id = o.espera_id
    JOIN app.vinculo v ON v.tenant_id = e.tenant_id AND v.id = e.cidadao_vinculo_id
    JOIN app.conta c ON c.id = v.conta_id
    WHERE o.tenant_id = NEW.tenant_id AND o.id = (NEW.dados ->> 'oferta_id')::uuid;
  END IF;
  IF v_pessoa IS NOT NULL THEN
    NEW.pessoa_id := v_pessoa;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION app.notificacao_concluir(p_id uuid, p_estado text)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  UPDATE app.notificacao
  SET estado = CASE
        WHEN p_estado = 'falhou' AND tentativas < 5 THEN 'pendente'
        ELSE p_estado END,
      proxima_em = now() + make_interval(mins => 5 * tentativas * tentativas),
      enviada_em = CASE WHEN p_estado = 'enviada' THEN now() END,
      dados = CASE WHEN p_estado = 'falhou' AND tentativas < 5 THEN dados ELSE dados - 'token_cifrado' END
  WHERE id = p_id AND p_estado IN ('enviada', 'falhou', 'sem_contato', 'descartada')
$$;

-- Lembrete da véspera: consultas de amanhã (horário local), entre 9h e 20h, uma vez cada.
-- p_agora existe para os testes fixarem o relógio; a rotina usa o padrão.
CREATE FUNCTION app.lembretes_gerar(p_agora timestamptz DEFAULT now()) RETURNS integer
  LANGUAGE plpgsql SET search_path = app, pg_temp
AS $$
DECLARE
  v_fuso text;
  v_agora timestamp;
  v_n integer;
BEGIN
  IF app.tenant_atual() IS NULL THEN
    RAISE EXCEPTION 'Contexto de município ausente' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT fuso INTO v_fuso FROM app.tenant WHERE id = app.tenant_atual();
  v_agora := p_agora AT TIME ZONE v_fuso;
  IF v_agora::time < time '09:00' OR v_agora::time >= time '20:00' THEN
    RETURN 0;
  END IF;
  INSERT INTO app.notificacao (tenant_id, pessoa_id, modelo, dados)
  SELECT a.tenant_id, a.pessoa_id, 'lembrete_vespera', jsonb_build_object('agendamento_id', a.id)
  FROM app.agendamento a JOIN app.vaga v ON v.id = a.vaga_id
  WHERE a.estado IN ('marcada', 'confirmada') AND lower(v.periodo) > now()
    AND (lower(v.periodo) AT TIME ZONE v_fuso)::date = v_agora::date + 1
  ON CONFLICT ((dados ->> 'agendamento_id')) WHERE modelo = 'lembrete_vespera' DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;

-- Municípios em que as rotinas rodam (só ids; o resto é lido no contexto de cada um).
CREATE FUNCTION app.municipios_para_rotina()
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$ SELECT id FROM app.tenant WHERE estado = 'ativo' ORDER BY id $$;

-- ---------------------------------------------------------------- nomes para a equipe
-- Nome de quem está na lista (titular ou dependente): para o titular e para a equipe com agenda.ver.
CREATE FUNCTION app.nomes_da_espera(p_esperas uuid[])
  RETURNS TABLE (espera_id uuid, nome text, dependente boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  WITH equipe AS (SELECT app.pode_no_municipio('agenda.ver') AS ok)
  SELECT e.id, p.nome, e.dependente_id IS NOT NULL
  FROM app.espera e
  JOIN app.pessoa p ON p.id = e.pessoa_id
  JOIN app.vinculo v ON v.tenant_id = e.tenant_id AND v.id = e.cidadao_vinculo_id
  CROSS JOIN equipe
  WHERE e.tenant_id = app.tenant_atual() AND e.id = ANY (p_esperas)
    AND (equipe.ok OR v.conta_id = app.conta_atual())
  LIMIT 500
$$;

-- Situação dos avisos de cada consulta (para a lista de ligações da recepção), sem endereço.
CREATE FUNCTION app.avisos_das_consultas(p_agendamentos uuid[])
  RETURNS TABLE (agendamento_id uuid, sem_contato boolean, falhou boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  SELECT (n.dados ->> 'agendamento_id')::uuid,
         bool_or(n.estado = 'sem_contato'), bool_or(n.estado = 'falhou')
  FROM app.notificacao n
  WHERE n.tenant_id = app.tenant_atual() AND app.pode_no_municipio('agenda.ver')
    AND n.dados ->> 'agendamento_id' = ANY (SELECT x::text FROM unnest(p_agendamentos) AS x)
  GROUP BY 1
$$;

RESET ROLE;

-- ---------------------------------------------------------------- privilégios
GRANT SELECT, INSERT ON app.espera, app.oferta TO cf_app;
GRANT UPDATE (estado, prioridade) ON app.espera TO cf_app;
GRANT UPDATE (estado, agendamento_id) ON app.oferta TO cf_app;

REVOKE ALL ON FUNCTION
  app.limite_espera(), app.espera_validar(), app.prazo_oferta(timestamptz, text, timestamptz),
  app.espera_combina(uuid, uuid), app.oferta_validar_insercao(), app.oferta_validar_transicao(),
  app.oferta_criar(uuid, uuid), app.oferecer_vaga(uuid), app.espera_distribuir(integer),
  app.agendamento_oferta_e_espera(), app.oferta_recusar(uuid), app.espera_sair(uuid),
  app.lembretes_gerar(timestamptz), app.municipios_para_rotina(), app.nomes_da_espera(uuid[]), app.avisos_das_consultas(uuid[])
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  app.limite_espera(), app.prazo_oferta(timestamptz, text, timestamptz), app.espera_combina(uuid, uuid),
  app.oferta_criar(uuid, uuid), app.oferecer_vaga(uuid), app.espera_distribuir(integer),
  app.oferta_recusar(uuid), app.espera_sair(uuid),
  app.lembretes_gerar(timestamptz), app.municipios_para_rotina(), app.nomes_da_espera(uuid[]), app.avisos_das_consultas(uuid[])
TO cf_app;
