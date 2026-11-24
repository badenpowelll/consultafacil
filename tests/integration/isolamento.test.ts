import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comConta, comMunicipio } from "@/lib/db/contexto";
import { encerrarPool, obterPool } from "@/lib/db/pool";
import { registrarAuditoria } from "@/lib/auditoria";
import { admin, criarMunicipio, criarPessoaEConta, criarUnidade, randomUUID, vincular } from "./ambiente";

/**
 * Isolamento entre municípios garantido pelo banco (RLS forçado), não pela aplicação.
 * Cada teste roda como cf_app e tenta exatamente o que um invasor tentaria.
 */
let municipioA: string;
let municipioB: string;
let unidadeA: string;
let unidadeB: string;
let gestorA: { pessoaId: string; contaId: string };

beforeAll(async () => {
  municipioA = await criarMunicipio("Município Fictício A");
  municipioB = await criarMunicipio("Município Fictício B");
  unidadeA = await criarUnidade(municipioA, "UBS Fictícia A");
  unidadeB = await criarUnidade(municipioB, "UBS Fictícia B");
  gestorA = await criarPessoaEConta();
  await vincular(municipioA, gestorA.contaId, "gestor");
});

afterAll(async () => {
  await encerrarPool();
  await admin.end();
});

describe("RLS forçado", () => {
  it("sem município no contexto, nada é lido", async () => {
    const r = await comConta(null, (tx) => tx.query("SELECT count(*)::int AS n FROM app.unidade"));
    expect(r.rows[0].n).toBe(0);
  });

  it("consulta direta fora de transação também não lê nada", async () => {
    const r = await obterPool().query("SELECT count(*)::int AS n FROM app.vinculo");
    expect(r.rows[0].n).toBe(0);
  });

  it("no município A, só aparecem unidades de A", async () => {
    const ids = await comMunicipio({ tenantId: municipioA, contaId: gestorA.contaId }, async (tx) => {
      const r = await tx.query<{ id: string }>("SELECT id FROM app.unidade");
      return r.rows.map((l) => l.id);
    });
    expect(ids).toContain(unidadeA);
    expect(ids).not.toContain(unidadeB);
  });

  it("não grava linha com tenant_id de outro município", async () => {
    await expect(
      comMunicipio({ tenantId: municipioA, contaId: gestorA.contaId }, (tx) =>
        tx.query("INSERT INTO app.unidade (tenant_id, nome) VALUES ($1, 'Unidade intrusa')", [municipioB]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("não altera nem apaga linhas de outro município (afeta zero linhas)", async () => {
    const n = await comMunicipio({ tenantId: municipioA, contaId: gestorA.contaId }, async (tx) => {
      const r = await tx.query("UPDATE app.unidade SET nome = 'invadida' WHERE id = $1", [unidadeB]);
      return r.rowCount;
    });
    expect(n).toBe(0);
    const nome = await admin.query("SELECT nome FROM app.unidade WHERE id = $1", [unidadeB]);
    expect(nome.rows[0].nome).toBe("UBS Fictícia B");
  });

  it("chave estrangeira composta impede apontar para unidade de outro município", async () => {
    await expect(
      comMunicipio({ tenantId: municipioA, contaId: gestorA.contaId }, async (tx) => {
        const v = await tx.query<{ id: string }>("SELECT id FROM app.vinculo LIMIT 1");
        const p = await tx.query<{ id: string }>(
          "INSERT INTO app.perfil_acesso (tenant_id, nome) VALUES ($1, $2) RETURNING id",
          [municipioA, `Perfil ${randomUUID().slice(0, 8)}`],
        );
        await tx.query(
          "INSERT INTO app.vinculo_perfil (tenant_id, vinculo_id, perfil_id, unidade_id) VALUES ($1, $2, $3, $4)",
          [municipioA, v.rows[0]!.id, p.rows[0]!.id, unidadeB],
        );
      }),
    ).rejects.toThrow(/foreign key/);
  });

  it("contexto com município inválido é recusado antes de ir ao banco", async () => {
    await expect(comMunicipio({ tenantId: "' OR true --", contaId: null }, async () => 1)).rejects.toThrow(/inválido/);
  });
});

describe("tabelas globais sensíveis", () => {
  it.each([
    "SELECT * FROM app.pessoa LIMIT 1",
    "SELECT * FROM app.conta LIMIT 1",
    "SELECT * FROM app.sessao LIMIT 1",
    "SELECT * FROM app.ocupacao_pessoa LIMIT 1",
    "SELECT * FROM app.limite_tentativa LIMIT 1",
  ])(
    "cf_app não lê tabela global diretamente: %s",
    async (sql) => {
      await expect(obterPool().query(sql)).rejects.toThrow(
        /permission denied/,
      );
    },
  );

  it("cf_app não cria tabelas nem funções no esquema app", async () => {
    await expect(obterPool().query("CREATE TABLE app.intrusa (x int)")).rejects.toThrow(/permission denied/);
  });
});

describe("auditoria imutável", () => {
  it("registra evento sem dado pessoal e recusa alteração e exclusão", async () => {
    await comMunicipio({ tenantId: municipioA, contaId: gestorA.contaId }, (tx) =>
      registrarAuditoria(tx, {
        acao: "teste.auditoria",
        modulo: "teste",
        detalhes: { cpf: "52998224725", unidade: "UBS Fictícia A" },
      }),
    );
    const r = await admin.query("SELECT detalhes FROM app.auditoria WHERE tenant_id = $1 AND acao = 'teste.auditoria'", [municipioA]);
    expect(r.rows[0].detalhes).toEqual({ unidade: "UBS Fictícia A" });

    await expect(
      comMunicipio({ tenantId: municipioA, contaId: gestorA.contaId }, (tx) => tx.query("UPDATE app.auditoria SET modulo = 'x'")),
    ).rejects.toThrow(/permission denied/);
    // Nem o superusuário consegue reescrever o histórico sem desligar os gatilhos.
    await expect(admin.query("DELETE FROM app.auditoria WHERE tenant_id = $1", [municipioA])).rejects.toThrow(/somente inserção/);
    await expect(admin.query("TRUNCATE app.auditoria")).rejects.toThrow(/somente inserção/);
  });
});

describe("ocupação global (mesma pessoa em dois municípios)", () => {
  it("bloqueia horário sobreposto em outro município sem revelar onde", async () => {
    const medico = await criarPessoaEConta();
    const reservar = (tenantId: string, inicio: string, fim: string) =>
      comMunicipio({ tenantId, contaId: null }, async (tx) => {
        const r = await tx.query<{ ok: boolean }>("SELECT app.ocupacao_reservar($1, tstzrange($2, $3), $4) AS ok", [
          medico.pessoaId,
          inicio,
          fim,
          randomUUID(),
        ]);
        return r.rows[0]!.ok;
      });

    expect(await reservar(municipioA, "2030-03-10 08:00-03", "2030-03-10 12:00-03")).toBe(true);
    expect(await reservar(municipioB, "2030-03-10 11:30-03", "2030-03-10 13:00-03")).toBe(false);
    expect(await reservar(municipioB, "2030-03-10 12:00-03", "2030-03-10 13:00-03")).toBe(true);
  });

  it("exige município no contexto", async () => {
    const p = await criarPessoaEConta();
    await expect(
      comConta(null, (tx) =>
        tx.query("SELECT app.ocupacao_reservar($1, tstzrange('2030-01-01','2030-01-02'), $2)", [p.pessoaId, randomUUID()]),
      ),
    ).rejects.toThrow(/Contexto de município ausente/);
  });
});

describe("provisionamento de municípios", () => {
  it("só o Super Admin provisiona", async () => {
    await expect(
      comConta(gestorA.contaId, (tx) => tx.query("SELECT app.municipio_provisionar('intruso', 'Intruso')")),
    ).rejects.toThrow(/Super Admin/);

    const sa = await criarPessoaEConta({ superAdmin: true });
    const slug = `novo-${randomUUID().slice(0, 8)}`;
    const id = await comConta(sa.contaId, async (tx) => {
      const r = await tx.query<{ id: string }>("SELECT app.municipio_provisionar($1, 'Município Novo') AS id", [slug]);
      return r.rows[0]!.id;
    });
    const t = await admin.query("SELECT estado FROM app.tenant WHERE id = $1", [id]);
    expect(t.rows[0].estado).toBe("provisionando");
  });

  it("cf_app não altera a tabela de municípios diretamente", async () => {
    await expect(obterPool().query("UPDATE app.tenant SET estado = 'ativo'")).rejects.toThrow(/permission denied/);
  });
});

