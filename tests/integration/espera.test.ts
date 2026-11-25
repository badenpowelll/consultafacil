import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encerrarPool } from "@/lib/db/pool";
import { comMunicipio } from "@/lib/db/contexto";
import { criarSessao, definirMunicipio, validarSessao } from "@/lib/auth/sessao";
import { AcessoNegado } from "@/lib/auth/autorizar";
import {
  cadastrarProfissional, confirmarMinha, confirmarPelaUnidade, criarEscala, desmarcarMinha, marcarParaCidadao, marcarParaMim,
  minhasConsultas, vagasParaCidadao, type Requisicao,
} from "@/lib/agendamento/servico";
import {
  aceitarOferta, aceitarOfertaPelaUnidade, contatosPendentes, definirPrioridade, entrarNaEspera, filaDeEspera, incluirNaEsperaPelaUnidade,
  minhaEspera, nomesNaEspera, recusarOferta, sairDaEspera,
} from "@/lib/agendamento/espera";
import { executarRotinas } from "@/lib/notificacoes/rotina";
import { processarLote } from "@/lib/notificacoes/worker";
import { TransporteMemoria, type Transporte } from "@/lib/notificacoes/transporte";
import { cifrar } from "@/lib/security/crypto";
import { admin, atribuirPerfil, criarMunicipio, criarPessoaEConta, criarUnidade, sufixo, vincular } from "./ambiente";

/**
 * Lista de espera, oferta exclusiva com prazo e avisos (incremento 5). Só dados fictícios.
 * Cada teste usa uma especialidade própria, para as filas não se misturarem.
 */
async function requisicao(contaId: string, tenantId: string): Promise<Requisicao> {
  const token = await criarSessao(contaId, true);
  await definirMunicipio(token, tenantId);
  return { sessao: await validarSessao(token), tenantDaUrl: tenantId, ip: "203.0.113.40" };
}

/** Data local (UTC-3) daqui a N dias. */
function dataLocal(dias: number): string {
  return new Date(Date.now() - 3 * 3_600_000 + dias * 86_400_000).toISOString().slice(0, 10);
}

let A: string;
let B: string;
let unidadeA: string;
let gestorA: Requisicao;
let recepcaoA: Requisicao;

async function cidadao(tenantId: string, email: string | null = null) {
  const { pessoaId, contaId } = await criarPessoaEConta();
  if (email) await admin.query("UPDATE app.pessoa SET email_cifrado = $2 WHERE id = $1", [pessoaId, cifrar(email, "pessoa.email")]);
  const vinculoId = await vincular(tenantId, contaId, "cidadao");
  return { pessoaId, contaId, vinculoId, req: await requisicao(contaId, tenantId) };
}

/** Profissional com uma especialidade só deste teste e N vagas de 20 minutos no dia. */
async function especialidadeComVagas(dias: number, vagas: number): Promise<{ especialidade: string; dia: string }> {
  const especialidade = `Especialidade ${sufixo()}`;
  const dia = dataLocal(dias);
  const medico = await criarPessoaEConta();
  const profissionalId = await cadastrarProfissional(gestorA, {
    vinculoId: await vincular(A, medico.contaId, "equipe"), nomeExibicao: "Dra. Fictícia Nunes", especialidade,
  });
  if (vagas === 0) return { especialidade, dia };
  const fim = 8 * 60 + 20 * vagas;
  await criarEscala(gestorA, {
    profissionalId, unidadeId: unidadeA, diaSemana: new Date(`${dia}T12:00:00Z`).getUTCDay(),
    horaInicio: "08:00", horaFim: `${String(Math.floor(fim / 60)).padStart(2, "0")}:${String(fim % 60).padStart(2, "0")}`,
    duracaoMin: 20, vigenciaInicio: dia, vigenciaFim: dia, gerarAte: dia,
  });
  return { especialidade, dia };
}

function periodo(dia: string) {
  return { de: `${dia}T00:00:00-03:00`, ate: `${dia}T23:59:59-03:00` };
}

/** Processa a fila (global entre municípios) e devolve o que saiu para este endereço. */
async function mensagensPara(destino: string, transporte = new TransporteMemoria()) {
  for (let i = 0; i < 5; i++) await processarLote(transporte, 100);
  return transporte.enviados.filter((e) => e.destino === destino).map((e) => e.mensagem);
}

/** Simula o relógio: põe o prazo da oferta no passado (sem passar pelas regras da aplicação). */
async function vencerOferta(ofertaId: string) {
  const c = await admin.connect();
  try {
    await c.query("SET session_replication_role = replica");
    await c.query("UPDATE app.oferta SET expira_em = now() - interval '1 minute' WHERE id = $1", [ofertaId]);
  } finally {
    await c.query("SET session_replication_role = origin");
    c.release();
  }
}

beforeAll(async () => {
  await admin.query("UPDATE app.notificacao SET estado = 'enviada' WHERE estado = 'pendente'");
  A = await criarMunicipio("Município Fictício Espera A");
  B = await criarMunicipio("Município Fictício Espera B");
  unidadeA = await criarUnidade(A, "UBS Fictícia Espera");
  const g = await criarPessoaEConta();
  await vincular(A, g.contaId, "gestor");
  gestorA = await requisicao(g.contaId, A);
  const r = await criarPessoaEConta();
  const vr = await vincular(A, r.contaId, "equipe");
  await atribuirPerfil(A, vr, ["agenda.ver", "agenda.marcar"], unidadeA);
  recepcaoA = await requisicao(r.contaId, A);
});

afterAll(async () => {
  await encerrarPool();
  await admin.end();
});

describe("lista de espera e oferta exclusiva", () => {
  it("a vaga desmarcada vai só para quem espera, que é avisado e aceita", async () => {
    const { especialidade, dia } = await especialidadeComVagas(6, 1);
    const ocupante = await cidadao(A);
    const espera = await cidadao(A, "espera.ficticia@exemplo.test");
    const terceiro = await cidadao(A);
    const [vaga] = await vagasParaCidadao(ocupante.req, { ...periodo(dia), especialidade });
    const consulta = await marcarParaMim(ocupante.req, vaga!.id);

    await entrarNaEspera(espera.req, { especialidade, turno: "manha" });
    expect((await minhaEspera(espera.req)).ofertas).toHaveLength(0);

    await desmarcarMinha(ocupante.req, consulta, "Não poderei comparecer");
    const { ofertas } = await minhaEspera(espera.req);
    expect(ofertas).toHaveLength(1);
    expect(ofertas[0]!.especialidade).toBe(especialidade);

    // Para os outros, a vaga não aparece e não pode ser marcada (nem pela recepção).
    expect(await vagasParaCidadao(terceiro.req, { ...periodo(dia), especialidade })).toHaveLength(0);
    await expect(marcarParaMim(terceiro.req, vaga!.id)).rejects.toMatchObject({ codigo: "vaga_indisponivel" });
    await expect(marcarParaCidadao(recepcaoA, vaga!.id, terceiro.vinculoId)).rejects.toMatchObject({ codigo: "vaga_indisponivel" });

    const [aviso] = await mensagensPara("espera.ficticia@exemplo.test");
    expect(aviso!.assunto).toContain("Vaga disponível");
    expect(aviso!.texto).toContain("/lista-de-espera");
    expect(aviso!.texto).not.toMatch(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/);

    const nova = await aceitarOferta(espera.req, ofertas[0]!.id);
    expect((await minhasConsultas(espera.req)).find((c) => c.id === nova)?.estado).toBe("marcada");
    const depois = await minhaEspera(espera.req);
    expect(depois.ofertas).toHaveLength(0);
    expect(depois.pedidos[0]!.estado).toBe("atendida");
    await expect(aceitarOferta(espera.req, ofertas[0]!.id)).rejects.toMatchObject({ codigo: "oferta_encerrada" });
  });

  it("prioridade marcada pela equipe passa na frente; o cidadão não marca prioridade", async () => {
    const { especialidade, dia } = await especialidadeComVagas(7, 1);
    const ocupante = await cidadao(A);
    const primeiro = await cidadao(A);
    const idosa = await cidadao(A);
    const [vaga] = await vagasParaCidadao(ocupante.req, { ...periodo(dia), especialidade });
    const consulta = await marcarParaMim(ocupante.req, vaga!.id);

    const p1 = await entrarNaEspera(primeiro.req, { especialidade });
    await expect(entrarNaEspera(primeiro.req, { especialidade })).rejects.toMatchObject({ codigo: "ja_na_espera" });
    const p2 = await entrarNaEspera(idosa.req, { especialidade });
    await expect(
      comMunicipio({ tenantId: A, contaId: idosa.contaId }, (tx) => tx.query("UPDATE app.espera SET prioridade = 'idoso' WHERE id = $1", [p2])),
    ).rejects.toThrow(/sem_permissao/);
    await expect(definirPrioridade(idosa.req, p2, "idoso")).rejects.toBeInstanceOf(AcessoNegado);
    await definirPrioridade(recepcaoA, p2, "idoso");

    const fila = (await filaDeEspera(recepcaoA, especialidade)).map((f) => f.id);
    expect(fila).toEqual([p2, p1]);
    const nomes = await nomesNaEspera(recepcaoA, fila);
    expect(nomes.size).toBe(2);

    await desmarcarMinha(ocupante.req, consulta, "Não poderei comparecer");
    expect((await minhaEspera(idosa.req)).ofertas).toHaveLength(1);
    expect((await minhaEspera(primeiro.req)).ofertas).toHaveLength(0);
  });

  it("recusa passa para o próximo e não volta para quem recusou", async () => {
    const { especialidade, dia } = await especialidadeComVagas(8, 1);
    const ocupante = await cidadao(A);
    const um = await cidadao(A);
    const dois = await cidadao(A);
    const [vaga] = await vagasParaCidadao(ocupante.req, { ...periodo(dia), especialidade });
    const consulta = await marcarParaMim(ocupante.req, vaga!.id);
    await entrarNaEspera(um.req, { especialidade });
    await entrarNaEspera(dois.req, { especialidade });
    await desmarcarMinha(ocupante.req, consulta, "Não poderei comparecer");

    const [oferta] = (await minhaEspera(um.req)).ofertas;
    await expect(recusarOferta(dois.req, oferta!.id)).rejects.toMatchObject({ codigo: "oferta_encerrada" });
    await recusarOferta(um.req, oferta!.id);
    expect((await minhaEspera(dois.req)).ofertas).toHaveLength(1);
    await executarRotinas();
    expect((await minhaEspera(um.req)).ofertas).toHaveLength(0);
    expect((await minhaEspera(um.req)).pedidos[0]!.estado).toBe("aguardando");
  });

  it("oferta vencida já conta como vaga livre, sem rotina; a rotina oferece ao próximo", async () => {
    const { especialidade, dia } = await especialidadeComVagas(9, 1);
    const ocupante = await cidadao(A);
    const um = await cidadao(A);
    const dois = await cidadao(A);
    const [vaga] = await vagasParaCidadao(ocupante.req, { ...periodo(dia), especialidade });
    const consulta = await marcarParaMim(ocupante.req, vaga!.id);
    await entrarNaEspera(um.req, { especialidade });
    await entrarNaEspera(dois.req, { especialidade });
    await desmarcarMinha(ocupante.req, consulta, "Não poderei comparecer");
    const [oferta] = (await minhaEspera(um.req)).ofertas;
    await vencerOferta(oferta!.id);

    // Sem nenhuma rotina: some da lista de quem recebeu e aparece para quem procura.
    expect((await minhaEspera(um.req)).ofertas).toHaveLength(0);
    expect(await vagasParaCidadao(ocupante.req, { ...periodo(dia), especialidade })).toHaveLength(1);
    await expect(aceitarOferta(um.req, oferta!.id)).rejects.toMatchObject({ codigo: "oferta_encerrada" });

    await executarRotinas();
    expect((await minhaEspera(dois.req)).ofertas).toHaveLength(1);
    const estado = await admin.query("SELECT estado FROM app.oferta WHERE id = $1", [oferta!.id]);
    expect(estado.rows[0].estado).toBe("vencida");
  });

  it("vagas de escala nova vão primeiro para a fila; marcar por outro caminho tira da lista", async () => {
    const especialidade = `Especialidade ${sufixo()}`;
    const medico = await criarPessoaEConta();
    const profissionalId = await cadastrarProfissional(gestorA, {
      vinculoId: await vincular(A, medico.contaId, "equipe"), nomeExibicao: "Dr. Fictício Prado", especialidade,
    });
    const pessoa = await cidadao(A);
    const outra = await cidadao(A);
    await entrarNaEspera(pessoa.req, { especialidade });
    await entrarNaEspera(outra.req, { especialidade, turno: "tarde" });
    const dia = dataLocal(10);
    await criarEscala(gestorA, {
      profissionalId, unidadeId: unidadeA, diaSemana: new Date(`${dia}T12:00:00Z`).getUTCDay(),
      horaInicio: "08:00", horaFim: "09:00", duracaoMin: 20, vigenciaInicio: dia, vigenciaFim: dia, gerarAte: dia,
    });
    const { ofertas } = await minhaEspera(pessoa.req);
    expect(ofertas).toHaveLength(1);
    // Só manhã: quem pediu tarde não recebe.
    expect((await minhaEspera(outra.req)).ofertas).toHaveLength(0);

    // Marcou outra vaga da mesma especialidade: sai da lista e a vaga oferecida volta.
    const livres = await vagasParaCidadao(pessoa.req, { ...periodo(dia), especialidade });
    await marcarParaMim(pessoa.req, livres[0]!.id);
    const depois = await minhaEspera(pessoa.req);
    expect(depois.ofertas).toHaveLength(0);
    expect(depois.pedidos[0]!.estado).toBe("atendida");
    expect(await vagasParaCidadao(outra.req, { ...periodo(dia), especialidade })).toHaveLength(2);
  });

  it("a recepção inclui com prioridade e aceita por telefone; o cidadão só mexe no que é dele", async () => {
    const { especialidade, dia } = await especialidadeComVagas(11, 1);
    const ocupante = await cidadao(A);
    const pessoa = await cidadao(A);
    const intruso = await cidadao(A);
    const [vaga] = await vagasParaCidadao(ocupante.req, { ...periodo(dia), especialidade });
    const consulta = await marcarParaMim(ocupante.req, vaga!.id);

    const id = await incluirNaEsperaPelaUnidade(recepcaoA, pessoa.vinculoId, { especialidade, prioridade: "gestante" });
    await expect(sairDaEspera(intruso.req, id)).rejects.toMatchObject({ codigo: "espera_encerrada" });
    await expect(
      comMunicipio({ tenantId: A, contaId: intruso.contaId }, (tx) =>
        tx.query(
          `INSERT INTO app.espera (tenant_id, cidadao_vinculo_id, pessoa_id, especialidade)
           VALUES ($1, $2, '00000000-0000-0000-0000-000000000000', $3)`,
          [A, pessoa.vinculoId, especialidade],
        ),
      ),
    ).rejects.toThrow(/sem_permissao/);
    await expect(incluirNaEsperaPelaUnidade(intruso.req, pessoa.vinculoId, { especialidade: "Outra" })).rejects.toBeInstanceOf(AcessoNegado);

    await desmarcarMinha(ocupante.req, consulta, "Não poderei comparecer");
    const [oferta] = (await minhaEspera(pessoa.req)).ofertas;
    await expect(recusarOferta(intruso.req, oferta!.id)).rejects.toMatchObject({ codigo: "oferta_encerrada" });
    const nova = await aceitarOfertaPelaUnidade(recepcaoA, oferta!.id);
    expect((await minhasConsultas(pessoa.req)).map((c) => c.id)).toContain(nova);
  });

  it("valida o pedido e limita a três listas por pessoa", async () => {
    const pessoa = await cidadao(A);
    await expect(entrarNaEspera(pessoa.req, { especialidade: "Inexistente Fictícia" })).rejects.toMatchObject({ codigo: "especialidade_inexistente" });
    await expect(entrarNaEspera(pessoa.req, { especialidade: "x", turno: "madrugada" })).rejects.toMatchObject({ codigo: "dados_invalidos" });
    for (let i = 0; i < 3; i++) await entrarNaEspera(pessoa.req, { especialidade: (await especialidadeComVagas(12, 0)).especialidade });
    const quarta = (await especialidadeComVagas(12, 0)).especialidade;
    await expect(entrarNaEspera(pessoa.req, { especialidade: quarta })).rejects.toMatchObject({ codigo: "limite_espera" });
  });

  it("prazo da oferta conta só das 7h às 20h e termina 2 horas antes da consulta", async () => {
    const r = await admin.query<{ a: Date; b: Date; c: Date; d: Date | null }>(
      `SELECT app.prazo_oferta('2026-12-01 19:30-03', 'America/Fortaleza', '2026-12-10 08:00-03') AS a,
              app.prazo_oferta('2026-12-01 03:00-03', 'America/Fortaleza', '2026-12-10 08:00-03') AS b,
              app.prazo_oferta('2026-12-01 10:00-03', 'America/Fortaleza', '2026-12-01 13:00-03') AS c,
              app.prazo_oferta('2026-12-01 10:00-03', 'America/Fortaleza', '2026-12-01 12:10-03') AS d`,
    );
    expect(r.rows[0]!.a.toISOString()).toBe("2026-12-02T11:30:00.000Z"); // 8h30 do dia seguinte
    expect(r.rows[0]!.b.toISOString()).toBe("2026-12-01T12:00:00.000Z"); // 9h
    expect(r.rows[0]!.c.toISOString()).toBe("2026-12-01T14:00:00.000Z"); // 11h (2h antes das 13h)
    expect(r.rows[0]!.d).toBeNull();
  });

  it("isolamento: a lista e as ofertas de um município não aparecem em outro", async () => {
    const { especialidade } = await especialidadeComVagas(13, 0);
    const pessoa = await cidadao(A);
    const id = await entrarNaEspera(pessoa.req, { especialidade });
    await comMunicipio({ tenantId: B, contaId: null }, async (tx) => {
      expect((await tx.query("SELECT count(*)::int AS n FROM app.espera WHERE id = $1", [id])).rows[0].n).toBe(0);
      expect((await tx.query("SELECT count(*)::int AS n FROM app.oferta WHERE tenant_id = $1", [A])).rows[0].n).toBe(0);
      expect((await tx.query("SELECT count(*)::int AS n FROM app.nomes_da_espera($1)", [[id]])).rows[0].n).toBe(0);
      const n = await tx.query("UPDATE app.espera SET estado = 'cancelada' WHERE id = $1", [id]);
      expect(n.rowCount).toBe(0);
    });
    await comMunicipio({ tenantId: A, contaId: null }, async (tx) => {
      // A aplicação não apaga pedidos nem ofertas: o histórico fica.
      await expect(tx.query("DELETE FROM app.espera WHERE id = $1", [id])).rejects.toThrow();
    });
  });
});

describe("avisos, lembrete e recepção", () => {
  it("lembrete da véspera sai uma vez; o cidadão confirma pelo sistema", async () => {
    const { especialidade, dia } = await especialidadeComVagas(3, 1);
    const pessoa = await cidadao(A, "lembrete.ficticio@exemplo.test");
    const [vaga] = await vagasParaCidadao(pessoa.req, { ...periodo(dia), especialidade });
    const consulta = await marcarParaMim(pessoa.req, vaga!.id);
    await mensagensPara("lembrete.ficticio@exemplo.test");

    const vespera = `${dataLocal(2)}T10:00:00-03:00`;
    const gerar = () => comMunicipio({ tenantId: A, contaId: null }, (tx) => tx.query("SELECT app.lembretes_gerar($1)", [vespera]));
    await gerar();
    await gerar();
    const n = await admin.query("SELECT count(*)::int AS n FROM app.notificacao WHERE modelo = 'lembrete_vespera' AND dados ->> 'agendamento_id' = $1", [consulta]);
    expect(n.rows[0].n).toBe(1);
    // Fora do horário (22h), não gera.
    const noite = await comMunicipio({ tenantId: A, contaId: null }, (tx) =>
      tx.query<{ n: number }>("SELECT app.lembretes_gerar($1) AS n", [`${dataLocal(2)}T22:00:00-03:00`]),
    );
    expect(noite.rows[0]!.n).toBe(0);

    const [lembrete] = await mensagensPara("lembrete.ficticio@exemplo.test");
    expect(lembrete!.assunto).toContain("Lembrete");
    expect(lembrete!.texto).toContain("continua marcada");

    await confirmarMinha(pessoa.req, consulta);
    expect((await minhasConsultas(pessoa.req)).find((c) => c.id === consulta)?.estado).toBe("confirmada");
    await expect(confirmarMinha(pessoa.req, consulta)).rejects.toMatchObject({ codigo: "ja_confirmada" });
  });

  it("lembrete de consulta desmarcada é descartado, não enviado", async () => {
    const { especialidade, dia } = await especialidadeComVagas(3, 1);
    const pessoa = await cidadao(A, "descartado.ficticio@exemplo.test");
    const [vaga] = await vagasParaCidadao(pessoa.req, { ...periodo(dia), especialidade });
    const consulta = await marcarParaMim(pessoa.req, vaga!.id);
    await comMunicipio({ tenantId: A, contaId: null }, (tx) => tx.query("SELECT app.lembretes_gerar($1)", [`${dataLocal(2)}T10:00:00-03:00`]));
    await desmarcarMinha(pessoa.req, consulta, "Não poderei comparecer");
    const enviados = await mensagensPara("descartado.ficticio@exemplo.test");
    expect(enviados.some((m) => m.assunto.includes("Lembrete"))).toBe(false);
    const e = await admin.query("SELECT estado FROM app.notificacao WHERE modelo = 'lembrete_vespera' AND dados ->> 'agendamento_id' = $1", [consulta]);
    expect(e.rows[0].estado).toBe("descartada");
  });

  it("envio repetido depois de falha não chega duas vezes (chave de idempotência)", async () => {
    const { especialidade, dia } = await especialidadeComVagas(4, 1);
    const pessoa = await cidadao(A, "repetido.ficticio@exemplo.test");
    const [vaga] = await vagasParaCidadao(pessoa.req, { ...periodo(dia), especialidade });
    await marcarParaMim(pessoa.req, vaga!.id);

    // O provedor recebeu, mas a resposta se perdeu: o worker acha que falhou e tenta de novo.
    const memoria = new TransporteMemoria();
    let primeira = true;
    const instavel: Transporte = {
      async enviar(destino, mensagem, chave) {
        await memoria.enviar(destino, mensagem, chave);
        if (primeira && destino === "repetido.ficticio@exemplo.test") {
          primeira = false;
          throw new Error("conexão caiu");
        }
      },
    };
    await processarLote(instavel, 100);
    await admin.query("UPDATE app.notificacao SET proxima_em = now() WHERE estado = 'pendente'");
    await processarLote(instavel, 100);
    expect(memoria.enviados.filter((e) => e.destino === "repetido.ficticio@exemplo.test")).toHaveLength(1);
    expect(memoria.enviados.every((e) => typeof e.chave === "string")).toBe(true);
  });

  it("a recepção vê quem não confirmou e quem ficou sem aviso; nada é desmarcado por silêncio", async () => {
    const { especialidade, dia } = await especialidadeComVagas(1, 2);
    const semEmail = await cidadao(A);
    const comEmail = await cidadao(A, "confirmou.ficticio@exemplo.test");
    const vagas = await vagasParaCidadao(semEmail.req, { ...periodo(dia), especialidade });
    const c1 = await marcarParaMim(semEmail.req, vagas[0]!.id);
    const c2 = await marcarParaMim(comEmail.req, vagas[1]!.id);
    await mensagensPara("confirmou.ficticio@exemplo.test");

    const { consultas } = await contatosPendentes(recepcaoA, unidadeA);
    expect(consultas.find((c) => c.agendamento_id === c1)).toMatchObject({ motivo: "sem_confirmacao", aviso: "sem_contato" });
    expect(consultas.find((c) => c.agendamento_id === c2)).toMatchObject({ motivo: "sem_confirmacao", aviso: null });

    await confirmarPelaUnidade(recepcaoA, c1);
    const depois = await contatosPendentes(recepcaoA, unidadeA);
    expect(depois.consultas.some((c) => c.agendamento_id === c1)).toBe(false);
    // Quem não respondeu continua com a consulta.
    expect((await minhasConsultas(comEmail.req)).find((c) => c.id === c2)?.estado).toBe("marcada");

    await expect(contatosPendentes(semEmail.req, unidadeA)).rejects.toBeInstanceOf(AcessoNegado);
  });
});
