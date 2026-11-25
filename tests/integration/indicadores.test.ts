import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encerrarPool } from "@/lib/db/pool";
import { criarSessao, definirMunicipio, validarSessao } from "@/lib/auth/sessao";
import { AcessoNegado } from "@/lib/auth/autorizar";
import { cadastrarProfissional, criarEscala, desmarcarMinha, marcarParaMim, vagasParaCidadao, type Requisicao } from "@/lib/agendamento/servico";
import { entrarNaEspera } from "@/lib/agendamento/espera";
import { exportarConsultas, exportarIndicadores, FiltroInvalido, painelDoMunicipio } from "@/lib/gestao/indicadores";
import { admin, atribuirPerfil, criarMunicipio, criarPessoaEConta, criarUnidade, sufixo, vincular } from "./ambiente";

/**
 * Painel e exportação do gestor (incremento 6). Monta um período passado com consultas
 * atendidas, faltas, cancelamento e vagas ociosas, e confere os números e o escopo.
 */
async function requisicao(contaId: string, tenantId: string, mfa = true): Promise<Requisicao> {
  const token = await criarSessao(contaId, mfa);
  await definirMunicipio(token, tenantId);
  return { sessao: await validarSessao(token), tenantDaUrl: tenantId, ip: "203.0.113.60" };
}

function dataLocal(dias: number): string {
  return new Date(Date.now() - 3 * 3_600_000 + dias * 86_400_000).toISOString().slice(0, 10);
}

let A: string;
let B: string;
let u1: string;
let u2: string;
let gestor: Requisicao;
let gestorSemMfa: Requisicao;
let soU1: Requisicao;
let semPermissao: Requisicao;
let gestorB: Requisicao;
const ESPECIALIDADE = `Especialidade ${sufixo()}`;
const filtro = { de: dataLocal(-8), ate: dataLocal(-6) };

async function cidadao() {
  const { contaId } = await criarPessoaEConta();
  const vinculoId = await vincular(A, contaId, "cidadao");
  return { vinculoId, req: await requisicao(contaId, A, false) };
}

/** Leva as vagas do profissional 10 dias para trás e as marcações 20 dias, sem passar pelas regras. */
async function moverParaOPassado(profissionalId: string, estados: [string, string][]) {
  const c = await admin.connect();
  try {
    await c.query("SET session_replication_role = replica");
    await c.query(
      "UPDATE app.vaga SET periodo = tstzrange(lower(periodo) - interval '10 days', upper(periodo) - interval '10 days', '[)') WHERE profissional_id = $1",
      [profissionalId],
    );
    await c.query(
      "UPDATE app.agendamento a SET criado_em = a.criado_em - interval '20 days' FROM app.vaga v WHERE v.id = a.vaga_id AND v.profissional_id = $1",
      [profissionalId],
    );
    for (const [id, estado] of estados) await c.query("UPDATE app.agendamento SET estado = $2 WHERE id = $1", [id, estado]);
  } finally {
    await c.query("SET session_replication_role = origin");
    c.release();
  }
}

beforeAll(async () => {
  await admin.query("DELETE FROM app.limite_tentativa");
  A = await criarMunicipio("Município Fictício Painel A");
  B = await criarMunicipio("Município Fictício Painel B");
  u1 = await criarUnidade(A, "UBS Fictícia Painel Um");
  u2 = await criarUnidade(A, "UBS Fictícia Painel Dois");
  await criarUnidade(B, "UBS Fictícia Painel B");
  const g = await criarPessoaEConta();
  await vincular(A, g.contaId, "gestor");
  gestor = await requisicao(g.contaId, A);
  gestorSemMfa = await requisicao(g.contaId, A, false);
  const s = await criarPessoaEConta();
  await atribuirPerfil(A, await vincular(A, s.contaId, "equipe"), ["gestao.painel"], u1);
  soU1 = await requisicao(s.contaId, A);
  const n = await criarPessoaEConta();
  await vincular(A, n.contaId, "equipe");
  semPermissao = await requisicao(n.contaId, A);
  const gb = await criarPessoaEConta();
  await vincular(B, gb.contaId, "gestor");
  gestorB = await requisicao(gb.contaId, B);

  // Unidade 1: 5 vagas; unidade 2: 2 vagas. Mesmo profissional, horários diferentes.
  const medico = await criarPessoaEConta();
  const profissionalId = await cadastrarProfissional(gestor, {
    vinculoId: await vincular(A, medico.contaId, "equipe"), nomeExibicao: "Dra. Fictícia Painel", especialidade: ESPECIALIDADE,
  });
  const dia = dataLocal(3);
  const diaSemana = new Date(`${dia}T12:00:00Z`).getUTCDay();
  await criarEscala(gestor, { profissionalId, unidadeId: u1, diaSemana, horaInicio: "08:00", horaFim: "09:40", duracaoMin: 20, vigenciaInicio: dia, vigenciaFim: dia, gerarAte: dia });
  await criarEscala(gestor, { profissionalId, unidadeId: u2, diaSemana, horaInicio: "14:00", horaFim: "14:40", duracaoMin: 20, vigenciaInicio: dia, vigenciaFim: dia, gerarAte: dia });

  const pessoas = await Promise.all([cidadao(), cidadao(), cidadao(), cidadao()]);
  const vagas = (await vagasParaCidadao(pessoas[0]!.req, { de: `${dia}T00:00:00-03:00`, ate: `${dia}T12:00:00-03:00`, especialidade: ESPECIALIDADE }));
  expect(vagas).toHaveLength(5);
  const c = [];
  for (let i = 0; i < 4; i++) c.push(await marcarParaMim(pessoas[i]!.req, vagas[i]!.id));
  await desmarcarMinha(pessoas[3]!.req, c[3]!, "Não poderei comparecer");
  await moverParaOPassado(profissionalId, [[c[0]!, "atendida"], [c[1]!, "faltou"]]);

  // Demanda: uma pessoa aguardando na fila.
  await entrarNaEspera((await cidadao()).req, { especialidade: ESPECIALIDADE });
});

afterAll(async () => {
  await encerrarPool();
  await admin.end();
});

describe("painel do gestor", () => {
  it("calcula ocupação, faltas, ociosas, cancelamentos e espera", async () => {
    const p = await painelDoMunicipio(gestor, filtro);
    expect(p.totais).toMatchObject({ vagas: 7, ocupadas: 3, ociosas: 4, atendidas: 1, faltas: 1, canceladas_cidadao: 1, canceladas_unidade: 0 });
    expect(p.totais.ocupacao).toBeCloseTo(42.9, 1);
    expect(p.totais.absenteismo).toBe(50);
    expect(p.totais.espera_mediana_dias).toBeGreaterThan(5);
    expect(p.linhas.map((l) => l.unidade)).toEqual(["UBS Fictícia Painel Dois", "UBS Fictícia Painel Um"]);
    expect(p.demanda.find((d) => d.especialidade === ESPECIALIDADE)).toMatchObject({ aguardando: 1, com_prioridade: 0 });
  });

  it("quem tem a permissão só numa unidade vê só ela", async () => {
    const p = await painelDoMunicipio(soU1, filtro);
    expect(p.unidades.map((u) => u.id)).toEqual([u1]);
    expect(p.totais).toMatchObject({ vagas: 5, ocupadas: 3, ociosas: 2 });
    await expect(painelDoMunicipio(soU1, { ...filtro, unidadeId: u2 })).rejects.toBeInstanceOf(AcessoNegado);
    await expect(painelDoMunicipio(semPermissao, filtro)).rejects.toBeInstanceOf(AcessoNegado);
  });

  it("valida o período", async () => {
    await expect(painelDoMunicipio(gestor, { de: "2026-01-01", ate: "2027-06-01" })).rejects.toBeInstanceOf(FiltroInvalido);
    await expect(painelDoMunicipio(gestor, { de: "ontem", ate: "hoje" })).rejects.toBeInstanceOf(FiltroInvalido);
  });

  it("isolamento: o gestor de outro município não vê nada de A", async () => {
    const p = await painelDoMunicipio(gestorB, filtro);
    expect(p.totais.vagas).toBe(0);
    expect(p.demanda.some((d) => d.especialidade === ESPECIALIDADE)).toBe(false);
    await expect(painelDoMunicipio(gestorB, { ...filtro, unidadeId: u1 })).rejects.toBeInstanceOf(AcessoNegado);
  });
});

describe("exportação em CSV", () => {
  it("indicadores e consultas, sem dado pessoal, com auditoria; exige MFA e permissão", async () => {
    const ind = await exportarIndicadores(gestor, filtro);
    expect(ind.linhas).toBe(2);
    expect(ind.conteudo).toContain('"Ocupadas"');
    expect(ind.conteudo).toContain(ind.id);

    const cons = await exportarConsultas(gestor, filtro);
    expect(cons.linhas).toBe(4);
    expect(cons.conteudo).toContain("cancelada_cidadao");
    expect(cons.conteudo).toContain("cidadão");
    expect(cons.conteudo).not.toMatch(/Pessoa Fictícia|CPF|Paciente/);

    const aud = await admin.query("SELECT count(*)::int AS n FROM app.auditoria WHERE tenant_id = $1 AND acao = 'exportacao.gerar'", [A]);
    expect(aud.rows[0].n).toBe(2);

    await expect(exportarIndicadores(gestorSemMfa, filtro)).rejects.toMatchObject({ motivo: "sem_mfa" });
    await expect(exportarConsultas(soU1, filtro)).rejects.toBeInstanceOf(AcessoNegado);
  });
});
