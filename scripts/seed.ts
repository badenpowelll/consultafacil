/**
 * Dados FICTÍCIOS para desenvolvimento e previews. Recusa rodar em produção.
 * Cria um município de demonstração, uma unidade e uma conta de Super Admin e gestor.
 * O CPF é gerado com dígitos válidos, mas não pertence a ninguém conhecido; a senha vem de CF_SEED_SENHA.
 */
import { Client } from "pg";
import { cifrar, indiceCego } from "@/lib/security/crypto";
import { gerarHashSenha } from "@/lib/security/password";

// CPFs com dígitos válidos, gerados para demonstração.
const CPF_GESTORA = "52998224725";
const CPF_MEDICO = "11144477735";
const CPF_CIDADA = "39053344705";

/** Encerra com uma mensagem fixa (nunca com valores vindos do ambiente). */
function parar(mensagem: string): never {
  console.error(mensagem);
  process.exit(1);
}

async function main(): Promise<void> {
  // No Railway o ambiente de teste roda com NODE_ENV=production; só CF_AMBIENTE=homologacao libera.
  const homologacao = process.env.CF_AMBIENTE === "homologacao";
  if (process.env.CF_AMBIENTE === "producao" || (process.env.NODE_ENV === "production" && !homologacao)) {
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
    const hash = await gerarHashSenha(senha);
    await db.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);

    async function pessoa(nome: string, cpf: string, papel: string, superAdmin = false): Promise<string> {
      const p = await db.query<{ id: string }>(
        `INSERT INTO app.pessoa (nome, cpf_cifrado, cpf_indice, email_cifrado) VALUES ($1, $2, $3, $4)
         ON CONFLICT (cpf_indice) DO UPDATE SET nome = EXCLUDED.nome RETURNING id`,
        [nome, cifrar(cpf, "pessoa.cpf"), indiceCego(cpf, "pessoa.cpf"), cifrar(`${papel}@exemplo.test`, "pessoa.email")],
      );
      const c = await db.query<{ id: string }>(
        `INSERT INTO app.conta (pessoa_id, senha_hash, super_admin) VALUES ($1, $2, $3)
         ON CONFLICT (pessoa_id) DO UPDATE SET senha_hash = EXCLUDED.senha_hash RETURNING id`,
        [p.rows[0]!.id, hash, superAdmin],
      );
      const v = await db.query<{ id: string }>(
        `INSERT INTO app.vinculo (tenant_id, conta_id, papel, estado) VALUES ($1, $2, $3, 'ativo')
         ON CONFLICT (tenant_id, conta_id, papel) DO UPDATE SET estado = 'ativo' RETURNING id`,
        [tenantId, c.rows[0]!.id, papel],
      );
      return v.rows[0]!.id;
    }

    await pessoa("Gestora Fictícia", CPF_GESTORA, "gestor", true);
    const medico = await pessoa("Médica Fictícia", CPF_MEDICO, "equipe");
    await pessoa("Cidadã Fictícia", CPF_CIDADA, "cidadao");

    const unidade = (await db.query<{ id: string }>("SELECT id FROM app.unidade WHERE tenant_id = $1 LIMIT 1", [tenantId])).rows[0]!.id;
    const prof = await db.query<{ id: string }>(
      `INSERT INTO app.profissional (tenant_id, vinculo_id, pessoa_id, nome_exibicao, especialidade)
       VALUES ($1, $2, '00000000-0000-0000-0000-000000000000', 'Dra. Fictícia Andrade', 'Clínica geral')
       ON CONFLICT (tenant_id, vinculo_id) DO UPDATE SET ativo = true RETURNING id`,
      [tenantId, medico],
    );
    // Segunda a sexta, 7h às 11h, consultas de 20 minutos. Rodando de novo (a cada publicação no
    // ambiente de teste), não duplica a escala: só estende as vagas até 3 semanas à frente.
    for (let dia = 1; dia <= 5; dia++) {
      const existente = await db.query<{ id: string }>(
        "SELECT id FROM app.escala WHERE tenant_id = $1 AND profissional_id = $2 AND dia_semana = $3 AND ativa LIMIT 1",
        [tenantId, prof.rows[0]!.id, dia],
      );
      const escalaId = existente.rows[0]?.id ?? (await db.query<{ id: string }>(
        `INSERT INTO app.escala (tenant_id, profissional_id, unidade_id, dia_semana, hora_inicio, hora_fim, duracao_min, vigencia_inicio)
         VALUES ($1, $2, $3, $4, '07:00', '11:00', 20, current_date) RETURNING id`,
        [tenantId, prof.rows[0]!.id, unidade, dia],
      )).rows[0]!.id;
      await db.query("SELECT * FROM app.vagas_gerar($1, current_date + 21)", [escalaId]);
    }
    await db.query("COMMIT");
    console.warn(`seed concluído: município 'demo'. Gestora ${CPF_GESTORA}, médica ${CPF_MEDICO}, cidadã ${CPF_CIDADA}`);
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
