import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encerrarPool } from "@/lib/db/pool";
import { comMunicipio } from "@/lib/db/contexto";
import { criarSessao, definirMunicipio, validarSessao } from "@/lib/auth/sessao";
import {
  cadastrarProfissional, criarEscala, emitirComprovante, marcarParaMim, validarComprovante, vagasParaCidadao, type Requisicao,
} from "@/lib/agendamento/servico";
import { codigoDoComprovante, gerarPdfComprovante, normalizarCodigo } from "@/lib/agendamento/comprovante";
import { ErroAgendamento } from "@/lib/agendamento/erros";
import { admin, criarMunicipio, criarPessoaEConta, criarUnidade, vincular } from "./ambiente";

/** Comprovante de agendamento: quem pode emitir, o que a validação pública mostra e o isolamento. Dados fictícios. */
const DIA_MS = 86_400_000;
function dataLocal(diasAFrente: number): string {
  return new Date(Date.now() - 3 * 3_600_000 + diasAFrente * DIA_MS).toISOString().slice(0, 10);
}
const DIA_ALVO = dataLocal(4);
const DIA_SEMANA = new Date(`${DIA_ALVO}T12:00:00Z`).getUTCDay();

async function requisicao(contaId: string, tenantId: string): Promise<Requisicao> {
  const token = await criarSessao(contaId, true);
  await definirMunicipio(token, tenantId);
  return { sessao: await validarSessao(token), tenantDaUrl: tenantId, ip: "203.0.113.9" };
}

let A: string;
let B: string;
let gestorA: Requisicao;
let gestorB: Requisicao;
let cidada: Requisicao;
let outroCidadao: Requisicao;
let nomeCidada: string;
let consulta: string;

beforeAll(async () => {
  A = await criarMunicipio("Município Fictício Comprovante A");
  B = await criarMunicipio("Município Fictício Comprovante B");
  const unidade = await criarUnidade(A, "UBS Fictícia Comprovante");
  const gA = await criarPessoaEConta();
  await vincular(A, gA.contaId, "gestor");
  gestorA = await requisicao(gA.contaId, A);
  const gB = await criarPessoaEConta();
  await vincular(B, gB.contaId, "gestor");
  gestorB = await requisicao(gB.contaId, B);

  const medico = await criarPessoaEConta();
  const vMedico = await vincular(A, medico.contaId, "equipe");
  const prof = await cadastrarProfissional(gestorA, { vinculoId: vMedico, nomeExibicao: "Dr. Fictício Souza", especialidade: "Pediatria" });
  await criarEscala(gestorA, {
    profissionalId: prof, unidadeId: unidade, diaSemana: DIA_SEMANA, horaInicio: "08:00", horaFim: "09:00",
    duracaoMin: 30, vigenciaInicio: dataLocal(0), gerarAte: dataLocal(6),
  });

  const c = await criarPessoaEConta();
  nomeCidada = (await admin.query<{ nome: string }>("SELECT nome FROM app.pessoa WHERE id = $1", [c.pessoaId])).rows[0]!.nome;
  await vincular(A, c.contaId, "cidadao");
  cidada = await requisicao(c.contaId, A);
  const o = await criarPessoaEConta();
  await vincular(A, o.contaId, "cidadao");
  outroCidadao = await requisicao(o.contaId, A);

  const vagas = await vagasParaCidadao(cidada, { de: `${DIA_ALVO}T00:00:00-03:00`, ate: `${DIA_ALVO}T23:59:59-03:00` });
  consulta = await marcarParaMim(cidada, vagas[0]!.id);
});

afterAll(async () => {
  await encerrarPool();
  await admin.end();
});

describe("comprovante de agendamento", () => {
  it("a cidadã emite o comprovante da própria consulta, com nome completo, e a segunda via sai com o mesmo código", async () => {
    const primeira = await emitirComprovante(cidada, consulta);
    expect(primeira.dados.paciente).toBe(nomeCidada);
    expect(primeira.dados.profissional).toBe("Dr. Fictício Souza");
    expect(primeira.dados.situacao).toBe("Agendado");
    expect(primeira.dados.codigo).toMatch(/^AGD-[0-9A-F]{8}(-[0-9A-F]{8}){3}$/);
    expect(primeira.dados.endereco).toContain(`/validar/${primeira.dados.codigo}`);
    const segunda = await emitirComprovante(cidada, consulta);
    expect(segunda.dados.codigo).toBe(primeira.dados.codigo);
    const n = await admin.query("SELECT 1 FROM app.comprovante WHERE agendamento_id = $1", [consulta]);
    expect(n.rowCount).toBe(1);
  });

  it("o banco guarda só o hash do código, e o código não contém o id da consulta", async () => {
    const codigo = codigoDoComprovante(consulta);
    expect(codigo.replace(/-/g, "").toLowerCase()).not.toContain(consulta.replace(/-/g, "").slice(0, 8));
    const r = await admin.query<{ h: Buffer }>("SELECT token_hash AS h FROM app.comprovante WHERE agendamento_id = $1", [consulta]);
    expect(r.rows[0]!.h.toString("utf8")).not.toContain(codigo);
  });

  it("gera um PDF válido sem dado pessoal nos metadados", async () => {
    const { dados } = await emitirComprovante(cidada, consulta);
    const pdf = Buffer.from(await gerarPdfComprovante(dados));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.toString("latin1")).not.toMatch(/\/Author \((?!\))/);
  });

  it("outro cidadão não emite o comprovante alheio; resposta igual à de consulta inexistente", async () => {
    await expect(emitirComprovante(outroCidadao, consulta)).rejects.toMatchObject({ codigo: "nao_e_sua" });
    await expect(emitirComprovante(outroCidadao, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ codigo: "nao_e_sua" });
  });

  it("a equipe da unidade emite para imprimir na recepção; o gestor de outro município não", async () => {
    const r = await emitirComprovante(gestorA, consulta);
    expect(r.dados.paciente).toBe(nomeCidada);
    await expect(emitirComprovante(gestorB, consulta)).rejects.toBeInstanceOf(ErroAgendamento);
  });

  it("a validação pública mostra só as iniciais e só no município de origem", async () => {
    const codigo = codigoDoComprovante(consulta);
    const v = await validarComprovante(A, codigo.toLowerCase().replace(/-/g, " "));
    expect(v).not.toBeNull();
    expect(v!.situacao).toBe("Agendado");
    expect(v!.iniciais).toMatch(/^P\. F\. [0-9A-F]\.$/);
    expect(JSON.stringify(v)).not.toContain(nomeCidada);
    expect(await validarComprovante(B, codigo)).toBeNull();
  });

  it("código adulterado, curto ou lixo não valida", async () => {
    const codigo = codigoDoComprovante(consulta);
    const ultimo = codigo.at(-1) === "0" ? "1" : "0";
    expect(await validarComprovante(A, codigo.slice(0, -1) + ultimo)).toBeNull();
    expect(await validarComprovante(A, "AGD-1234")).toBeNull();
    expect(await validarComprovante(A, "'; DROP TABLE app.comprovante; --")).toBeNull();
    expect(normalizarCodigo(123)).toBeNull();
  });

  it("comprovante é somente inserção e isolado por município", async () => {
    await expect(admin.query("UPDATE app.comprovante SET emitido_em = now() WHERE agendamento_id = $1", [consulta])).rejects.toThrow();
    await expect(admin.query("DELETE FROM app.comprovante WHERE agendamento_id = $1", [consulta])).rejects.toThrow();
    const visto = await comMunicipio({ tenantId: B, contaId: gestorB.sessao!.contaId }, (tx) =>
      tx.query("SELECT 1 FROM app.comprovante WHERE agendamento_id = $1", [consulta]),
    );
    expect(visto.rowCount).toBe(0);
  });

  it("a auditoria registra a emissão sem o nome do paciente", async () => {
    const a = await admin.query<{ d: string }>(
      "SELECT detalhes::text AS d FROM app.auditoria WHERE tenant_id = $1 AND acao = 'agenda.comprovante' AND objeto_id = $2",
      [A, consulta],
    );
    expect(a.rowCount).toBeGreaterThanOrEqual(3);
    for (const l of a.rows) expect(l.d).not.toContain(nomeCidada);
  });
});
