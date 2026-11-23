/**
 * Aplica as migrações SQL de db/migrations em ordem, cada uma numa transação.
 * Usa DATABASE_URL_ADMIN (papel com permissão de criar papéis e extensões), nunca o papel da aplicação.
 * Uma migração já aplicada não pode mudar: o checksum é conferido a cada execução.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_ADMIN;
  if (!url) throw new Error("DATABASE_URL_ADMIN não definida");

  const dir = path.join(process.cwd(), "db", "migrations");
  const arquivos = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS public.schema_migrations (arquivo text PRIMARY KEY, checksum text NOT NULL, aplicada_em timestamptz NOT NULL DEFAULT now())",
    );
    await client.query("REVOKE ALL ON public.schema_migrations FROM PUBLIC");
    const { rows } = await client.query<{ arquivo: string; checksum: string }>(
      "SELECT arquivo, checksum FROM public.schema_migrations",
    );
    const aplicadas = new Map(rows.map((r) => [r.arquivo, r.checksum]));

    for (const arquivo of arquivos) {
      const sql = await readFile(path.join(dir, arquivo), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const anterior = aplicadas.get(arquivo);
      if (anterior) {
        if (anterior !== checksum) {
          throw new Error(`Migração ${arquivo} foi alterada depois de aplicada. Crie uma nova migração.`);
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query(sql);
        await client.query("INSERT INTO public.schema_migrations (arquivo, checksum) VALUES ($1, $2)", [arquivo, checksum]);
        await client.query("COMMIT");
        console.warn(`aplicada: ${arquivo}`);
      } catch (erro) {
        await client.query("ROLLBACK");
        throw erro;
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((erro: unknown) => {
  console.error(erro instanceof Error ? erro.message : erro);
  process.exit(1);
});
