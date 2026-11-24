-- Consulta Fácil 2.0 — migração 0008: gestão do município.
--
-- 1. Perfis por setor: o gestor cria perfis (agendamento, recepção, enfermagem, médicos,
--    auxiliares, outros) e os atribui por unidade ou para o município inteiro.
--    Barreira contra escalada de privilégio, no banco: ninguém concede permissão que não tem
--    no município inteiro, nem atribui perfil com permissão que não tem.
-- 2. Logomarca do município guardada no próprio banco (imagem limpa, até 1 MB).
-- 3. Consulta da auditoria com o nome de quem agiu, sem expor outros dados pessoais.

-- ---------------------------------------------------------------- dono correto da 0007
-- A 0007 criou a tabela de comprovantes e a função de validação sem SET ROLE, então ficaram com
-- o papel administrativo como dono. Tudo do esquema pertence a cf_owner (NOLOGIN), inclusive as
-- funções SECURITY DEFINER, que assim não ignoram o RLS.
ALTER TABLE app.comprovante OWNER TO cf_owner;
ALTER FUNCTION app.comprovante_validar(uuid, bytea) OWNER TO cf_owner;

SET ROLE cf_owner;

-- Leitura pelo dono só no município do contexto, como nas outras políticas *_dono.
CREATE POLICY perfil_acesso_dono ON app.perfil_acesso FOR SELECT TO cf_owner USING (tenant_id = app.tenant_atual());
CREATE POLICY comprovante_dono ON app.comprovante FOR SELECT TO cf_owner USING (tenant_id = app.tenant_atual());
CREATE POLICY agendamento_dono ON app.agendamento FOR SELECT TO cf_owner USING (tenant_id = app.tenant_atual());
CREATE POLICY vaga_dono ON app.vaga FOR SELECT TO cf_owner USING (tenant_id = app.tenant_atual());
CREATE POLICY unidade_dono ON app.unidade FOR SELECT TO cf_owner USING (tenant_id = app.tenant_atual());
CREATE POLICY profissional_dono ON app.profissional FOR SELECT TO cf_owner USING (tenant_id = app.tenant_atual());
CREATE POLICY identidade_visual_dono ON app.identidade_visual FOR SELECT TO cf_owner USING (tenant_id = app.tenant_atual());

-- A validação pública roda sem sessão: assume o município do endereço só durante a consulta e
-- devolve o contexto anterior. Assim o RLS continua valendo também para o dono.
CREATE OR REPLACE FUNCTION app.comprovante_validar(p_tenant uuid, p_token_hash bytea)
  RETURNS TABLE (estado text, inicio timestamptz, unidade text, profissional text, especialidade text,
                 iniciais text, municipio text, fuso text, emitido_em timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
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
  JOIN app.vinculo vc ON vc.tenant_id = a.tenant_id AND vc.id = a.cidadao_vinculo_id
  JOIN app.conta co ON co.id = vc.conta_id
  JOIN app.pessoa pe ON pe.id = co.pessoa_id
  JOIN app.tenant t ON t.id = c.tenant_id
  WHERE c.tenant_id = p_tenant AND c.token_hash = p_token_hash AND length(p_token_hash) = 32;
  PERFORM set_config('app.tenant_id', COALESCE(v_anterior, ''), true);
END
$$;

-- ---------------------------------------------------------------- perfis por setor
ALTER TABLE app.perfil_acesso ADD COLUMN setor text NOT NULL DEFAULT 'outros'
  CHECK (setor IN ('agendamento', 'recepcao', 'enfermagem', 'medicos', 'auxiliares', 'outros'));
ALTER TABLE app.perfil_acesso ADD COLUMN ativo boolean NOT NULL DEFAULT true;
REVOKE UPDATE ON app.perfil_acesso FROM cf_app;
GRANT UPDATE (nome, setor, ativo) ON app.perfil_acesso TO cf_app;

CREATE FUNCTION app.conferir_concessao_permissao() RETURNS trigger
  LANGUAGE plpgsql SET search_path = app, pg_temp
AS $$
BEGIN
  -- Montagem de cenário pelo papel administrativo (migrações, testes) não passa por aqui.
  IF current_user <> 'cf_app' THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM app.permissao WHERE codigo = NEW.permissao AND clinica) THEN
    RAISE EXCEPTION 'permissao_clinica_fora_do_piloto';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.minhas_permissoes(NULL) AS m(codigo) WHERE m.codigo = NEW.permissao) THEN
    RAISE EXCEPTION 'concessao_acima_do_proprio_acesso';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER perfil_permissao_conferir BEFORE INSERT ON app.perfil_permissao
  FOR EACH ROW EXECUTE FUNCTION app.conferir_concessao_permissao();

CREATE FUNCTION app.conferir_atribuicao_perfil() RETURNS trigger
  LANGUAGE plpgsql SET search_path = app, pg_temp
AS $$
BEGIN
  IF current_user <> 'cf_app' THEN RETURN NEW; END IF;
  IF EXISTS (
    SELECT 1 FROM app.perfil_permissao pp
    WHERE pp.tenant_id = NEW.tenant_id AND pp.perfil_id = NEW.perfil_id
      AND pp.permissao NOT IN (SELECT m.codigo FROM app.minhas_permissoes(NULL) AS m(codigo))
  ) THEN
    RAISE EXCEPTION 'concessao_acima_do_proprio_acesso';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.vinculo v WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.vinculo_id
      AND v.papel IN ('gestor', 'equipe') AND v.estado IN ('convidado', 'ativo')
  ) THEN
    RAISE EXCEPTION 'perfil_so_para_equipe';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.perfil_acesso p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.perfil_id AND p.ativo) THEN
    RAISE EXCEPTION 'perfil_inativo';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER vinculo_perfil_conferir BEFORE INSERT ON app.vinculo_perfil
  FOR EACH ROW EXECUTE FUNCTION app.conferir_atribuicao_perfil();

-- ---------------------------------------------------------------- arquivos do município
-- Logomarca (e, no futuro, brasão). Só imagens já limpas pela aplicação (PNG/JPEG sem metadados).
CREATE TABLE app.arquivo (
  tenant_id    uuid NOT NULL REFERENCES app.tenant (id),
  chave        text NOT NULL CHECK (chave ~ '^tenant/[0-9a-f-]{36}/marca/[0-9a-f-]{36}\.(png|jpg)$'),
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg')),
  dados        bytea NOT NULL CHECK (octet_length(dados) BETWEEN 1 AND 1048576),
  criado_por   uuid REFERENCES app.conta (id),
  criado_em    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, chave),
  CHECK (chave LIKE 'tenant/' || tenant_id::text || '/%')
);
CREATE TRIGGER arquivo_somente_insercao BEFORE UPDATE OR DELETE ON app.arquivo
  FOR EACH ROW EXECUTE FUNCTION app.bloquear_alteracao();
ALTER TABLE app.arquivo ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.arquivo FORCE ROW LEVEL SECURITY;
CREATE POLICY arquivo_municipio ON app.arquivo TO cf_app
  USING (tenant_id = app.tenant_atual()) WITH CHECK (tenant_id = app.tenant_atual());
GRANT SELECT, INSERT ON app.arquivo TO cf_app;

-- A logomarca é pública no site do município (aparece antes do login e no comprovante).
-- Esta função entrega só a logomarca vigente, pelo slug, sem contexto de sessão.
CREATE POLICY arquivo_dono ON app.arquivo FOR SELECT TO cf_owner USING (tenant_id = app.tenant_atual());

CREATE FUNCTION app.logomarca_publica(p_tenant uuid)
  RETURNS TABLE (content_type text, dados bytea, versao integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_anterior text := current_setting('app.tenant_id', true);
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  RETURN QUERY
  SELECT a.content_type, a.dados, iv.versao
  FROM app.identidade_visual iv
  JOIN app.tenant t ON t.id = iv.tenant_id AND t.estado = 'ativo'
  JOIN app.arquivo a ON a.tenant_id = iv.tenant_id AND a.chave = iv.logo_chave
  WHERE iv.tenant_id = p_tenant;
  PERFORM set_config('app.tenant_id', COALESCE(v_anterior, ''), true);
END
$$;

-- Só a versão (para o endereço da imagem no topo do site), sem carregar a imagem.
CREATE FUNCTION app.logomarca_versao(p_tenant uuid)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_anterior text := current_setting('app.tenant_id', true);
  v_versao integer;
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  SELECT iv.versao INTO v_versao FROM app.identidade_visual iv
  WHERE iv.tenant_id = p_tenant AND iv.logo_chave IS NOT NULL;
  PERFORM set_config('app.tenant_id', COALESCE(v_anterior, ''), true);
  RETURN v_versao;
END
$$;

-- ---------------------------------------------------------------- auditoria consultável
-- Nome de quem agiu, só para contas com vínculo no município do contexto.
CREATE FUNCTION app.nomes_de_contas(p_contas uuid[])
  RETURNS TABLE (conta_id uuid, nome text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  SELECT c.id, p.nome
  FROM app.conta c JOIN app.pessoa p ON p.id = c.pessoa_id
  WHERE c.id = ANY (p_contas)
    AND EXISTS (SELECT 1 FROM app.vinculo v WHERE v.conta_id = c.id AND v.tenant_id = app.tenant_atual())
$$;

REVOKE ALL ON FUNCTION app.logomarca_publica(uuid), app.logomarca_versao(uuid), app.nomes_de_contas(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.logomarca_publica(uuid), app.logomarca_versao(uuid), app.nomes_de_contas(uuid[]) TO cf_app;

-- Perfil desativado deixa de conceder permissões na hora, sem precisar remover cada atribuição.
CREATE OR REPLACE FUNCTION app.minhas_permissoes(p_unidade_id uuid)
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
  JOIN app.perfil_acesso pa ON pa.tenant_id = vp.tenant_id AND pa.id = vp.perfil_id AND pa.ativo
  JOIN app.perfil_permissao pp ON pp.tenant_id = vp.tenant_id AND pp.perfil_id = vp.perfil_id
  WHERE v.conta_id = app.conta_atual() AND v.tenant_id = app.tenant_atual() AND v.estado = 'ativo'
    AND (vp.unidade_id IS NULL OR vp.unidade_id = p_unidade_id)
$$;

RESET ROLE;
