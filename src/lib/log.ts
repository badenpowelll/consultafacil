import { randomUUID } from "node:crypto";
import { redigir } from "@/lib/security/redacao";

/**
 * Log da aplicação. Regras:
 *  - nunca recebe objetos inteiros (linhas do banco, corpo de requisição, erro do driver);
 *  - só campos primitivos, com nomes de uma lista de permitidos;
 *  - todo texto passa por `redigir` antes de sair do processo.
 * Logs vão para o Railway, que é um terceiro: o que sai daqui é tratado como público.
 */
type Primitivo = string | number | boolean | null;

const CAMPOS_PERMITIDOS = new Set([
  "evento", "modulo", "rota", "metodo", "status", "duracao_ms", "correlacao",
  "tenant_id", "conta_id", "objeto_tipo", "objeto_id", "quantidade", "motivo", "codigo",
]);

export function montarLinha(nivel: "info" | "aviso" | "erro", campos: Record<string, Primitivo | undefined>): string {
  const saida: Record<string, Primitivo> = { nivel, em: new Date().toISOString() };
  for (const [chave, valor] of Object.entries(campos)) {
    if (valor === undefined || !CAMPOS_PERMITIDOS.has(chave)) continue;
    saida[chave] = typeof valor === "string" ? redigir(valor).slice(0, 300) : valor;
  }
  return JSON.stringify(saida);
}

export function logInfo(campos: Record<string, Primitivo | undefined>): void {
  console.warn(montarLinha("info", campos));
}

/**
 * Registra uma falha sem a mensagem nem a pilha do erro (que podem trazer valores de
 * consulta). Fica só o tipo e o código (ex.: código SQLSTATE do Postgres) e um id de
 * correlação, que é o mesmo devolvido ao usuário para o suporte localizar o registro.
 */
export function logErro(contexto: { evento: string; rota?: string }, erro: unknown): string {
  const correlacao = randomUUID();
  const codigo = typeof erro === "object" && erro !== null && "code" in erro ? String((erro as { code: unknown }).code) : undefined;
  const tipo = erro instanceof Error ? erro.name : typeof erro;
  console.error(montarLinha("erro", { ...contexto, correlacao, codigo, motivo: tipo }));
  return correlacao;
}
