/**
 * Define a senha do papel cf_app a partir de CF_APP_DB_PASSWORD, sem gravá-la em migração ou repositório.
 */
import { Client } from "pg";

/** Encerra com uma mensagem fixa (nunca com valores vindos do ambiente). */
function parar(mensagem: string): never {
  console.error(mensagem);
  process.exit(1);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_ADMIN;
  const senha = process.env.CF_APP_DB_PASSWORD;
  if (!url) parar("DATABASE_URL_ADMIN não definida");
  if (!senha || senha.length < 24) parar("CF_APP_DB_PASSWORD ausente ou com menos de 24 caracteres");

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
  // Este script manipula segredos (senha e chaves): nunca registra a mensagem do erro, que pode
  // carregar valores. Só o código SQLSTATE ou o nome do erro.
  const codigo = (erro as { code?: unknown })?.code;
  const nome = erro instanceof Error ? erro.name : "erro";
  console.error(`falhou (${typeof codigo === "string" ? codigo : nome}); confira as variáveis de ambiente`);
  process.exit(1);
});
