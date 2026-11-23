/**
 * Dados FICTÍCIOS para desenvolvimento e previews. Recusa rodar em produção.
 * Cria um município de demonstração, uma unidade e uma conta de Super Admin e gestor.
 * O CPF é gerado com dígitos válidos, mas não pertence a ninguém conhecido; a senha vem de CF_SEED_SENHA.
 */
import { Client } from "pg";
import { cifrar, indiceCego } from "@/lib/security/crypto";
import { gerarHashSenha } from "@/lib/security/password";

const CPF_FICTICIO = "52998224725";

/** Encerra com uma mensagem fixa (nunca com valores vindos do ambiente). */
function parar(mensagem: string): never {
  console.error(mensagem);
  process.exit(1);
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production" || process.env.CF_AMBIENTE === "producao") {
    parar("Seed de dados fictícios não roda em produção");
  }
  const url = process.env.DATABASE_URL_ADMIN;
  const senha = process.env.CF_SEED_SENHA;
  if (!url) parar("DATABASE_URL_ADMIN não definida");
  if (!senha) parar("CF_SEED_SENHA não definida");

  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("BEGIN");
    const t = await db.query<{ id: string }>(
      `INSERT INTO app.tenant (slug, nome, estado) VALUES ('demo', 'Município de Demonstração', 'ativo')
       ON CONFLICT (slug) DO UPDATE SET nome = EXCLUDED.nome RETURNING id`,
    );
    const tenantId = t.rows[0]!.id;
    await db.query(
      `INSERT INTO app.unidade (tenant_id, nome)
       SELECT $1, 'UBS Demonstração Centro' WHERE NOT EXISTS (SELECT 1 FROM app.unidade WHERE tenant_id = $1)`,
      [tenantId],
    );
    const p = await db.query<{ id: string }>(
      `INSERT INTO app.pessoa (nome, cpf_cifrado, cpf_indice) VALUES ('Gestora Fictícia', $1, $2)
       ON CONFLICT (cpf_indice) DO UPDATE SET nome = EXCLUDED.nome RETURNING id`,
      [cifrar(CPF_FICTICIO, "pessoa.cpf"), indiceCego(CPF_FICTICIO, "pessoa.cpf")],
    );
    const c = await db.query<{ id: string }>(
      `INSERT INTO app.conta (pessoa_id, senha_hash, super_admin) VALUES ($1, $2, true)
       ON CONFLICT (pessoa_id) DO UPDATE SET senha_hash = EXCLUDED.senha_hash RETURNING id`,
      [p.rows[0]!.id, await gerarHashSenha(senha)],
    );
    await db.query(
      `INSERT INTO app.vinculo (tenant_id, conta_id, papel, estado) VALUES ($1, $2, 'gestor', 'ativo')
       ON CONFLICT (tenant_id, conta_id, papel) DO NOTHING`,
      [tenantId, c.rows[0]!.id],
    );
    await db.query("COMMIT");
    console.warn(`seed concluído: município 'demo', CPF fictício ${CPF_FICTICIO}`);
  } catch (erro) {
    await db.query("ROLLBACK");
    throw erro;
  } finally {
    await db.end();
  }
}

main().catch(() => {
  // Este script manipula segredos (senha e chaves): nenhum dado do erro vai para o log, porque
  // a mensagem ou os campos de um erro do driver podem carregar valores. Para depurar, rode
  // localmente com dados fictícios.
  console.error("falhou; confira as variáveis de ambiente e a conexão com o banco");
  process.exit(1);
});
