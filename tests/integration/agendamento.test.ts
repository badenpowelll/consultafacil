import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encerrarPool, obterPool } from "@/lib/db/pool";
import { comMunicipio } from "@/lib/db/contexto";
import { criarSessao, definirMunicipio, validarSessao } from "@/lib/auth/sessao";
import { AcessoNegado } from "@/lib/auth/autorizar";
import {
  agendaDoDia, cadastrarProfissional, criarEscala, desmarcarMinha, desmarcarPelaUnidade, marcarParaCidadao, marcarParaMim,
  minhasConsultas, registrarAusencia, registrarSituacao, remarcarMinha, vagasParaCidadao, type Requisicao,
} from "@/lib/agendamento/servico";
import { admin, atribuirPerfil, criarMunicipio, criarPessoaEConta, criarUnidade, vincular } from "./ambiente";

/**
 * Fluxo de agendamento de ponta a ponta, sempre como o papel da aplicação.
 * Todos os nomes e pessoas são fictícios.
 */
const DIA_MS = 86_400_000;
function dataLocal(diasAFrente: number): string {
  // Datas no fuso padrão dos municípios (UTC-3, sem horário de verão).
  return new Date(Date.now() - 3 * 3_600_000 + diasAFrente * DIA_MS).toISOString().slice(0, 10);
}
const DIA_ALVO = dataLocal(3);
const DIA_SEMANA = new Date(`${DIA_ALVO}T12:00:00Z`).getUTCDay();

async function requisicao(contaId: string, tenantId: string, mfa = true): Promise<Requisicao> {
  const token = await criarSessao(contaId, mfa);
  await definirMunicipio(token, tenantId);
  return { sessao: await validarSessao(token), tenantDaUrl: tenantId, ip: "203.0.113.1" };
}

async function novoCidadao(tenantId: string): Promise<{ req: Requisicao; vinculoId: string; contaId: string }> {
  const { contaId } = await criarPessoaEConta();
  const vinculoId = await vincular(tenantId, contaId, "cidadao");
  return { req: await requisicao(contaId, tenantId), vinculoId, contaId };
}

let A: string;
let B: string;
let unidadeA: string;
let unidadeB: string;
let gestorA: Requisicao;
let gestorB: Requisicao;
let medicoContaId: string;
let profissionalA: string;
const periodo = { de: `${DIA_ALVO}T00:00:00-03:00`, ate: `${DIA_ALVO}T23:59:59-03:00` };

beforeAll(async () => {
  A = await criarMunicipio("Município Fictício Agenda A");
  B = await criarMunicipio("Município Fictício Agenda B");
  unidadeA = await criarUnidade(A, "UBS Fictícia Agenda A");
  unidadeB = await criarUnidade(B, "UBS Fictícia Agenda B");
  const gA = await criarPessoaEConta();
  await vincular(A, gA.contaId, "gestor");
  gestorA = await requisicao(gA.contaId, A);
  const gB = await criarPessoaEConta();
  await vincular(B, gB.contaId, "gestor");
  gestorB = await requisicao(gB.contaId, B);
  medicoContaId = (await criarPessoaEConta()).contaId;
});

afterAll(async () => {
  await encerrarPool();
  await admin.end();
});

describe("escala e vagas", () => {
  it("gestor cadastra o médico e a escala gera vagas nos dias e horários definidos", async () => {
    const vinculo = await vincular(A, medicoContaId, "equipe");
    profissionalA = await cadastrarProfissional(gestorA, {
      vinculoId: vinculo, nomeExibicao: "Dra. Fictícia Silva", especialidade: "Clínica geral", registro: "CRM-RN-12345",
    });
    const r = await criarEscala(gestorA, {
      profissionalId: profissionalA, unidadeId: unidadeA, diaSemana: DIA_SEMANA, horaInicio: "08:00", horaFim: "10:00",
      duracaoMin: 30, vigenciaInicio: dataLocal(0), gerarAte: dataLocal(10),
    });
    expect(r.criadas).toBe(8); // 4 vagas por dia, em 2 semanas
    expect(r.conflitos).toBe(0);
  });

  it("o mesmo médico não ganha vagas sobrepostas em outro município", async () => {
    const vinculo = await vincular(B, medicoContaId, "equipe");
    const profissionalB = await cadastrarProfissional(gestorB, { vinculoId: vinculo, nomeExibicao: "Dra. Fictícia Silva", especialidade: "Clínica geral" });
    const r = await criarEscala(gestorB, {
      profissionalId: profissionalB, unidadeId: unidadeB, diaSemana: DIA_SEMANA, horaInicio: "09:00", horaFim: "11:00",
      duracaoMin: 30, vigenciaInicio: dataLocal(0), gerarAte: dataLocal(4),
    });
    // 09:00-10:00 já está ocupado em A; 10:00-11:00 está livre.
    expect(r).toMatchObject({ criadas: 2, conflitos: 2 });
  });

  it("vagas aparecem no horário local do município", async () => {
    const { req } = await novoCidadao(A);
    const vagas = await vagasParaCidadao(req, periodo);
    expect(vagas).toHaveLength(4);
    expect(vagas[0]!.inicio.toISOString()).toBe(`${DIA_ALVO}T11:00:00.000Z`); // 08:00 em UTC-3
  });
});

describe("marcar e desmarcar", () => {
  it("a vaga só pode ser de uma pessoa; ao desmarcar, ela reabre para outra", async () => {
    const maria = await novoCidadao(A);
    const joao = await novoCidadao(A);
    const [vaga] = await vagasParaCidadao(maria.req, periodo);

    const consulta = await marcarParaMim(maria.req, vaga!.id);
    await expect(marcarParaMim(joao.req, vaga!.id)).rejects.toMatchObject({ codigo: "vaga_indisponivel" });
    expect((await vagasParaCidadao(joao.req, periodo)).map((v) => v.id)).not.toContain(vaga!.id);

    await desmarcarMinha(maria.req, consulta, "Não poderei ir");
    expect((await vagasParaCidadao(joao.req, periodo)).map((v) => v.id)).toContain(vaga!.id);
    await expect(marcarParaMim(joao.req, vaga!.id)).resolves.toBeTypeOf("string");

    const historico = await minhasConsultas(maria.req);
    expect(historico.find((c) => c.id === consulta)?.estado).toBe("cancelada_cidadao");
  });

  it("duas pessoas na mesma vaga ao mesmo tempo: só uma consegue", async () => {
    const pessoas = await Promise.all([novoCidadao(A), novoCidadao(A), novoCidadao(A)]);
    const vagas = await vagasParaCidadao(pessoas[0]!.req, periodo);
    const alvo = vagas[vagas.length - 1]!.id;
    const resultados = await Promise.allSettled(pessoas.map((p) => marcarParaMim(p.req, alvo)));
    expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("ninguém desmarca a consulta de outra pessoa", async () => {
    const dono = await novoCidadao(A);
    const intruso = await novoCidadao(A);
    const [vaga] = await vagasParaCidadao(dono.req, periodo);
    const consulta = await marcarParaMim(dono.req, vaga!.id);
    await expect(desmarcarMinha(intruso.req, consulta, "tentativa")).rejects.toMatchObject({ codigo: "nao_e_sua" });
    await desmarcarMinha(dono.req, consulta, "liberar para os outros testes");
  });

  it("desmarcar exige motivo", async () => {
    const c = await novoCidadao(A);
    await expect(desmarcarMinha(c.req, "00000000-0000-4000-8000-000000000000", "")).rejects.toMatchObject({ codigo: "dados_invalidos" });
  });

  it("o mesmo paciente não fica em dois atendimentos no mesmo horário, mesmo em municípios diferentes", async () => {
    const { contaId } = await criarPessoaEConta();
    const vA = await vincular(A, contaId, "cidadao");
    const vB = await vincular(B, contaId, "cidadao");
    // Outro médico em B atende às 08:30, o mesmo horário de uma vaga livre de A.
    const medicoB = await criarPessoaEConta();
    const profB = await cadastrarProfissional(gestorB, {
      vinculoId: await vincular(B, medicoB.contaId, "equipe"), nomeExibicao: "Dr. Fictício Souza", especialidade: "Pediatria",
    });
    await criarEscala(gestorB, {
      profissionalId: profB, unidadeId: unidadeB, diaSemana: DIA_SEMANA, horaInicio: "08:30", horaFim: "09:00",
      duracaoMin: 30, vigenciaInicio: DIA_ALVO, vigenciaFim: DIA_ALVO, gerarAte: DIA_ALVO,
    });
    const reqA = await requisicao(contaId, A);
    const reqB = await requisicao(contaId, B);
    const vagaA = (await vagasParaCidadao(reqA, periodo)).find((v) => v.inicio.toISOString().endsWith("T11:30:00.000Z"));
    const vagaB = (await vagasParaCidadao(reqB, periodo)).find((v) => v.inicio.toISOString().endsWith("T11:30:00.000Z"));
    expect(vagaA && vagaB).toBeTruthy();
    const consulta = await marcarParaMim(reqA, vagaA!.id);
    await expect(marcarParaMim(reqB, vagaB!.id)).rejects.toMatchObject({ codigo: "conflito_horario" });
    await desmarcarMinha(reqA, consulta, "liberar para os outros testes");
    expect(vA && vB).toBeTruthy();
  });

  it("limite de consultas futuras por cidadão", async () => {
    const c = await novoCidadao(A);
    const vagas = await vagasParaCidadao(c.req, { de: new Date(), ate: new Date(Date.now() + 30 * DIA_MS) });
    const livres = vagas.slice(0, 4);
    expect(livres.length).toBe(4);
    for (const v of livres.slice(0, 3)) await marcarParaMim(c.req, v.id);
    await expect(marcarParaMim(c.req, livres[3]!.id)).rejects.toMatchObject({ codigo: "limite_consultas" });
    for (const consulta of await minhasConsultas(c.req)) await desmarcarMinha(c.req, consulta.id, "liberar vagas");
  });
});

describe("equipe e recepção", () => {
  it("permissão vale só na unidade atribuída", async () => {
    const outraUnidade = await criarUnidade(A, "UBS Fictícia Outra");
    const { contaId } = await criarPessoaEConta();
    const vinculo = await vincular(A, contaId, "equipe");
    await atribuirPerfil(A, vinculo, ["agenda.marcar", "agenda.ver"], outraUnidade);
    const atendente = await requisicao(contaId, A);
    const cidadao = await novoCidadao(A);
    const [vaga] = await vagasParaCidadao(cidadao.req, periodo);
    await expect(marcarParaCidadao(atendente, vaga!.id, cidadao.vinculoId)).rejects.toThrow(AcessoNegado);
    await expect(agendaDoDia(atendente, unidadeA, DIA_ALVO)).rejects.toThrow(AcessoNegado);
  });

  it("recepção marca para o cidadão, faz check-in e fecha; saltos de estado são recusados", async () => {
    const { contaId } = await criarPessoaEConta();
    const vinculo = await vincular(A, contaId, "equipe");
    await atribuirPerfil(A, vinculo, ["agenda.marcar", "agenda.ver", "recepcao.checkin", "recepcao.fechar_agenda"], unidadeA);
    const recepcao = await requisicao(contaId, A);
    const cidadao = await novoCidadao(A);
    const [vaga] = await vagasParaCidadao(cidadao.req, periodo);

    const consulta = await marcarParaCidadao(recepcao, vaga!.id, cidadao.vinculoId);
    // Consulta daqui a 3 dias: ainda não dá para fazer check-in nem marcar falta.
    await expect(registrarSituacao(recepcao, consulta, "presente")).rejects.toMatchObject({ codigo: "fora_do_horario" });
    await expect(registrarSituacao(recepcao, consulta, "faltou")).rejects.toMatchObject({ codigo: "fora_do_horario" });
    // Simula o dia da consulta trazendo a vaga para daqui a 1 hora.
    await admin.query("UPDATE app.vaga SET periodo = tstzrange(now() + interval '1 hour', now() + interval '90 minutes') WHERE id = $1", [vaga!.id]);
    await expect(registrarSituacao(recepcao, consulta, "atendida")).rejects.toMatchObject({ codigo: "transicao_invalida" });
    await registrarSituacao(recepcao, consulta, "presente");
    await registrarSituacao(recepcao, consulta, "atendida");

    const diaDaVaga = new Date(Date.now() + 3_600_000 - 3 * 3_600_000).toISOString().slice(0, 10);
    const agenda = await agendaDoDia(recepcao, unidadeA, diaDaVaga);
    expect(agenda.find((i) => i.agendamento_id === consulta)?.estado_consulta).toBe("atendida");

    const eventos = await admin.query("SELECT estado_novo FROM app.agendamento_evento WHERE agendamento_id = $1 ORDER BY id", [consulta]);
    expect(eventos.rows.map((e) => e.estado_novo)).toEqual(["marcada", "presente", "atendida"]);
  });

  it("marcar para alguém que não é cidadão do município é recusado", async () => {
    const { contaId } = await criarPessoaEConta();
    const equipe = await vincular(A, contaId, "equipe");
    const cidadao = await novoCidadao(A);
    const [vaga] = await vagasParaCidadao(cidadao.req, periodo);
    await expect(marcarParaCidadao(gestorA, vaga!.id, equipe)).rejects.toMatchObject({ codigo: "sem_vinculo_cidadao" });
  });
});

describe("ausência do médico", () => {
  it("bloqueia vagas livres, mantém as consultas aguardando remanejamento e avisa por e-mail", async () => {
    const cidadao = await novoCidadao(A);
    const proximaSemana = { de: `${dataLocal(5)}T00:00:00-03:00`, ate: `${dataLocal(5)}T23:59:59-03:00` };
    await criarEscala(gestorA, {
      profissionalId: profissionalA, unidadeId: unidadeA, diaSemana: new Date(`${dataLocal(5)}T12:00:00Z`).getUTCDay(),
      horaInicio: "14:00", horaFim: "15:00", duracaoMin: 30, vigenciaInicio: dataLocal(5), vigenciaFim: dataLocal(5), gerarAte: dataLocal(5),
    });
    const vagasDia = await vagasParaCidadao(cidadao.req, proximaSemana);
    expect(vagasDia).toHaveLength(2);
    const consulta = await marcarParaMim(cidadao.req, vagasDia[0]!.id);

    const afetadas = await registrarAusencia(gestorA, {
      profissionalId: profissionalA, unidadeId: unidadeA, inicio: proximaSemana.de, fim: proximaSemana.ate, motivo: "Capacitação",
    });
    expect(afetadas).toBe(1);
    expect(await vagasParaCidadao(cidadao.req, proximaSemana)).toHaveLength(0);
    expect((await minhasConsultas(cidadao.req)).find((c) => c.id === consulta)?.estado).toBe("aguardando_remanejamento");

    const avisos = await admin.query(
      "SELECT modelo FROM app.notificacao WHERE dados ->> 'agendamento_id' = $1 ORDER BY criado_em",
      [consulta],
    );
    expect(avisos.rows.map((n) => n.modelo)).toEqual(["consulta_marcada", "profissional_ausente"]);

    // O paciente escolhe outro horário: a consulta antiga fica no histórico como remarcada.
    const [nova] = await vagasParaCidadao(cidadao.req, periodo);
    const novaConsulta = await remarcarMinha(cidadao.req, consulta, nova!.id);
    const minhas = await minhasConsultas(cidadao.req);
    expect(minhas.find((c) => c.id === consulta)?.estado).toBe("remarcada");
    expect(minhas.find((c) => c.id === novaConsulta)?.estado).toBe("marcada");
    await desmarcarMinha(cidadao.req, novaConsulta, "liberar");
  });
});

describe("garantias do banco", () => {
  it("consulta não é apagada e pessoa_id não é alterável pela aplicação", async () => {
    const c = await novoCidadao(A);
    const [vaga] = await vagasParaCidadao(c.req, periodo);
    const consulta = await marcarParaMim(c.req, vaga!.id);
    await expect(
      comMunicipio({ tenantId: A, contaId: null }, (tx) => tx.query("DELETE FROM app.agendamento WHERE id = $1", [consulta])),
    ).rejects.toThrow(/permission denied|somente inserção/);
    await expect(
      comMunicipio({ tenantId: A, contaId: null }, (tx) =>
        tx.query("UPDATE app.agendamento SET pessoa_id = gen_random_uuid() WHERE id = $1", [consulta]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      comMunicipio({ tenantId: A, contaId: null }, (tx) => tx.query("UPDATE app.agendamento_evento SET motivo = 'x'")),
    ).rejects.toThrow(/permission denied/);
    await desmarcarPelaUnidade(gestorA, consulta, "liberar");
  });

  it("outro município não vê vagas nem consultas de A", async () => {
    const r = await comMunicipio({ tenantId: B, contaId: null }, (tx) =>
      tx.query("SELECT count(*)::int AS n FROM app.vaga WHERE unidade_id = $1", [unidadeA]),
    );
    expect(r.rows[0].n).toBe(0);
    const direto = await obterPool().query("SELECT count(*)::int AS n FROM app.agendamento");
    expect(direto.rows[0].n).toBe(0);
  });
});
