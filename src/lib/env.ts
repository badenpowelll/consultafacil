import { z } from "zod";

/**
 * Configuração validada na inicialização. Falta de segredo derruba o processo em vez de
 * seguir com valor padrão inseguro.
 */
const esquema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  // Chaves de dados versionadas: "1:<base64 de 32 bytes>,2:<base64 de 32 bytes>"
  CF_CHAVES_DADOS: z.string().min(1),
  CF_CHAVE_DADOS_ATIVA: z.coerce.number().int().min(1).max(255),
  // Chave do índice cego (HMAC) para CPF e CNS. Separada das chaves de dados.
  CF_CHAVE_INDICE: z.string().min(1),
  CF_DOMINIO_BASE: z.string().min(3).default("localhost"),
  CF_SESSAO_OCIOSA_MIN: z.coerce.number().int().min(5).max(240).default(30),
  CF_SESSAO_ABSOLUTA_H: z.coerce.number().int().min(1).max(24).default(12),
});

export type Env = z.infer<typeof esquema>;

let cache: Env | undefined;

export function env(): Env {
  if (!cache) {
    const resultado = esquema.safeParse(process.env);
    if (!resultado.success) {
      const campos = resultado.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Configuração inválida ou ausente: ${campos}`);
    }
    conferirSegregacaoDeSegredos(resultado.data);
    cache = resultado.data;
  }
  return cache;
}

/**
 * Em produção, o processo da aplicação não pode carregar credenciais que não usa. Se a
 * aplicação for comprometida (ou um log despejar o ambiente), o estrago fica limitado ao
 * papel cf_app. A URL administrativa e a senha do seed existem só no job de migração.
 */
const PROIBIDAS_EM_PRODUCAO = ["DATABASE_URL_ADMIN", "CF_SEED_SENHA", "CF_APP_DB_PASSWORD"] as const;

export function conferirSegregacaoDeSegredos(e: Env, ambiente: Record<string, string | undefined> = process.env): void {
  if (e.NODE_ENV !== "production" || ambiente.CF_PROCESSO === "migracao") return;
  const presentes = PROIBIDAS_EM_PRODUCAO.filter((nome) => (ambiente[nome] ?? "") !== "");
  if (presentes.length > 0) {
    throw new Error(`Variáveis administrativas presentes no processo da aplicação: ${presentes.join(", ")}`);
  }
  let usuario = "";
  try {
    usuario = decodeURIComponent(new URL(e.DATABASE_URL).username);
  } catch {
    usuario = "";
  }
  if (usuario !== "cf_app") throw new Error("DATABASE_URL da aplicação precisa usar o papel cf_app");
}

/** Apenas para testes. */
export function limparCacheEnv(): void {
  cache = undefined;
}
