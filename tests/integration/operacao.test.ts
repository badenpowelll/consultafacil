import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encerrarPool, obterPool } from "@/lib/db/pool";
import { criarSessao, definirMunicipio, validarSessao } from "@/lib/auth/sessao";
import { cadastrarProfissional, criarEscala, marcarParaMim, vagasParaCidadao, type Requisicao } from "@/lib/agendamento/servico";
import { processarLote } from "@/lib/notificacoes/worker";
import { TransporteMemoria } from "@/lib/notificacoes/transporte";
import { cifrar } from "@/lib/security/crypto";
import { alterarEstado, bloquearConta, exportarMunicipio, OperacaoRecusada, situacaoDoMunicipio } from "@/lib/operacao/municipio";
import { admin, criarMunicipio, criarPessoaEConta, criarUnidade, vincular } from "./ambiente";

/**
 * Ciclo de vida do município (incremento 7): suspensão, reativação, exportação completa e
 * encerramento, ensaiados com dados fictícios e conferidos pelo papel da aplicação.
 */
async function requisicao(contaId: string, tenantId: string): Promise<{ req: Requisicao; token: string }> {
  const token = await criarSessao(contaId, true);
  await definirMunicipio(token, tenantId);
  return { token, req: { sessao: await validarSessao(token), tenantDaUrl: tenantId, ip: "203.0.113.70" } };
}

function dataLocal(dias: number): string {
  return new Date(Date.now() - 3 * 3_600_000 + dias * 86_400_000).toISOString().slice(0, 10);
}

let A: string;
let slugA: string;
let B: string;
let db: PoolClient;
let tokenCidadao: string;
let contaCidadao: string;

beforeAll(async () => {
  db = await admin.connect();
  A = await criarMunicipio("Município Fictício Operação A");
  B = await criarMunicipio("Município Fictício Operação B");
  slugA = (await admin.query<{ slug: string }>("SELECT slug FROM app.tenant WHERE id = $1", [A])).rows[0]!.slug;
  const unidade = await criarUnidade(A, "UBS Fictícia Operação");
  await criarUnidade(B, "UBS Fictícia Só do B");

  const g = await criarPessoaEConta();
  await vincular(A, g.contaId, "gestor");
  const gestor = (await requisicao(g.contaId, A)).req;
  const medico = await criarPessoaEConta();
  const profissionalId = await cadastrarProfissional(gestor, {
    vinculoId: await vincular(A, medico.contaId, "equipe"), nomeExibicao: "Dr. Fictício Operação", especialidade: "Clínica geral",
  });
  const dia = dataLocal(4);
  await criarEscala(gestor, {
    profissionalId, unidadeId: unidade, diaSemana: new Date(`${dia}T12:00:00Z`).getUTCDay(),
    horaInicio: "08:00", horaFim: "09:00", duracaoMin: 30, vigenciaInicio: dia, vigenciaFim: dia, gerarAte: dia,
  });

  const c = await criarPessoaEConta();
  contaCidadao = c.contaId;
  await admin.query("UPDATE app.pessoa SET email_cifrado = $2 WHERE id = $1", [c.pessoaId, cifrar("cidada.operacao@exemplo.test", "pessoa.email")]);
  await vincular(A, c.contaId, "cidadao");
  const cid = await requisicao(c.contaId, A);
  tokenCidadao = cid.token;
  const [vaga] = await vagasParaCidadao(cid.req, { de: `${dia}T00:00:00-03:00`, ate: `${dia}T23:59:59-03:00` });
  await marcarParaMim(cid.req, vaga!.id);
  // A fila de e-mails é global: tira do caminho o que outros arquivos de teste deixaram pendente.
  await admin.query("UPDATE app.notificacao SET estado = 'enviada' WHERE estado = 'pendente' AND tenant_id <> $1", [A]);
});

afterAll(async () => {
  db.release();
  await encerrarPool();
  await admin.end();
});

describe("contenção de incidente", () => {
  it("bloquear a conta derruba as sessões em todos os municípios e fica na auditoria de cada um", async () => {
    const c = await criarPessoaEConta();
    await vincular(A, c.contaId, "equipe");
    await vincular(B, c.contaId, "equipe");
    const emA = await requisicao(c.contaId, A);
    const emB = await requisicao(c.contaId, B);
    const r = await bloquearConta(db, { contaId: c.contaId, bloquear: true, operador: "operador.teste", motivo: "Incidente simulado" });
    expect(r).toEqual({ sessoesRevogadas: 2, municipios: 2 });
    expect(await validarSessao(emA.token)).toBeNull();
    expect(await validarSessao(emB.token)).toBeNull();
    expect(await validarSessao(await criarSessao(c.contaId, true))).toBeNull();
    const aud = await admin.query("SELECT count(*)::int AS n FROM app.auditoria WHERE objeto_id = $1 AND acao = 'conta.bloquear'", [c.contaId]);
    expect(aud.rows[0].n).toBe(2);

    await bloquearConta(db, { contaId: c.contaId, bloquear: false, operador: "operador.teste", motivo: "Senha trocada" });
    expect(await validarSessao(await criarSessao(c.contaId, true))).not.toBeNull();
    await expect(bloquearConta(db, { contaId: "x", bloquear: true, operador: "operador.teste", motivo: "Motivo válido" })).rejects.toBeInstanceOf(OperacaoRecusada);
  });
});

describe("ciclo de vida do município", () => {
  it("suspender revoga sessões, pausa os e-mails e mostra o aviso; reativar retoma", async () => {
    const antes = await situacaoDoMunicipio(db, slugA);
    expect(antes).toMatchObject({ estado: "ativo", consultasFuturas: 1, notificacoesPendentes: 1 });
    expect(antes.sessoesAtivas).toBeGreaterThanOrEqual(2);

    const r = await alterarEstado(db, { slug: slugA, para: "suspenso", operador: "operador.teste", motivo: "Ensaio de suspensão" });
    expect(r).toMatchObject({ de: "ativo", para: "suspenso" });
    expect(r.sessoesRevogadas).toBe(antes.sessoesAtivas);

    expect(await validarSessao(tokenCidadao)).toBeNull();
    const nova = await criarSessao(contaCidadao, false);
    expect(await definirMunicipio(nova, A)).toBe(false);
    expect((await processarLote(new TransporteMemoria())).enviadas).toBe(0);
    const aviso = await obterPool().query("SELECT nome, estado FROM app.municipio_situacao($1)", [slugA]);
    expect(aviso.rows[0]).toEqual({ nome: "Município Fictício Operação A", estado: "suspenso" });
    expect((await situacaoDoMunicipio(db, slugA)).notificacoesPendentes).toBe(1);

    await alterarEstado(db, { slug: slugA, para: "ativo", operador: "operador.teste", motivo: "Fim do ensaio" });
    const transporte = new TransporteMemoria();
    expect((await processarLote(transporte)).enviadas).toBe(1);
    expect(transporte.enviados[0]!.destino).toBe("cidada.operacao@exemplo.test");
    expect((await obterPool().query("SELECT 1 FROM app.municipio_situacao($1)", [slugA])).rowCount).toBe(0);

    const aud = await admin.query("SELECT detalhes FROM app.auditoria WHERE tenant_id = $1 AND acao = 'municipio.alterar_estado' ORDER BY id", [A]);
    expect(aud.rows.map((l) => l.detalhes.para)).toEqual(["suspenso", "ativo"]);
    expect(aud.rows[0].detalhes).toMatchObject({ operador: "operador.teste", motivo: "Ensaio de suspensão" });
  });

  it("recusa mudança fora da ordem, operador sem apelido e motivo vazio", async () => {
    await expect(alterarEstado(db, { slug: slugA, para: "encerrado", operador: "operador.teste", motivo: "Pular etapas" })).rejects.toBeInstanceOf(OperacaoRecusada);
    await expect(alterarEstado(db, { slug: slugA, para: "suspenso", operador: "fulano@exemplo.test", motivo: "Motivo válido" })).rejects.toBeInstanceOf(OperacaoRecusada);
    await expect(alterarEstado(db, { slug: slugA, para: "suspenso", operador: "operador.teste", motivo: " " })).rejects.toBeInstanceOf(OperacaoRecusada);
    await expect(alterarEstado(db, { slug: "nao-existe", para: "suspenso", operador: "operador.teste", motivo: "Motivo válido" })).rejects.toBeInstanceOf(OperacaoRecusada);
    expect((await situacaoDoMunicipio(db, slugA)).estado).toBe("ativo");
  });

  it("encerramento: exige a exportação completa, que sai só do município e confere pelo manifesto", async () => {
    await alterarEstado(db, { slug: slugA, para: "encerrando", operador: "operador.teste", motivo: "Ensaio de encerramento" });
    await expect(alterarEstado(db, { slug: slugA, para: "encerrado", operador: "operador.teste", motivo: "Sem exportar" }))
      .rejects.toThrow(/exportação completa/);

    const destino = path.join(await mkdtemp(path.join(tmpdir(), "cf-export-")), "municipio-a");
    const r = await exportarMunicipio(db, slugA, destino, "operador.teste");
    expect((await stat(destino)).mode & 0o777).toBe(0o700);
    const nomes = (await readdir(destino)).sort();
    expect(nomes).toEqual(expect.arrayContaining(["LEIA-ME.txt", "manifesto.sha256", "pessoas.csv", "agendamentos.csv", "unidades.csv", "auditoria.csv"]));

    // Manifesto confere com o conteúdo gravado.
    const manifesto = (await readFile(path.join(destino, "manifesto.sha256"), "utf8")).trim().split("\n");
    for (const linha of manifesto) {
      const [hash, nome] = linha.split("  ");
      expect(createHash("sha256").update(await readFile(path.join(destino, nome!))).digest("hex")).toBe(hash);
    }
    expect(r.arquivos.find((a) => a.nome === "agendamentos.csv")!.linhas).toBe(1);

    const unidades = await readFile(path.join(destino, "unidades.csv"), "utf8");
    expect(unidades).toContain("UBS Fictícia Operação");
    expect(unidades).not.toContain("Só do B");
    const pessoas = await readFile(path.join(destino, "pessoas.csv"), "utf8");
    expect(pessoas).toContain("cidada.operacao@exemplo.test");
    expect(pessoas).not.toMatch(/\\x[0-9a-f]{8}/);

    await expect(exportarMunicipio(db, slugA, destino, "operador.teste")).rejects.toThrow(/já existe/);

    const fim = await alterarEstado(db, { slug: slugA, para: "encerrado", operador: "operador.teste", motivo: "Exportação entregue" });
    expect(fim.para).toBe("encerrado");
    await expect(alterarEstado(db, { slug: slugA, para: "ativo", operador: "operador.teste", motivo: "Voltar" })).rejects.toBeInstanceOf(OperacaoRecusada);

    const aud = await admin.query("SELECT detalhes FROM app.auditoria WHERE tenant_id = $1 AND acao = 'municipio.exportar_completo'", [A]);
    expect(aud.rows[0].detalhes).toMatchObject({ exportacao: r.id, operador: "operador.teste" });
    expect(aud.rows[0].detalhes.manifesto).toMatch(/^[0-9a-f]{64}$/);
    // O município B segue intacto.
    expect((await admin.query("SELECT estado FROM app.tenant WHERE id = $1", [B])).rows[0].estado).toBe("ativo");
  });
});
