-- Consulta Fácil 2.0 — migração 0009: recuperação de acesso, dependentes e cadastro assistido.
--
-- Regras que o banco garante, mesmo que a aplicação erre:
--   * senha só muda com um link válido (uso único, prazo curto, do mesmo município);
--     ao mudar, todas as sessões da conta caem;
--   * a recepção não entrega link de acesso para conta de equipe, gestor ou super admin
--     (a conta é única na plataforma: um cidadão aqui pode ser gestor em outro município);
--   * dependente pedido pelo cidadão nasce pendente e só a equipe aprova; consulta de dependente
--     só para dependente ativo do próprio titular;
--   * aviso de consulta vai sempre para o titular (quem tem contato), mesmo quando a consulta
--     é de um dependente;
--   * aceite dos termos fica registrado e não muda.

SET ROLE cf_owner;

-- ---------------------------------------------------------------- políticas do dono (RLS forçado)
CREATE POLICY token_acao_dono ON app.token_acao TO cf_owner
  USING (tenant_id = app.tenant_atual()) WITH CHECK (tenant_id = app.tenant_atual());
CREATE POLICY vinculo_atualizar_dono ON app.vinculo FOR UPDATE TO cf_owner
  USING (tenant_id = app.tenant_atual()) WITH CHECK (tenant_id = app.tenant_atual());
-- Só para saber se uma conta tem papel de equipe em algum município (trava do acesso assistido).
CREATE POLICY vinculo_papel_equipe_dono ON app.vinculo FOR SELECT TO cf_owner
  USING (papel <> 'cidadao');

-- ---------------------------------------------------------------- permissão em qualquer escopo
-- Para ações sobre o cadastro do cidadão (que é do município, não de uma unidade): vale a
-- permissão municipal ou a de qualquer unidade do município.
CREATE FUNCTION app.pode_no_municipio(p_codigo text) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = app, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM app.minhas_permissoes(NULL) AS m(codigo) WHERE m.codigo = p_codigo)
      OR EXISTS (SELECT 1 FROM app.unidade u
                 WHERE u.tenant_id = app.tenant_atual()
                   AND EXISTS (SELECT 1 FROM app.minhas_permissoes(u.id) AS m(codigo) WHERE m.codigo = p_codigo))
$$;

-- ---------------------------------------------------------------- termos de uso
CREATE FUNCTION app.termos_versao() RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT '2026-11' $$;

CREATE TABLE app.aceite_termos (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES app.tenant (id),
  vinculo_id     uuid NOT NULL,
  versao         text NOT NULL CHECK (versao ~ '^[0-9]{4}-[0-9]{2}$'),
  canal          text NOT NULL CHECK (canal IN ('autocadastro', 'assistido')),
  registrado_por uuid REFERENCES app.conta (id),   -- quem registrou: o próprio cidadão ou o atendente
  criado_em      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, vinculo_id) REFERENCES app.vinculo (tenant_id, id)
);
CREATE TRIGGER aceite_termos_somente_insercao BEFORE UPDATE OR DELETE ON app.aceite_termos
  FOR EACH ROW EXECUTE FUNCTION app.bloquear_alteracao();
CREATE TRIGGER aceite_termos_sem_truncate BEFORE TRUNCATE ON app.aceite_termos
  FOR EACH STATEMENT EXECUTE FUNCTION app.bloquear_alteracao();

-- ---------------------------------------------------------------- dependentes
-- Pessoa sem conta própria (criança, idoso sob cuidado) gerida por um titular do município.
CREATE TABLE app.dependente (
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES app.tenant (id),
  titular_vinculo_id uuid NOT NULL,
  pessoa_id          uuid NOT NULL REFERENCES app.pessoa (id),
  nome_curto         text NOT NULL CHECK (length(nome_curto) BETWEEN 2 AND 40),  -- como o titular chama (aparece nos avisos)
  parentesco         text NOT NULL CHECK (parentesco IN ('filho', 'enteado', 'neto', 'tutelado', 'curatelado', 'outro')),
  estado             text NOT NULL DEFAULT 'pendente' CHECK (estado IN ('pendente', 'ativo', 'recusado', 'encerrado')),
  pedido_por         uuid REFERENCES app.conta (id),
  decidido_por       uuid REFERENCES app.conta (id),
  decidido_em        timestamptz,
  criado_em          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, titular_vinculo_id) REFERENCES app.vinculo (tenant_id, id)
);
CREATE UNIQUE INDEX dependente_vigente ON app.dependente (tenant_id, titular_vinculo_id, pessoa_id)
  WHERE estado IN ('pendente', 'ativo');

CREATE FUNCTION app.limite_dependentes() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 10 $$;

-- Transições permitidas. Aprovar e recusar só a equipe com cidadao.aprovar; encerrar, o titular ou a equipe.
CREATE FUNCTION app.dependente_validar_transicao() RETURNS trigger
  LANGUAGE plpgsql SET search_path = app, pg_temp
AS $$
BEGIN
  IF NEW.estado = OLD.estado THEN
    RETURN NEW;
  END IF;
  IF (OLD.estado, NEW.estado) NOT IN (('pendente', 'ativo'), ('pendente', 'recusado'), ('pendente', 'encerrado'), ('ativo', 'encerrado')) THEN
    RAISE EXCEPTION 'transicao_invalida' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.estado IN ('ativo', 'recusado') AND NOT app.pode_no_municipio('cidadao.aprovar') THEN
    RAISE EXCEPTION 'sem_permissao' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.decidido_por := app.conta_atual();
  NEW.decidido_em := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER dependente_transicao BEFORE UPDATE ON app.dependente
  FOR EACH ROW EXECUTE FUNCTION app.dependente_validar_transicao();
CREATE TRIGGER dependente_sem_exclusao BEFORE DELETE ON app.dependente
  FOR EACH ROW EXECUTE FUNCTION app.bloquear_alteracao();

-- ---------------------------------------------------------------- RLS municipal (forçado)
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['aceite_termos', 'dependente']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON app.%I TO cf_app USING (tenant_id = app.tenant_atual()) WITH CHECK (tenant_id = app.tenant_atual())',
      t || '_municipio', t);
    EXECUTE format(
      'CREATE POLICY %I ON app.%I TO cf_owner USING (tenant_id = app.tenant_atual()) WITH CHECK (tenant_id = app.tenant_atual())',
      t || '_dono', t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------- consulta de dependente
ALTER TABLE app.agendamento ADD COLUMN dependente_id uuid;
ALTER TABLE app.agendamento ADD CONSTRAINT agendamento_dependente_fk
  FOREIGN KEY (tenant_id, dependente_id) REFERENCES app.dependente (tenant_id, id);

-- Pessoa da consulta: o titular, ou o dependente ativo DESSE titular. A aplicação nunca escolhe.
CREATE FUNCTION app.preencher_pessoa_do_agendamento() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
BEGIN
  NEW.pessoa_id := NULL;
  IF NEW.dependente_id IS NULL THEN
    SELECT c.pessoa_id INTO NEW.pessoa_id
    FROM app.vinculo v JOIN app.conta c ON c.id = v.conta_id
    WHERE v.id = NEW.cidadao_vinculo_id AND v.tenant_id = NEW.tenant_id AND v.estado = 'ativo';
  ELSE
    SELECT d.pessoa_id INTO NEW.pessoa_id
    FROM app.dependente d
    JOIN app.vinculo v ON v.tenant_id = d.tenant_id AND v.id = d.titular_vinculo_id
    WHERE d.id = NEW.dependente_id AND d.tenant_id = NEW.tenant_id
      AND d.titular_vinculo_id = NEW.cidadao_vinculo_id AND d.estado = 'ativo' AND v.estado = 'ativo';
    IF NEW.pessoa_id IS NULL THEN
      RAISE EXCEPTION 'dependente_invalido' USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;
  IF NEW.pessoa_id IS NULL THEN
    RAISE EXCEPTION 'Vínculo inexistente ou inativo neste município' USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER agendamento_pessoa ON app.agendamento;
CREATE TRIGGER agendamento_pessoa BEFORE INSERT ON app.agendamento
  FOR EACH ROW EXECUTE FUNCTION app.preencher_pessoa_do_agendamento();

-- Limite por titular, somando ele e os dependentes (o limite por paciente continua 3).
CREATE FUNCTION app.limite_consultas_titular() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 10 $$;

DROP FUNCTION app.agendamento_marcar(uuid, uuid, uuid);
CREATE FUNCTION app.agendamento_marcar(p_vaga_id uuid, p_cidadao_vinculo_id uuid, p_remarcada_de uuid DEFAULT NULL,
                                       p_dependente_id uuid DEFAULT NULL)
  RETURNS uuid
  LANGUAGE plpgsql
  SET search_path = app, pg_temp
AS $$
DECLARE
  v_vaga app.vaga%ROWTYPE;
  v_id uuid;
  v_pessoa uuid;
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

  -- O gatilho resolve a pessoa (titular ou dependente ativo dele) e recusa o resto.
  INSERT INTO app.agendamento (tenant_id, vaga_id, cidadao_vinculo_id, dependente_id, pessoa_id, marcada_por, remarcada_de)
  VALUES (app.tenant_atual(), p_vaga_id, p_cidadao_vinculo_id, p_dependente_id, '00000000-0000-0000-0000-000000000000',
          app.conta_atual(), p_remarcada_de)
  RETURNING id, pessoa_id INTO v_id, v_pessoa;

  -- Limites: por paciente e por titular (consultas futuras ativas, sem contar a que está sendo remarcada).
  IF (SELECT count(*) FROM app.agendamento a JOIN app.vaga v ON v.id = a.vaga_id
      WHERE a.pessoa_id = v_pessoa AND a.id <> v_id AND a.id IS DISTINCT FROM p_remarcada_de
        AND a.estado IN ('marcada', 'confirmada', 'aguardando_remanejamento') AND lower(v.periodo) > now())
     >= app.limite_consultas_futuras()
  OR (SELECT count(*) FROM app.agendamento a JOIN app.vaga v ON v.id = a.vaga_id
      WHERE a.cidadao_vinculo_id = p_cidadao_vinculo_id AND a.id <> v_id AND a.id IS DISTINCT FROM p_remarcada_de
        AND a.estado IN ('marcada', 'confirmada', 'aguardando_remanejamento') AND lower(v.periodo) > now())
     >= app.limite_consultas_titular() THEN
    RAISE EXCEPTION 'limite_consultas' USING ERRCODE = 'check_violation';
  END IF;

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

-- Remarcar mantém o paciente (titular ou o mesmo dependente).
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
  RETURN v_novo;
END
$$;

-- ---------------------------------------------------------------- avisos
ALTER TABLE app.notificacao DROP CONSTRAINT notificacao_modelo_check;
ALTER TABLE app.notificacao ADD CONSTRAINT notificacao_modelo_check CHECK (modelo IN (
  'consulta_marcada', 'consulta_desmarcada', 'profissional_ausente', 'consulta_remarcada', 'recuperar_senha'));

-- Aviso de consulta vai para quem tem o contato: o titular, também quando a consulta é de dependente.
CREATE FUNCTION app.notificacao_destinatario() RETURNS trigger
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
    IF v_pessoa IS NOT NULL THEN
      NEW.pessoa_id := v_pessoa;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER notificacao_destinatario BEFORE INSERT ON app.notificacao
  FOR EACH ROW EXECUTE FUNCTION app.notificacao_destinatario();

-- Ao concluir, o link cifrado de recuperação sai da fila: não fica guardado depois de enviado.
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
  WHERE id = p_id AND p_estado IN ('enviada', 'falhou', 'sem_contato')
$$;

-- ---------------------------------------------------------------- nomes de pacientes
-- Nome de quem é atendido em cada consulta: para o titular das consultas e para a equipe com agenda.ver.
CREATE FUNCTION app.nomes_de_pacientes(p_agendamentos uuid[])
  RETURNS TABLE (agendamento_id uuid, nome text, dependente boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  WITH equipe AS (SELECT app.pode_no_municipio('agenda.ver') AS ok)
  SELECT a.id, p.nome, a.dependente_id IS NOT NULL
  FROM app.agendamento a
  JOIN app.pessoa p ON p.id = a.pessoa_id
  JOIN app.vinculo v ON v.tenant_id = a.tenant_id AND v.id = a.cidadao_vinculo_id
  CROSS JOIN equipe
  WHERE a.tenant_id = app.tenant_atual() AND a.id = ANY (p_agendamentos)
    AND (equipe.ok OR v.conta_id = app.conta_atual())
  LIMIT 500
$$;

-- Validação pública do comprovante: iniciais de quem é atendido (o dependente, se for o caso).
CREATE OR REPLACE FUNCTION app.comprovante_validar(p_tenant uuid, p_token_hash bytea)
  RETURNS TABLE (estado text, inicio timestamptz, unidade text, profissional text, especialidade text,
                 iniciais text, municipio text, fuso text, emitido_em timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_anterior text := current_setting('app.tenant_id', true);
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  RETURN QUERY
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
  JOIN app.pessoa pe ON pe.id = a.pessoa_id
  JOIN app.tenant t ON t.id = c.tenant_id
  WHERE c.tenant_id = p_tenant AND c.token_hash = p_token_hash AND length(p_token_hash) = 32;
  PERFORM set_config('app.tenant_id', COALESCE(v_anterior, ''), true);
END
$$;

-- ---------------------------------------------------------------- dependentes: pedir, listar
-- O titular pede (fica pendente, a unidade confere a certidão ou o termo de guarda/curatela);
-- a recepção, com o documento em mãos, inclui já ativo. Se o CPF já existe, usa a pessoa existente
-- sem alterar o nome, e o titular recebe a mesma resposta (o pedido não revela cadastros).
CREATE FUNCTION app.dependente_solicitar(p_titular_vinculo uuid, p_nome text, p_cpf_cifrado bytea, p_cpf_indice bytea,
                                         p_nascimento date, p_nome_curto text, p_parentesco text)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_titular app.vinculo%ROWTYPE;
  v_estado text;
  v_pessoa uuid;
  v_id uuid;
BEGIN
  SELECT * INTO v_titular FROM app.vinculo
  WHERE id = p_titular_vinculo AND tenant_id = app.tenant_atual() AND papel = 'cidadao' AND estado = 'ativo';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'titular_invalido' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_titular.conta_id = app.conta_atual() THEN
    v_estado := 'pendente';
  ELSIF app.pode_no_municipio('recepcao.assistido') THEN
    v_estado := 'ativo';
  ELSE
    RAISE EXCEPTION 'sem_permissao' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF (SELECT count(*) FROM app.dependente WHERE titular_vinculo_id = p_titular_vinculo AND estado IN ('pendente', 'ativo'))
     >= app.limite_dependentes() THEN
    RAISE EXCEPTION 'limite_dependentes' USING ERRCODE = 'check_violation';
  END IF;

  SELECT r.pessoa_id INTO v_pessoa FROM app.pessoa_registrar(p_nome, p_cpf_cifrado, p_cpf_indice, p_nascimento) r;
  IF v_pessoa = (SELECT c.pessoa_id FROM app.conta c WHERE c.id = v_titular.conta_id) THEN
    RAISE EXCEPTION 'dependente_invalido' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO app.dependente (tenant_id, titular_vinculo_id, pessoa_id, nome_curto, parentesco, estado, pedido_por,
                              decidido_por, decidido_em)
  VALUES (app.tenant_atual(), p_titular_vinculo, v_pessoa, p_nome_curto, p_parentesco, v_estado, app.conta_atual(),
          CASE WHEN v_estado = 'ativo' THEN app.conta_atual() END, CASE WHEN v_estado = 'ativo' THEN now() END)
  ON CONFLICT (tenant_id, titular_vinculo_id, pessoa_id) WHERE estado IN ('pendente', 'ativo') DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM app.dependente
    WHERE titular_vinculo_id = p_titular_vinculo AND pessoa_id = v_pessoa AND estado IN ('pendente', 'ativo');
  END IF;
  RETURN v_id;
END
$$;

-- Para a equipe conferir: nome registrado da pessoa, idade e se ela tem conta própria
-- (adulto com conta raramente é dependente: vale conferir com mais cuidado).
CREATE FUNCTION app.dependentes_para_conferir()
  RETURNS TABLE (id uuid, titular_vinculo_id uuid, titular text, nome text, nome_curto text, parentesco text,
                 nascimento date, tem_conta boolean, criado_em timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
BEGIN
  IF NOT app.pode_no_municipio('cidadao.aprovar') THEN
    RAISE EXCEPTION 'sem_permissao' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT d.id, d.titular_vinculo_id, pt.nome, pd.nome, d.nome_curto, d.parentesco, pd.nascimento,
         EXISTS (SELECT 1 FROM app.conta c2 WHERE c2.pessoa_id = d.pessoa_id), d.criado_em
  FROM app.dependente d
  JOIN app.vinculo v ON v.tenant_id = d.tenant_id AND v.id = d.titular_vinculo_id
  JOIN app.conta c ON c.id = v.conta_id
  JOIN app.pessoa pt ON pt.id = c.pessoa_id
  JOIN app.pessoa pd ON pd.id = d.pessoa_id
  WHERE d.tenant_id = app.tenant_atual() AND d.estado = 'pendente'
  ORDER BY d.criado_em
  LIMIT 200;
END
$$;

-- Ficha do cidadão para a recepção: dependentes com nome completo e nascimento.
CREATE FUNCTION app.dependentes_do_titular(p_titular_vinculo uuid)
  RETURNS TABLE (id uuid, nome text, nome_curto text, parentesco text, nascimento date, estado text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
BEGIN
  IF NOT app.pode_no_municipio('cidadao.ver') THEN
    RAISE EXCEPTION 'sem_permissao' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT d.id, p.nome, d.nome_curto, d.parentesco, p.nascimento, d.estado
  FROM app.dependente d JOIN app.pessoa p ON p.id = d.pessoa_id
  WHERE d.tenant_id = app.tenant_atual() AND d.titular_vinculo_id = p_titular_vinculo AND d.estado IN ('pendente', 'ativo')
  ORDER BY d.criado_em
  LIMIT 50;
END
$$;

-- ---------------------------------------------------------------- recepção: busca e cadastro assistido
-- Busca por CPF (índice cego, exato) ou por parte do nome (mínimo 3 letras), só cidadãos do município.
CREATE FUNCTION app.cidadaos_buscar(p_cpf_indice bytea, p_nome text)
  RETURNS TABLE (vinculo_id uuid, nome text, nascimento date, estado text, dependentes integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_padrao text;
BEGIN
  IF NOT app.pode_no_municipio('cidadao.ver') THEN
    RAISE EXCEPTION 'sem_permissao' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_cpf_indice IS NULL AND (p_nome IS NULL OR length(trim(p_nome)) < 3) THEN
    RETURN;
  END IF;
  v_padrao := '%' || replace(replace(replace(trim(coalesce(p_nome, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  RETURN QUERY
  SELECT v.id, p.nome, p.nascimento, v.estado,
         (SELECT count(*)::integer FROM app.dependente d WHERE d.titular_vinculo_id = v.id AND d.estado = 'ativo')
  FROM app.vinculo v
  JOIN app.conta c ON c.id = v.conta_id
  JOIN app.pessoa p ON p.id = c.pessoa_id
  WHERE v.tenant_id = app.tenant_atual() AND v.papel = 'cidadao'
    AND (CASE WHEN p_cpf_indice IS NOT NULL THEN p.cpf_indice = p_cpf_indice ELSE p.nome ILIKE v_padrao END)
  ORDER BY p.nome
  LIMIT 20;
END
$$;

-- Cadastro feito pela recepção, com documento conferido e aceite dos termos lido para o cidadão.
-- Nasce ativo. Se a pessoa já existe, não troca o nome; só preenche o e-mail se ainda não houver
-- (trocar o contato de quem já tem cadastro abriria caminho para tomar a conta pela recuperação).
-- A conta criada aqui tem senha aleatória que ninguém conhece: o acesso vem por link de primeiro acesso.
CREATE FUNCTION app.cidadao_cadastro_assistido(p_nome text, p_cpf_cifrado bytea, p_cpf_indice bytea, p_nascimento date,
                                               p_email_cifrado bytea, p_senha_hash text)
  RETURNS TABLE (vinculo_id uuid, situacao text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_pessoa uuid;
  v_conta uuid;
  v_vinculo uuid;
  v_estado text;
BEGIN
  IF app.tenant_atual() IS NULL OR NOT app.pode_no_municipio('recepcao.assistido') THEN
    RAISE EXCEPTION 'sem_permissao' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_senha_hash IS NULL OR p_senha_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'dados_invalidos' USING ERRCODE = 'check_violation';
  END IF;

  SELECT r.pessoa_id INTO v_pessoa FROM app.pessoa_registrar(p_nome, p_cpf_cifrado, p_cpf_indice, p_nascimento) r;
  IF p_email_cifrado IS NOT NULL THEN
    UPDATE app.pessoa SET email_cifrado = p_email_cifrado WHERE id = v_pessoa AND email_cifrado IS NULL;
  END IF;

  SELECT c.id INTO v_conta FROM app.conta c WHERE c.pessoa_id = v_pessoa;
  IF v_conta IS NULL THEN
    INSERT INTO app.conta (pessoa_id, senha_hash) VALUES (v_pessoa, p_senha_hash) RETURNING id INTO v_conta;
  END IF;

  SELECT v.id, v.estado INTO v_vinculo, v_estado FROM app.vinculo v
  WHERE v.tenant_id = app.tenant_atual() AND v.conta_id = v_conta AND v.papel = 'cidadao';
  IF v_vinculo IS NULL THEN
    INSERT INTO app.vinculo (tenant_id, conta_id, papel, estado) VALUES (app.tenant_atual(), v_conta, 'cidadao', 'ativo')
    RETURNING id INTO v_vinculo;
    situacao := 'novo';
  ELSIF v_estado = 'convidado' THEN
    UPDATE app.vinculo SET estado = 'ativo' WHERE id = v_vinculo;
    situacao := 'aprovado';
  ELSIF v_estado = 'ativo' THEN
    situacao := 'ja_cadastrado';
  ELSE
    RAISE EXCEPTION 'cidadao_bloqueado' USING ERRCODE = 'check_violation';
  END IF;

  IF situacao <> 'ja_cadastrado' THEN
    INSERT INTO app.aceite_termos (tenant_id, vinculo_id, versao, canal, registrado_por)
    VALUES (app.tenant_atual(), v_vinculo, app.termos_versao(), 'assistido', app.conta_atual());
  END IF;
  vinculo_id := v_vinculo;
  RETURN NEXT;
END
$$;

-- Autocadastro passa a registrar o aceite dos termos.
CREATE OR REPLACE FUNCTION app.cidadao_autocadastro(p_nome text, p_cpf_cifrado bytea, p_cpf_indice bytea, p_nascimento date,
                                                    p_email_cifrado bytea, p_senha_hash text)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_pessoa uuid;
  v_conta uuid;
  v_vinculo uuid;
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
  INSERT INTO app.vinculo (tenant_id, conta_id, papel, estado) VALUES (app.tenant_atual(), v_conta, 'cidadao', 'convidado')
  RETURNING id INTO v_vinculo;
  INSERT INTO app.aceite_termos (tenant_id, vinculo_id, versao, canal, registrado_por)
  VALUES (app.tenant_atual(), v_vinculo, app.termos_versao(), 'autocadastro', v_conta);
  RETURN v_conta;
END
$$;

-- ---------------------------------------------------------------- recuperação e primeiro acesso
-- Conta que pode receber link de recuperação por e-mail neste município (com e-mail e vínculo vigente).
CREATE FUNCTION app.recuperacao_conta(p_cpf_indice bytea)
  RETURNS TABLE (conta_id uuid, pessoa_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  SELECT c.id, p.id
  FROM app.pessoa p
  JOIN app.conta c ON c.pessoa_id = p.id AND NOT c.bloqueada
  WHERE p.cpf_indice = p_cpf_indice AND p.email_cifrado IS NOT NULL
    AND EXISTS (SELECT 1 FROM app.vinculo v
                WHERE v.tenant_id = app.tenant_atual() AND v.conta_id = c.id AND v.estado IN ('convidado', 'ativo'))
$$;

-- Conta de um cidadão do município que pode receber link de primeiro acesso entregue pela recepção.
-- Nunca para conta com papel de equipe ou gestor em qualquer município, nem super admin.
CREATE FUNCTION app.acesso_assistido_conta(p_vinculo uuid)
  RETURNS uuid
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_conta uuid;
BEGIN
  IF NOT app.pode_no_municipio('recepcao.assistido') THEN
    RAISE EXCEPTION 'sem_permissao' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT c.id INTO v_conta
  FROM app.vinculo v JOIN app.conta c ON c.id = v.conta_id
  WHERE v.id = p_vinculo AND v.tenant_id = app.tenant_atual() AND v.papel = 'cidadao' AND v.estado = 'ativo'
    AND NOT c.bloqueada AND NOT c.super_admin;
  IF v_conta IS NULL OR EXISTS (SELECT 1 FROM app.vinculo e WHERE e.conta_id = v_conta AND e.papel <> 'cidadao') THEN
    RETURN NULL;
  END IF;
  RETURN v_conta;
END
$$;

-- Troca a senha com um link válido: consome o link (uso único), grava a nova senha, derruba as sessões
-- e invalida os outros links de acesso pendentes da conta. NULL para link inválido, vencido ou usado.
CREATE FUNCTION app.senha_redefinir_com_link(p_token_hash bytea, p_finalidade text, p_senha_hash text)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_conta uuid;
BEGIN
  IF app.tenant_atual() IS NULL OR p_finalidade NOT IN ('recuperar_senha', 'convite') THEN
    RETURN NULL;
  END IF;
  IF p_senha_hash IS NULL OR p_senha_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'dados_invalidos' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE app.token_acao SET usado_em = now()
  WHERE tenant_id = app.tenant_atual() AND token_hash = p_token_hash AND finalidade = p_finalidade
    AND usado_em IS NULL AND expira_em > now()
  RETURNING objeto_id INTO v_conta;
  IF v_conta IS NULL THEN
    RETURN NULL;
  END IF;
  -- Primeiro acesso entregue pela recepção: refaz a trava (o papel pode ter mudado depois do link).
  IF p_finalidade = 'convite' AND EXISTS (SELECT 1 FROM app.vinculo e WHERE e.conta_id = v_conta AND e.papel <> 'cidadao') THEN
    RETURN NULL;
  END IF;
  UPDATE app.conta SET senha_hash = p_senha_hash WHERE id = v_conta AND NOT bloqueada AND NOT super_admin;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  PERFORM app.sessao_revogar_conta(v_conta, 'senha_redefinida');
  UPDATE app.token_acao SET usado_em = now()
  WHERE tenant_id = app.tenant_atual() AND objeto_id = v_conta AND finalidade IN ('recuperar_senha', 'convite')
    AND usado_em IS NULL;
  RETURN v_conta;
END
$$;

RESET ROLE;

-- ---------------------------------------------------------------- privilégios
GRANT SELECT ON app.aceite_termos TO cf_app;
GRANT SELECT ON app.dependente TO cf_app;
GRANT UPDATE (estado) ON app.dependente TO cf_app;

REVOKE ALL ON FUNCTION
  app.pode_no_municipio(text), app.termos_versao(), app.limite_dependentes(), app.limite_consultas_titular(),
  app.dependente_validar_transicao(), app.preencher_pessoa_do_agendamento(), app.notificacao_destinatario(),
  app.agendamento_marcar(uuid, uuid, uuid, uuid), app.nomes_de_pacientes(uuid[]),
  app.dependente_solicitar(uuid, text, bytea, bytea, date, text, text), app.dependentes_para_conferir(),
  app.dependentes_do_titular(uuid), app.cidadaos_buscar(bytea, text),
  app.cidadao_cadastro_assistido(text, bytea, bytea, date, bytea, text),
  app.recuperacao_conta(bytea), app.acesso_assistido_conta(uuid), app.senha_redefinir_com_link(bytea, text, text)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  app.pode_no_municipio(text), app.termos_versao(), app.limite_dependentes(), app.limite_consultas_titular(),
  app.agendamento_marcar(uuid, uuid, uuid, uuid), app.nomes_de_pacientes(uuid[]),
  app.dependente_solicitar(uuid, text, bytea, bytea, date, text, text), app.dependentes_para_conferir(),
  app.dependentes_do_titular(uuid), app.cidadaos_buscar(bytea, text),
  app.cidadao_cadastro_assistido(text, bytea, bytea, date, bytea, text),
  app.recuperacao_conta(bytea), app.acesso_assistido_conta(uuid), app.senha_redefinir_com_link(bytea, text, text)
TO cf_app;
