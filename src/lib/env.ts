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
    cache = resultado.data;
  }
  return cache;
}

/** Apenas para testes. */
export function limparCacheEnv(): void {
  cache = undefined;
}
