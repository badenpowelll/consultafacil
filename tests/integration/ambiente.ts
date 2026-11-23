import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";

/**
 * Conexão administrativa usada só para montar cenários fictícios. Todas as verificações
 * dos testes rodam como cf_app, o mesmo papel da aplicação.
 */
export const admin = new Pool({
  connectionString: process.env.DATABASE_URL_ADMIN ?? "postgres://postgres:postgres@localhost:5432/consultafacil_test",
  max: 2,
});

export function sufixo(): string {
  return randomBytes(4).toString("hex");
}

export async function criarMunicipio(nome: string, estado = "ativo"): Promise<string> {
  const r = await admin.query<{ id: string }>(
    "INSERT INTO app.tenant (slug, nome, estado) VALUES ($1, $2, $3) RETURNING id",
    [`${nome.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${sufixo()}`, nome, estado],
  );
  return r.rows[0]!.id;
}

/** Pessoa fictícia com bytes aleatórios no lugar do CPF (o teste de login usa a cifra real). */
export async function criarPessoaEConta(opcoes: { superAdmin?: boolean } = {}): Promise<{ pessoaId: string; contaId: string }> {
  const p = await admin.query<{ id: string }>(
    "INSERT INTO app.pessoa (nome, cpf_cifrado, cpf_indice) VALUES ($1, $2, $3) RETURNING id",
    [`Pessoa Fictícia ${sufixo()}`, randomBytes(40), randomBytes(32)],
  );
  const pessoaId = p.rows[0]!.id;
  const c = await admin.query<{ id: string }>(
    "INSERT INTO app.conta (pessoa_id, senha_hash, super_admin) VALUES ($1, 'x', $2) RETURNING id",
    [pessoaId, opcoes.superAdmin ?? false],
  );
  return { pessoaId, contaId: c.rows[0]!.id };
}

export async function vincular(tenantId: string, contaId: string, papel: string, estado = "ativo"): Promise<string> {
  const r = await admin.query<{ id: string }>(
    "INSERT INTO app.vinculo (tenant_id, conta_id, papel, estado) VALUES ($1, $2, $3, $4) RETURNING id",
    [tenantId, contaId, papel, estado],
  );
  return r.rows[0]!.id;
}

export async function criarUnidade(tenantId: string, nome: string): Promise<string> {
  const r = await admin.query<{ id: string }>("INSERT INTO app.unidade (tenant_id, nome) VALUES ($1, $2) RETURNING id", [tenantId, nome]);
  return r.rows[0]!.id;
}

export async function atribuirPerfil(
  tenantId: string,
  vinculoId: string,
  permissoes: string[],
  unidadeId: string | null,
): Promise<string> {
  const perfil = await admin.query<{ id: string }>(
    "INSERT INTO app.perfil_acesso (tenant_id, nome) VALUES ($1, $2) RETURNING id",
    [tenantId, `Perfil ${sufixo()}`],
  );
  const perfilId = perfil.rows[0]!.id;
  for (const codigo of permissoes) {
    await admin.query("INSERT INTO app.perfil_permissao (tenant_id, perfil_id, permissao) VALUES ($1, $2, $3)", [
      tenantId,
      perfilId,
      codigo,
    ]);
  }
  await admin.query(
    "INSERT INTO app.vinculo_perfil (tenant_id, vinculo_id, perfil_id, unidade_id) VALUES ($1, $2, $3, $4)",
    [tenantId, vinculoId, perfilId, unidadeId],
  );
  return perfilId;
}

export { randomUUID };
