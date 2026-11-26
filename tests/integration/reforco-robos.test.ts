import { afterAll, describe, expect, it } from "vitest";
import { comConta } from "@/lib/db/contexto";
import { obterPool } from "@/lib/db/pool";
import { vigiarSeguranca } from "@/lib/seguranca/vigia";
import { admin, criarMunicipio, criarPessoaEConta, sufixo } from "./ambiente";

async function consumir(chave: string, limite: number, janela: number): Promise<boolean> {
  return comConta(null, async (tx) =>
    (await tx.query<{ ok: boolean }>("SELECT app.limite_consumir($1, $2, $3) AS ok", [chave, limite, janela])).rows[0]!.ok,
  );
}

async function estado(chave: string) {
  const r = await admin.query<{ nivel: number; duracao: number; contagem: number }>(
    "SELECT nivel, contagem, extract(epoch FROM bloqueado_ate - bloqueado_em)::integer AS duracao FROM app.limite_tentativa WHERE chave = $1",
    [chave],
  );
  return r.rows[0]!;
}

afterAll(async () => {
  await admin.end();
  await obterPool().end();
});

describe("bloqueio progressivo", () => {
  it("bloqueia ao estourar, não conta durante o bloqueio e dobra a cada novo estouro", async () => {
    const chave = `teste:progressivo:${sufixo()}`;
    expect(await consumir(chave, 2, 60)).toBe(true);
    expect(await consumir(chave, 2, 60)).toBe(true);
    expect(await consumir(chave, 2, 60)).toBe(false); // estourou
    expect(await estado(chave)).toMatchObject({ nivel: 1, duracao: 60 });

    // Durante o bloqueio, nem a tentativa certa passa, e insistir não muda nada.
    for (let i = 0; i < 5; i++) expect(await consumir(chave, 2, 60)).toBe(false);
    expect(await estado(chave)).toMatchObject({ nivel: 1, contagem: 0 });

    // Fim do bloqueio simulado: o próximo estouro dobra o tempo.
    await admin.query("UPDATE app.limite_tentativa SET bloqueado_ate = now() - interval '1 second' WHERE chave = $1", [chave]);
    expect(await consumir(chave, 2, 60)).toBe(true);
    expect(await consumir(chave, 2, 60)).toBe(true);
    expect(await consumir(chave, 2, 60)).toBe(false);
    expect(await estado(chave)).toMatchObject({ nivel: 2, duracao: 120 });
  });

  it("limita o bloqueio a 24 horas e zera o nível depois de 24 horas sem bloqueio", async () => {
    const chave = `teste:teto:${sufixo()}`;
    await consumir(chave, 1, 3600);
    await admin.query("UPDATE app.limite_tentativa SET nivel = 9, bloqueado_ate = now() - interval '1 second' WHERE chave = $1", [chave]);
    await consumir(chave, 1, 3600);
    expect(await consumir(chave, 1, 3600)).toBe(false);
    expect(await estado(chave)).toMatchObject({ nivel: 10, duracao: 24 * 3600 });

    await admin.query("UPDATE app.limite_tentativa SET bloqueado_ate = now() - interval '25 hours' WHERE chave = $1", [chave]);
    expect(await consumir(chave, 1, 3600)).toBe(true);
    expect(await consumir(chave, 1, 3600)).toBe(false);
    expect(await estado(chave)).toMatchObject({ nivel: 1, duracao: 3600 });
  });

  it("login certo limpa o histórico (limite_limpar)", async () => {
    const chave = `teste:limpar:${sufixo()}`;
    await consumir(chave, 1, 60);
    await consumir(chave, 1, 60);
    await comConta(null, (tx) => tx.query("SELECT app.limite_limpar($1)", [chave]));
    expect(await consumir(chave, 1, 60)).toBe(true);
  });
});

describe("vigia de volume anormal", () => {
  it("registra na auditoria do município, uma vez por hora por conta", async () => {
    const tenant = await criarMunicipio("Vigia");
    const { contaId } = await criarPessoaEConta();
    for (let i = 0; i < 45; i++) {
      await admin.query("INSERT INTO app.auditoria (tenant_id, conta_id, acao, modulo) VALUES ($1, $2, 'cidadao.buscar', 'cadastro')", [tenant, contaId]);
    }
    const r1 = await vigiarSeguranca(40);
    expect(r1.contasAnormais).toBeGreaterThanOrEqual(1);
    await vigiarSeguranca(40);
    const alertas = await admin.query<{ n: number; acoes: number }>(
      "SELECT count(*)::integer AS n, max((detalhes->>'acoes_10min')::integer) AS acoes FROM app.auditoria WHERE tenant_id = $1 AND objeto_id = $2::text AND acao = 'seguranca.volume_anormal'",
      [tenant, contaId],
    );
    expect(alertas.rows[0]).toMatchObject({ n: 1, acoes: 45 });
  });
});
