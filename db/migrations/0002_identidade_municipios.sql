-- Consulta Fácil 2.0 — migração 0002: identidade global, municípios, vínculos, permissões e auditoria.
--
-- Duas famílias de tabelas:
--   Globais sensíveis (pessoa, conta, sessao, ocupacao_pessoa, limite_tentativa):
--     RLS ligado SEM políticas para cf_app e sem GRANT direto. Só são acessadas por funções
--     SECURITY DEFINER com propósito único, que devolvem o mínimo necessário.
--   Municipais (vinculo, unidade, perfil_*, auditoria, token_acao):
--     RLS FORÇADO (vale até para o dono), política por tenant_id = app.tenant_atual()
--     em leitura e escrita, e chaves estrangeiras compostas com tenant_id.

SET ROLE cf_owner;

-- ---------------------------------------------------------------- municípios
CREATE TABLE app.tenant (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$'),
  nome        text NOT NULL CHECK (length(nome) BETWEEN 2 AND 120),
  estado      text NOT NULL DEFAULT 'provisionando'
              CHECK (estado IN ('provisionando', 'ativo', 'suspenso', 'encerrando', 'encerrado')),
  criado_em   timestamptz NOT NULL DEFAULT now(),
  alterado_em timestamptz NOT NULL DEFAULT now()
);

-- Dados públicos do município (resolução por subdomínio). Sem dado pessoal.
ALTER TABLE app.tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_leitura_publica ON app.tenant FOR SELECT TO cf_app USING (true);
GRANT SELECT ON app.tenant TO cf_app;

CREATE TABLE app.identidade_visual (
  tenant_id    uuid PRIMARY KEY REFERENCES app.tenant (id),
  logo_chave   text,          -- chave do objeto no bucket privado: tenant/<id>/marca/...
  brasao_chave text,
  cor_primaria text CHECK (cor_primaria ~ '^#[0-9a-fA-F]{6}$'),
  cor_secundaria text CHECK (cor_secundaria ~ '^#[0-9a-fA-F]{6}$'),
  versao       integer NOT NULL DEFAULT 1,
  alterado_em  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.identidade_visual ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.identidade_visual FORCE ROW LEVEL SECURITY;
CREATE POLICY identidade_visual_municipio ON app.identidade_visual TO cf_app
  USING (tenant_id = app.tenant_atual()) WITH CHECK (tenant_id = app.tenant_atual());
GRANT SELECT, INSERT, UPDATE ON app.identidade_visual TO cf_app;

-- ---------------------------------------------------------------- pessoas e contas (globais)
CREATE TABLE app.pessoa (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome            text NOT NULL CHECK (length(nome) BETWEEN 2 AND 160),
  cpf_cifrado     bytea NOT NULL,              -- AES-256-GCM, chave versionada (ver src/lib/security/crypto.ts)
  cpf_indice      bytea NOT NULL UNIQUE,       -- HMAC-SHA-256 com chave própria: busca sem revelar o CPF
  cns_cifrado     bytea,
  cns_indice      bytea UNIQUE,
  nascimento      date,
  criado_em       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.pessoa ENABLE ROW LEVEL SECURITY;  -- sem política para cf_app: acesso só via funções

CREATE TABLE app.conta (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pessoa_id          uuid NOT NULL UNIQUE REFERENCES app.pessoa (id),
  senha_hash         text NOT NULL,            -- Argon2id
  mfa_segredo_cifrado bytea,
  mfa_ativo          boolean NOT NULL DEFAULT false,
  super_admin        boolean NOT NULL DEFAULT false,
  bloqueada          boolean NOT NULL DEFAULT false,
  criado_em          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.conta ENABLE ROW LEVEL SECURITY;

CREATE TABLE app.sessao (
  id_hash          bytea PRIMARY KEY,          -- SHA-256 do identificador opaco; o valor em si só existe no cookie
  conta_id         uuid NOT NULL REFERENCES app.conta (id),
  tenant_id        uuid REFERENCES app.tenant (id),   -- município de atuação escolhido
  mfa_verificado   boolean NOT NULL DEFAULT false,
  criada_em        timestamptz NOT NULL DEFAULT now(),
  ultima_atividade timestamptz NOT NULL DEFAULT now(),
  expira_absoluta  timestamptz NOT NULL,
  revogada_em      timestamptz,
  motivo_revogacao text
);
CREATE INDEX sessao_conta_ativa ON app.sessao (conta_id) WHERE revogada_em IS NULL;
ALTER TABLE app.sessao ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------- vínculos e permissões (municipais)
CREATE TABLE app.vinculo (
  id        uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenant (id),
  conta_id  uuid NOT NULL REFERENCES app.conta (id),
  papel     text NOT NULL CHECK (papel IN ('gestor', 'equipe', 'cidadao')),
  estado    text NOT NULL DEFAULT 'convidado' CHECK (estado IN ('convidado', 'ativo', 'suspenso', 'revogado')),
  criado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, conta_id, papel)
);

CREATE TABLE app.unidade (
  id        uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenant (id),
  nome      text NOT NULL CHECK (length(nome) BETWEEN 2 AND 160),
  ativa     boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id)
);

-- Catálogo global de permissões, definido pelo sistema (somente leitura para a aplicação).
CREATE TABLE app.permissao (
  codigo    text PRIMARY KEY CHECK (codigo ~ '^[a-z]+(\.[a-z_]+)+$'),
  modulo    text NOT NULL,
  descricao text NOT NULL,
  clinica   boolean NOT NULL DEFAULT false  -- exige registro profissional para ser atribuída
);
GRANT SELECT ON app.permissao TO cf_app;

CREATE TABLE app.modulo_tenant (
  tenant_id uuid NOT NULL REFERENCES app.tenant (id),
  modulo    text NOT NULL,
  ativo     boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, modulo)
);

CREATE TABLE app.perfil_acesso (
  id        uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenant (id),
  nome      text NOT NULL CHECK (length(nome) BETWEEN 2 AND 80),
  criado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, nome)
);

CREATE TABLE app.perfil_permissao (
  tenant_id uuid NOT NULL,
  perfil_id uuid NOT NULL,
  permissao text NOT NULL REFERENCES app.permissao (codigo),
  PRIMARY KEY (tenant_id, perfil_id, permissao),
  FOREIGN KEY (tenant_id, perfil_id) REFERENCES app.perfil_acesso (tenant_id, id) ON DELETE CASCADE
);

-- unidade_id NULL = perfil vale em todas as unidades do município.
CREATE TABLE app.vinculo_perfil (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  vinculo_id uuid NOT NULL,
  perfil_id  uuid NOT NULL,
  unidade_id uuid,
  FOREIGN KEY (tenant_id, vinculo_id) REFERENCES app.vinculo (tenant_id, id),
  FOREIGN KEY (tenant_id, perfil_id) REFERENCES app.perfil_acesso (tenant_id, id),
  FOREIGN KEY (tenant_id, unidade_id) REFERENCES app.unidade (tenant_id, id)
);
CREATE UNIQUE INDEX vinculo_perfil_unico
  ON app.vinculo_perfil (tenant_id, vinculo_id, perfil_id, COALESCE(unidade_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ---------------------------------------------------------------- tokens de ação (links)
CREATE TABLE app.token_acao (
  id         uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES app.tenant (id),
  finalidade text NOT NULL CHECK (finalidade IN
               ('convite', 'verificar_contato', 'recuperar_senha', 'confirmar', 'cancelar', 'checkin', 'documento')),
  objeto_id  uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE,            -- só o hash; o token em claro só existe no link enviado
  expira_em  timestamptz NOT NULL,
  usado_em   timestamptz,
  criado_em  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- auditoria (somente inserção)
CREATE TABLE app.auditoria (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES app.tenant (id),
  conta_id    uuid,
  acao        text NOT NULL CHECK (acao ~ '^[a-z_]+(\.[a-z_]+)+$'),
  modulo      text NOT NULL,
  objeto_tipo text,
  objeto_id   text,
  detalhes    jsonb NOT NULL DEFAULT '{}'::jsonb,   -- nunca dado pessoal em claro
  ip          inet,
  criado_em   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auditoria_busca ON app.auditoria (tenant_id, criado_em DESC);
CREATE TRIGGER auditoria_somente_insercao BEFORE UPDATE OR DELETE ON app.auditoria
  FOR EACH ROW EXECUTE FUNCTION app.bloquear_alteracao();
CREATE TRIGGER auditoria_sem_truncate BEFORE TRUNCATE ON app.auditoria
  FOR EACH STATEMENT EXECUTE FUNCTION app.bloquear_alteracao();

-- ---------------------------------------------------------------- RLS municipal (forçado)
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vinculo', 'unidade', 'modulo_tenant', 'perfil_acesso', 'perfil_permissao',
                           'vinculo_perfil', 'token_acao', 'auditoria']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON app.%I TO cf_app USING (tenant_id = app.tenant_atual()) WITH CHECK (tenant_id = app.tenant_atual())',
      t || '_municipio', t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE ON app.vinculo, app.unidade, app.modulo_tenant, app.perfil_acesso, app.token_acao TO cf_app;
GRANT SELECT, INSERT, DELETE ON app.perfil_permissao, app.vinculo_perfil TO cf_app;
GRANT SELECT, INSERT ON app.auditoria TO cf_app;   -- sem UPDATE/DELETE: auditoria é imutável

RESET ROLE;
