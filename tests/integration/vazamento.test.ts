import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comMunicipio } from "@/lib/db/contexto";
import { encerrarPool } from "@/lib/db/pool";
import { consumirLinkAcao, criarLinkAcao } from "@/lib/security/links";
import { gerarTokenOpaco, hashDoToken } from "@/lib/security/tokens";
import { exportar, ExportacaoGrandeDemais, LIMITE_LINHAS } from "@/lib/exportacao/exportar";
import { consumirLimite, LimiteExcedido, POLITICAS } from "@/lib/security/limites";
import { AcessoNegado } from "@/lib/auth/autorizar";
import type { SessaoValida } from "@/lib/auth/sessao";
import { admin, criarMunicipio, criarPessoaEConta, criarUnidade, randomUUID, vincular } from "./ambiente";

/**
 * Barreiras contra vazamento verificadas no banco, como cf_app.
 * Todos os dados são fictícios.
 */
let municipioA: string;
let municipioB: string;
let gestorA: { pessoaId: string; contaId: string };
let equipeA: { pessoaId: string; contaId: string };

beforeAll(async () => {
  municipioA = await criarMunicipio("Município Fictício Vazamento A");
  municipioB = await criarMunicipio("Município Fictício Vazamento B");
  await criarUnidade(municipioA, "UBS Fictícia Norte");
  await criarUnidade(municipioA, "UBS Fictícia Sul");
  await criarUnidade(municipioB, "UBS Fictícia de B");
  gestorA = await criarPessoaEConta();
  equipeA = await criarPessoaEConta();
  await vincular(municipioA, gestorA.contaId, "gestor");
  await vincular(municipioA, equipeA.contaId, "equipe");
});

afterAll(async () => {
  await encerrarPool();
  await admin.end();
});

const emA = <T>(fn: Parameters<typeof comMunicipio<T>>[1]) => comMunicipio({ tenantId: municipioA, contaId: null }, fn);
const emB = <T>(fn: Parameters<typeof comMunicipio<T>>[1]) => comMunicipio({ tenantId: municipioB, contaId: null }, fn);

describe("links de ação (credenciais ao portador)", () => {
  it("vale uma única vez", async () => {
    const objeto = randomUUID();
    const token = await emA((tx) => criarLinkAcao(tx, "cancelar", objeto));
    expect(await emA((tx) => consumirLinkAcao(tx, "cancelar", token))).toBe(objeto);
    expect(await emA((tx) => consumirLinkAcao(tx, "cancelar", token))).toBeNull();
  });

  it("não vale em outro município, para outra finalidade nem com token adulterado", async () => {
    const token = await emA((tx) => criarLinkAcao(tx, "confirmar", randomUUID()));
    expect(await emB((tx) => consumirLinkAcao(tx, "confirmar", token))).toBeNull();
    expect(await emA((tx) => consumirLinkAcao(tx, "recuperar_senha", token))).toBeNull();
    // Troca o último caractere por outro diferente (se já fosse "A", trocar por "A" não adulteraria nada).
    const outro = token.endsWith("A") ? "B" : "A";
    expect(await emA((tx) => consumirLinkAcao(tx, "confirmar", `${token.slice(0, -1)}${outro}`))).toBeNull();
    expect(await emA((tx) => consumirLinkAcao(tx, "confirmar", "curto"))).toBeNull();
    // Continua válido para o uso legítimo depois das tentativas.
    expect(await emA((tx) => consumirLinkAcao(tx, "confirmar", token))).not.toBeNull();
  });

  it("vencido não vale", async () => {
    // Link criado já vencido (pelo papel administrativo, só para montar o cenário).
    const token = gerarTokenOpaco();
    await admin.query(
      `INSERT INTO app.token_acao (tenant_id, finalidade, objeto_id, token_hash, criado_em, expira_em)
       VALUES ($1, 'checkin', $2, $3, now() - interval '2 hours', now() - interval '1 hour')`,
      [municipioA, randomUUID(), hashDoToken(token)],
    );
    expect(await emA((tx) => consumirLinkAcao(tx, "checkin", token))).toBeNull();
  });

  it("o banco recusa prazo acima do teto da finalidade", async () => {
    await expect(
      emA((tx) =>
        tx.query(
          `INSERT INTO app.token_acao (tenant_id, finalidade, objeto_id, token_hash, expira_em)
           VALUES (app.tenant_atual(), 'recuperar_senha', $1, $2, now() + interval '2 days')`,
          [randomUUID(), Buffer.from(randomUUID())],
        ),
      ),
    ).rejects.toThrow(/token_acao_prazo_maximo/);
  });

  it("a aplicação não estende prazo, não troca o objeto e não reabre link usado", async () => {
    const token = await emA((tx) => criarLinkAcao(tx, "convite", randomUUID()));
    await expect(emA((tx) => tx.query("UPDATE app.token_acao SET expira_em = now() + interval '1 day'"))).rejects.toThrow(
      /permission denied/,
    );
    await expect(emA((tx) => tx.query("UPDATE app.token_acao SET objeto_id = $1", [randomUUID()]))).rejects.toThrow(
      /permission denied/,
    );
    await emA((tx) => consumirLinkAcao(tx, "convite", token));
    await expect(
      emA((tx) => tx.query("UPDATE app.token_acao SET usado_em = NULL WHERE usado_em IS NOT NULL")),
    ).rejects.toThrow(/já utilizado/);
    await expect(emA((tx) => tx.query("DELETE FROM app.token_acao"))).rejects.toThrow(/permission denied/);
  });
});

describe("exportação", () => {
  const sessao = (contaId: string, mfa = true): SessaoValida => ({ contaId, tenantId: municipioA, mfaVerificado: mfa, superAdmin: false });
  const definicao = {
    relatorio: "unidades",
    colunas: [{ titulo: "Unidade", tipo: "texto" as const, valor: (l: { nome: string }) => l.nome }],
    consulta: async (tx: Parameters<typeof criarLinkAcao>[0], limite: number) =>
      (await tx.query<{ nome: string }>("SELECT nome FROM app.unidade ORDER BY nome LIMIT $1", [limite])).rows,
  };

  it("só exporta dados do próprio município e registra na auditoria", async () => {
    const arquivo = await exportar({ sessao: sessao(gestorA.contaId), tenantDaUrl: municipioA }, definicao);
    expect(arquivo.linhas).toBe(2);
    expect(arquivo.conteudo).toContain("UBS Fictícia Norte");
    expect(arquivo.conteudo).not.toContain("UBS Fictícia de B");
    expect(arquivo.conteudo).toContain(`Exportação ${arquivo.id}`);
    const aud = await admin.query(
      "SELECT conta_id, objeto_tipo, detalhes FROM app.auditoria WHERE acao = 'exportacao.gerar' AND objeto_id = $1",
      [arquivo.id],
    );
    expect(aud.rows).toHaveLength(1);
    expect(aud.rows[0].conta_id).toBe(gestorA.contaId);
    expect(aud.rows[0].detalhes.linhas).toBe(2);
  });

  it("exige permissão e MFA", async () => {
    await expect(exportar({ sessao: sessao(equipeA.contaId), tenantDaUrl: municipioA }, definicao)).rejects.toThrow(AcessoNegado);
    const semMfa = await criarPessoaEConta();
    await vincular(municipioA, semMfa.contaId, "gestor");
    await expect(exportar({ sessao: sessao(semMfa.contaId, false), tenantDaUrl: municipioA }, definicao)).rejects.toThrow(/sem_mfa/);
  });

  it("recusa exportação acima do teto em vez de cortar", async () => {
    const outro = await criarPessoaEConta();
    await vincular(municipioA, outro.contaId, "gestor");
    await expect(
      exportar(
        { sessao: sessao(outro.contaId), tenantDaUrl: municipioA },
        { ...definicao, consulta: async (_tx, limite) => Array.from({ length: limite }, (_, i) => ({ nome: `n${i}` })) },
      ),
    ).rejects.toThrow(ExportacaoGrandeDemais);
    expect(LIMITE_LINHAS).toBeGreaterThan(0);
  });

  it("limita o número de exportações por conta", async () => {
    const conta = await criarPessoaEConta();
    await vincular(municipioA, conta.contaId, "gestor");
    for (let i = 0; i < POLITICAS.exportacao.tentativas; i++) {
      await exportar({ sessao: sessao(conta.contaId), tenantDaUrl: municipioA }, definicao);
    }
    await expect(exportar({ sessao: sessao(conta.contaId), tenantDaUrl: municipioA }, definicao)).rejects.toThrow(LimiteExcedido);
  });
});

describe("limite de busca de cidadão (anti-enumeração interna)", () => {
  it("bloqueia depois do teto por conta, sem afetar outra conta", async () => {
    const conta = randomUUID();
    for (let i = 0; i < POLITICAS.buscaCidadao.tentativas; i++) {
      expect(await consumirLimite("buscaCidadao", conta)).toBe(true);
    }
    expect(await consumirLimite("buscaCidadao", conta)).toBe(false);
    expect(await consumirLimite("buscaCidadao", randomUUID())).toBe(true);
  });

  it("a chave do limite não guarda o identificador em claro", async () => {
    await consumirLimite("recuperarSenhaCpf", "52998224725");
    const r = await admin.query("SELECT count(*)::int AS n FROM app.limite_tentativa WHERE chave LIKE '%52998224725%'");
    expect(r.rows[0].n).toBe(0);
  });
});
