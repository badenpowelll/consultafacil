/**
 * Define a senha do papel cf_app a partir de CF_APP_DB_PASSWORD, sem gravá-la em migração ou repositório.
 */
import { Client } from "pg";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_ADMIN;
  const senha = process.env.CF_APP_DB_PASSWORD;
  if (!url) throw new Error("DATABASE_URL_ADMIN não definida");
  if (!senha || senha.length < 24) throw new Error("CF_APP_DB_PASSWORD ausente ou com menos de 24 caracteres");

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    // ALTER ROLE não aceita parâmetro; format() com %L escapa o literal com segurança.
    const { rows } = await client.query<{ sql: string }>("SELECT format('ALTER ROLE cf_app PASSWORD %L', $1::text) AS sql", [senha]);
    await client.query(rows[0]!.sql);
    console.warn("senha de cf_app atualizada");
  } finally {
    await client.end();
  }
}

main().catch((erro: unknown) => {
  console.error(erro instanceof Error ? erro.message : erro);
  process.exit(1);
});
