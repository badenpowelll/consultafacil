import { Pool, type PoolClient } from "pg";
import { env } from "@/lib/env";

/**
 * Pool de conexões do papel cf_app (sem posse de tabelas e sem BYPASSRLS).
 * Nunca use a URL de administração aqui.
 */
let pool: Pool | undefined;

export function obterPool(): Pool {
  pool ??= new Pool({
    connectionString: env().DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Consulta que demora demais é cancelada pelo próprio banco.
    statement_timeout: 10_000,
    application_name: "consulta-facil",
  });
  return pool;
}

export async function encerrarPool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

export type Conexao = PoolClient;
