/**
 * Infraestrutura de produção no Railway, como código (Railway Infrastructure as Code).
 *
 * Aplicar: `railway login`, `railway link`, `railway config plan` (confere) e `railway config apply`.
 * Depois disso, cada push em `main` publica o site sozinho, e só quando o CI do GitHub passa.
 *
 * Segredos NUNCA ficam aqui: as variáveis marcadas com preserve() são preenchidas uma vez no
 * painel do Railway e o apply mantém o valor que estiver lá. Passo a passo em docs/deploy-railway.md.
 */
import { defineRailway, github, postgres, preserve, project, service } from "railway/iac";

const REPOSITORIO = "badenpowelll/consultafacil";
const RAMO = "main";

/**
 * O worker de e-mail (`npm run worker`) só sobe em produção com o Resend configurado.
 * Troque para true quando a conta e o domínio do remetente estiverem prontos.
 */
const COM_WORKER = false;

/**
 * Ambiente de TESTE (homologação), com dados fictícios: a cada publicação o pré-deploy recria o
 * "Município de Demonstração" e as contas de teste (senha em CF_SEED_SENHA), e o endereço gerado
 * pelo Railway abre direto esse município (CF_MUNICIPIO_UNICO), já que ele não aceita subdomínios.
 *
 * Antes de qualquer dado real: troque para false E use um banco novo (as contas de teste têm senha
 * conhecida e não podem existir em produção). Passo a passo em docs/deploy-railway.md.
 */
const HOMOLOGACAO = true;

/**
 * O processo da aplicação não pode carregar credenciais administrativas (ver src/lib/env.ts
 * e a política de segurança). Elas existem no serviço só para o comando de pré-deploy; o
 * `env -u` as retira do ambiente antes de o servidor subir.
 */
const SEM_SEGREDOS_ADMIN = "env -u DATABASE_URL_ADMIN -u CF_APP_DB_PASSWORD -u CF_SEED_SENHA";

export default defineRailway(() => {
  const banco = postgres("postgres");

  const ambiente = HOMOLOGACAO ? "homologacao" : "producao";

  const site = service("site", {
    source: github(REPOSITORIO, { branch: RAMO, checkSuites: true }),
    build: { builder: "RAILPACK", buildCommand: "npm run build" },
    // Migrações rodam fora do processo da aplicação, antes de a versão nova receber tráfego.
    // Se falharem, o deploy para e a versão anterior continua no ar.
    preDeploy: [HOMOLOGACAO ? "npm run db:homologacao" : "npm run db:predeploy"],
    start: `${SEM_SEGREDOS_ADMIN} node_modules/.bin/next start -H 0.0.0.0`,
    healthcheck: "/api/health",
    healthcheckTimeout: 120,
    deploy: { restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 5, drainingSeconds: 20 },
    env: {
      NODE_ENV: "production",
      CF_AMBIENTE: ambiente,
      NEXT_TELEMETRY_DISABLED: "1",
      CF_CHAVE_DADOS_ATIVA: "1",
      CF_SESSAO_OCIOSA_MIN: "30",
      CF_SESSAO_ABSOLUTA_H: "12",
      // Só para o pré-deploy (migrações e senha do papel cf_app).
      DATABASE_URL_ADMIN: banco.env.DATABASE_URL,
      // Preenchidos no painel do Railway (docs/deploy-railway.md).
      CF_APP_DB_PASSWORD: preserve(),
      DATABASE_URL: preserve(),
      CF_CHAVES_DADOS: preserve(),
      CF_CHAVE_INDICE: preserve(),
      CF_DOMINIO_BASE: preserve(),
      ...(HOMOLOGACAO ? { CF_MUNICIPIO_UNICO: "demo", CF_SEED_SENHA: preserve() } : {}),
    },
  });

  const recursos = [banco, site];

  if (COM_WORKER) {
    const worker = service("worker", {
      source: github(REPOSITORIO, { branch: RAMO, checkSuites: true }),
      build: { builder: "RAILPACK", buildCommand: "npm run build" },
      start: "npm run worker",
      deploy: { restartPolicyType: "ALWAYS", drainingSeconds: 20 },
      env: {
        NODE_ENV: "production",
        CF_AMBIENTE: ambiente,
        CF_CHAVE_DADOS_ATIVA: "1",
        CF_EMAIL_TRANSPORTE: "resend",
        RESEND_API_KEY: preserve(),
        CF_EMAIL_REMETENTE: preserve(),
        // Mesmos valores do site, por referência: cada segredo é digitado uma vez só.
        DATABASE_URL: site.env.DATABASE_URL,
        CF_CHAVES_DADOS: site.env.CF_CHAVES_DADOS,
        CF_CHAVE_INDICE: site.env.CF_CHAVE_INDICE,
        CF_DOMINIO_BASE: site.env.CF_DOMINIO_BASE,
        ...(HOMOLOGACAO ? { CF_MUNICIPIO_UNICO: "demo" } : {}),
      },
    });
    recursos.push(worker);
  }

  return project("consulta-facil", { resources: recursos });
});
