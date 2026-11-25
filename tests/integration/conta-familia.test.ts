import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encerrarPool } from "@/lib/db/pool";
import { comMunicipio } from "@/lib/db/contexto";
import { criarSessao, definirMunicipio, validarSessao } from "@/lib/auth/sessao";
import { AcessoNegado } from "@/lib/auth/autorizar";
import { entrar } from "@/lib/auth/login";
import { gerarAcessoAssistido, pedirRecuperacao, redefinirSenha } from "@/lib/auth/recuperacao";
import {
  cadastrarProfissional, criarEscala, emitirComprovante, marcarParaCidadao, marcarParaMim, minhasConsultas, vagasParaCidadao, type Requisicao,
} from "@/lib/agendamento/servico";
import { cadastrarCidadao } from "@/lib/cidadao/cadastro";
import {
  decidirDependente, dependentesDoCidadao, dependentesParaConferir, encerrarDependente, incluirDependenteAssistido, meusDependentes, pedirDependente,
} from "@/lib/cidadao/familia";
import { buscarCidadaos, cadastrarAssistido, VERSAO_TERMOS } from "@/lib/cidadao/recepcao";
import { processarLote } from "@/lib/notificacoes/worker";
import { TransporteMemoria } from "@/lib/notificacoes/transporte";
import { cifrar, decifrar, indiceCego } from "@/lib/security/crypto";
import { gerarHashSenha } from "@/lib/security/password";
import { admin, atribuirPerfil, criarMunicipio, criarPessoaEConta, criarUnidade, vincular } from "./ambiente";

/**
 * Recuperação de acesso, dependentes e cadastro assistido (incremento 3). Só dados fictícios:
 * os CPFs são gerados aqui com dígitos verificadores válidos, sem pertencer a ninguém.
 */
let sequencia = 0;
function cpfFicticio(): string {
  // Base aleatória por execução + sequência: não repete entre testes nem entre execuções.
  const base = (Math.floor(Math.random() * 9e7) + 1e7 + sequencia++ * 7919) % 1e9;
  const d = String(base).padStart(9, "0").split("").map(Number);
  const dv = (n: number[]) => {
    const s = n.reduce((acc, v, i) => acc + v * (n.length + 1 - i), 0);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = dv(d);
  const d2 = dv([...d, d1]);
  return [...d, d1, d2].join("");
}

async function requisicao(contaId: string, tenantId: string, mfa = true): Promise<Requisicao> {
  const token = await criarSessao(contaId, mfa);
  await definirMunicipio(token, tenantId);
  return { sessao: await validarSessao(token), tenantDaUrl: tenantId, ip: "203.0.113.30" };
}

function dataLocal(dias: number): string {
  return new Date(Date.now() - 3 * 3_600_000 + dias * 86_400_000).toISOString().slice(0, 10);
}

const SENHA = "uma frase longa e fictícia para teste";

/** Cidadão com CPF real (cifrado), e-mail e senha conhecida, ativo no município. */
async function cidadaoCompleto(tenantId: string, email: string | null = "titular.ficticio@exemplo.test") {
  const cpf = cpfFicticio();
  const p = await admin.query<{ id: string }>(
    "INSERT INTO app.pessoa (nome, cpf_cifrado, cpf_indice, nascimento, email_cifrado) VALUES ($1, $2, $3, '1985-03-02', $4) RETURNING id",
    [`Titular Fictício ${sequencia}`, cifrar(cpf, "pessoa.cpf"), indiceCego(cpf, "pessoa.cpf"), email ? cifrar(email, "pessoa.email") : null],
  );
  const c = await admin.query<{ id: string }>("INSERT INTO app.conta (pessoa_id, senha_hash) VALUES ($1, $2) RETURNING id", [
    p.rows[0]!.id, await gerarHashSenha(SENHA),
  ]);
  const contaId = c.rows[0]!.id;
  const vinculoId = await vincular(tenantId, contaId, "cidadao");
  const tokenSessao = await criarSessao(contaId, false);
  await definirMunicipio(tokenSessao, tenantId);
  const req: Requisicao = { sessao: await validarSessao(tokenSessao), tenantDaUrl: tenantId, ip: "203.0.113.30" };
  return { cpf, pessoaId: p.rows[0]!.id, contaId, vinculoId, req, tokenSessao };
}

/** Processa a fila até sair a mensagem deste e-mail (a fila é global entre municípios). */
async function mensagensPara(destino: string) {
  const t = new TransporteMemoria();
  for (let i = 0; i < 5; i++) await processarLote(t, 100);
  return t.enviados.filter((e) => e.destino === destino).map((e) => e.mensagem);
}

function tokenDoLink(texto: string, caminho: string): string {
  const m = new RegExp(`${caminho}#([A-Za-z0-9_-]{43})`).exec(texto);
  if (!m) throw new Error("link não encontrado na mensagem");
  return m[1]!;
}

let A: string;
let B: string;
let unidadeA: string;
let gestorA: Requisicao;
let recepcaoA: { req: Requisicao; contaId: string };
let semPermissaoA: Requisicao;
const DIA = dataLocal(5);
const periodo = { de: `${DIA}T00:00:00-03:00`, ate: `${DIA}T23:59:59-03:00` };

beforeAll(async () => {
  await admin.query("DELETE FROM app.limite_tentativa");
  // A fila é global: avisos pendentes de outros arquivos não podem ocupar os lotes deste.
  await admin.query("UPDATE app.notificacao SET estado = 'enviada' WHERE estado = 'pendente'");
  A = await criarMunicipio("Município Fictício Família A");
  B = await criarMunicipio("Município Fictício Família B");
  unidadeA = await criarUnidade(A, "UBS Fictícia Família");
  const g = await criarPessoaEConta();
  await vincular(A, g.contaId, "gestor");
  gestorA = await requisicao(g.contaId, A);
  // Recepcionista com permissões só na unidade: vale para o cadastro do cidadão (qualquer unidade).
  const r = await criarPessoaEConta();
  const vr = await vincular(A, r.contaId, "equipe");
  await atribuirPerfil(A, vr, ["recepcao.assistido", "cidadao.ver", "cidadao.aprovar", "agenda.ver", "agenda.marcar"], unidadeA);
  recepcaoA = { req: await requisicao(r.contaId, A, false), contaId: r.contaId };
  const s = await criarPessoaEConta();
  await vincular(A, s.contaId, "equipe");
  semPermissaoA = await requisicao(s.contaId, A);

  const medico = await criarPessoaEConta();
  const profissional = await cadastrarProfissional(gestorA, {
    vinculoId: await vincular(A, medico.contaId, "equipe"), nomeExibicao: "Dr. Fictício Rocha", especialidade: "Pediatria",
  });
  await criarEscala(gestorA, {
    profissionalId: profissional, unidadeId: unidadeA, diaSemana: new Date(`${DIA}T12:00:00Z`).getUTCDay(),
    horaInicio: "08:00", horaFim: "12:00", duracaoMin: 20, vigenciaInicio: DIA, vigenciaFim: DIA, gerarAte: DIA,
  });
});

afterAll(async () => {
  await encerrarPool();
  await admin.end();
});

describe("recuperação de senha por e-mail", () => {
  it("envia link de uso único; a nova senha vale, a antiga não, e as sessões caem", async () => {
    const t = await cidadaoCompleto(A, "recupera.ficticio@exemplo.test");
    expect(await pedirRecuperacao(A, t.cpf, "203.0.113.31")).toBe("enviado");
    const [msg] = await mensagensPara("recupera.ficticio@exemplo.test");
    expect(msg!.assunto).toContain("Nova senha");
    expect(msg!.texto).not.toContain(t.cpf);
    const token = tokenDoLink(msg!.texto, "/recuperar/nova");

    // Depois do envio, o token cifrado sai da fila.
    const fila = await admin.query("SELECT count(*)::int AS n FROM app.notificacao WHERE pessoa_id = $1 AND dados ? 'token_cifrado'", [t.pessoaId]);
    expect(fila.rows[0].n).toBe(0);

    expect(await redefinirSenha(A, "recuperar_senha", token, "curta")).toBe("senha_fraca");
    // Outro município não aceita o link (e não o gasta).
    expect(await redefinirSenha(B, "recuperar_senha", token, "outra frase longa e fictícia")).toBe("link_invalido");
    // Link de recuperação não serve como primeiro acesso.
    expect(await redefinirSenha(A, "convite", token, "outra frase longa e fictícia")).toBe("link_invalido");
    expect(await redefinirSenha(A, "recuperar_senha", token, "outra frase longa e fictícia")).toBe("ok");
    expect(await redefinirSenha(A, "recuperar_senha", token, "mais uma frase longa fictícia")).toBe("link_invalido");

    expect(await validarSessao(t.tokenSessao)).toBeNull();
    expect((await entrar({ cpf: t.cpf, senha: SENHA, ip: "203.0.113.32" })).ok).toBe(false);
    expect((await entrar({ cpf: t.cpf, senha: "outra frase longa e fictícia", ip: "203.0.113.32" })).ok).toBe(true);
  });

  it("CPF sem cadastro, sem e-mail ou de outro município recebe a mesma resposta e nada é enviado", async () => {
    const semEmail = await cidadaoCompleto(A, null);
    const deB = await cidadaoCompleto(B, "outro.municipio@exemplo.test");
    const antes = (await admin.query("SELECT count(*)::int AS n FROM app.notificacao WHERE modelo = 'recuperar_senha'")).rows[0].n;
    expect(await pedirRecuperacao(A, cpfFicticio(), "203.0.113.33")).toBe("enviado");
    expect(await pedirRecuperacao(A, semEmail.cpf, "203.0.113.33")).toBe("enviado");
    expect(await pedirRecuperacao(A, deB.cpf, "203.0.113.33")).toBe("enviado");
    expect(await pedirRecuperacao(A, "111.111.111-11", "203.0.113.33")).toBe("enviado");
    const depois = (await admin.query("SELECT count(*)::int AS n FROM app.notificacao WHERE modelo = 'recuperar_senha'")).rows[0].n;
    expect(depois).toBe(antes);
  });

  it("limita pedidos por CPF", async () => {
    const t = await cidadaoCompleto(A, "limite.ficticio@exemplo.test");
    for (let i = 0; i < 3; i++) expect(await pedirRecuperacao(A, t.cpf, `203.0.113.${40 + i}`)).toBe("enviado");
    expect(await pedirRecuperacao(A, t.cpf, "203.0.113.44")).toBe("limite");
  });

  it("o banco só deixa trocar senha com link válido", async () => {
    const t = await cidadaoCompleto(A);
    const hash = await gerarHashSenha("frase inventada por um invasor");
    await comMunicipio({ tenantId: A, contaId: null }, async (tx) => {
      const r = await tx.query("SELECT app.senha_redefinir_com_link($1, 'recuperar_senha', $2) AS c", [Buffer.alloc(32, 1), hash]);
      expect(r.rows[0].c).toBeNull();
      // O papel da aplicação não altera a tabela de contas diretamente.
      await expect(tx.query("UPDATE app.conta SET senha_hash = $1 WHERE id = $2", [hash, t.contaId])).rejects.toThrow();
    });
  });
});

describe("primeiro acesso entregue pela recepção", () => {
  it("a recepção gera o link (permissão na unidade basta) e o cidadão cria a senha", async () => {
    const t = await cidadaoCompleto(A, null);
    await expect(gerarAcessoAssistido(semPermissaoA, t.vinculoId)).rejects.toBeInstanceOf(AcessoNegado);
    const acesso = await gerarAcessoAssistido(recepcaoA.req, t.vinculoId);
    expect(acesso).not.toBeNull();
    expect(acesso!.validoAte.getTime() - Date.now()).toBeLessThanOrEqual(3 * 86_400_000 + 60_000);
    expect(await redefinirSenha(A, "convite", acesso!.token, "senha do balcão bem comprida")).toBe("ok");
    expect((await entrar({ cpf: t.cpf, senha: "senha do balcão bem comprida", ip: "203.0.113.35" })).ok).toBe(true);
    const aud = await admin.query("SELECT count(*)::int AS n FROM app.auditoria WHERE acao = 'conta.acesso_assistido' AND objeto_id = $1", [t.vinculoId]);
    expect(aud.rows[0].n).toBe(1);
  });

  it("nunca para conta que é da equipe ou gestão em algum município", async () => {
    const t = await cidadaoCompleto(A, null);
    await vincular(B, t.contaId, "gestor");
    expect(await gerarAcessoAssistido(recepcaoA.req, t.vinculoId)).toBeNull();
  });

  it("link gerado antes de a pessoa virar equipe deixa de valer", async () => {
    const t = await cidadaoCompleto(A, null);
    const acesso = await gerarAcessoAssistido(recepcaoA.req, t.vinculoId);
    await vincular(B, t.contaId, "equipe");
    expect(await redefinirSenha(A, "convite", acesso!.token, "senha do balcão bem comprida")).toBe("link_invalido");
  });
});

describe("dependentes", () => {
  it("o titular pede, a unidade aprova e o titular marca para o dependente; o aviso vai para o titular", async () => {
    const t = await cidadaoCompleto(A, "mae.ficticia@exemplo.test");
    const cpfFilha = cpfFicticio();
    await pedirDependente(t.req, { nome: "Ana Fictícia de Tal", cpf: cpfFilha, nascimento: "2019-08-15", nomeCurto: "Ana", parentesco: "filho" });
    const [dep] = await meusDependentes(t.req);
    expect(dep).toMatchObject({ nome_curto: "Ana", estado: "pendente" });

    const vagas = await vagasParaCidadao(t.req, periodo);
    await expect(marcarParaMim(t.req, vagas[0]!.id, dep!.id)).rejects.toMatchObject({ codigo: "dependente_invalido" });

    // O titular não aprova o próprio pedido, nem direto no banco.
    await expect(
      comMunicipio({ tenantId: A, contaId: t.contaId }, (tx) => tx.query("UPDATE app.dependente SET estado = 'ativo' WHERE id = $1", [dep!.id])),
    ).rejects.toThrow(/sem_permissao/);

    const conferir = await dependentesParaConferir(recepcaoA.req);
    const item = conferir.find((d) => d.id === dep!.id);
    expect(item).toMatchObject({ nome: "Ana Fictícia de Tal", parentesco: "filho", tem_conta: false });
    await decidirDependente(recepcaoA.req, dep!.id, true);

    const consulta = await marcarParaMim(t.req, vagas[0]!.id, dep!.id);
    const minhas = await minhasConsultas(t.req);
    expect(minhas.find((c) => c.id === consulta)?.paciente).toBe("Ana");

    const [aviso] = await mensagensPara("mae.ficticia@exemplo.test");
    expect(aviso!.texto).toContain("Consulta de Ana");

    const comprovante = await emitirComprovante(t.req, consulta);
    expect(comprovante.dados.paciente).toBe("Ana Fictícia de Tal");

    // O titular e a dependente podem ter consultas no mesmo horário (pessoas diferentes).
    await expect(marcarParaMim(t.req, vagas[1]!.id)).resolves.toBeTypeOf("string");
  });

  it("ninguém marca para dependente de outra pessoa", async () => {
    const t = await cidadaoCompleto(A);
    const outro = await cidadaoCompleto(A);
    const id = await incluirDependenteAssistido(recepcaoA.req, t.vinculoId, {
      nome: "Bruno Fictício Souza", cpf: cpfFicticio(), nascimento: "2015-02-01", nomeCurto: "Bruno", parentesco: "filho",
    });
    const [vaga] = (await vagasParaCidadao(outro.req, periodo)).slice(-1);
    await expect(marcarParaMim(outro.req, vaga!.id, id)).rejects.toMatchObject({ codigo: "dependente_invalido" });
    await expect(marcarParaCidadao(recepcaoA.req, vaga!.id, outro.vinculoId, id)).rejects.toMatchObject({ codigo: "dependente_invalido" });
    await expect(encerrarDependente(outro.req, id)).rejects.toMatchObject({ codigo: "inexistente" });
  });

  it("a recepção inclui já aprovado e marca para o dependente", async () => {
    const t = await cidadaoCompleto(A);
    const id = await incluirDependenteAssistido(recepcaoA.req, t.vinculoId, {
      nome: "Dona Fictícia Pereira", cpf: cpfFicticio(), nascimento: "1938-11-20", nomeCurto: "Vó Lia", parentesco: "curatelado",
    });
    const lista = await dependentesDoCidadao(recepcaoA.req, t.vinculoId);
    expect(lista).toEqual([expect.objectContaining({ id, nome: "Dona Fictícia Pereira", estado: "ativo" })]);
    const vagas = await vagasParaCidadao(t.req, periodo);
    await expect(marcarParaCidadao(recepcaoA.req, vagas[2]!.id, t.vinculoId, id)).resolves.toBeTypeOf("string");
    await expect(incluirDependenteAssistido(semPermissaoA, t.vinculoId, {
      nome: "Outra Fictícia Pereira", cpf: cpfFicticio(), nascimento: "2001-01-01", nomeCurto: "Outra", parentesco: "outro",
    })).rejects.toBeInstanceOf(AcessoNegado);
  });

  it("não inclui a si mesmo, valida os dados e limita a quantidade", async () => {
    const t = await cidadaoCompleto(A);
    await expect(pedirDependente(t.req, { nome: "Eu Mesmo Fictício", cpf: t.cpf, nascimento: "1985-03-02", nomeCurto: "Eu", parentesco: "outro" }))
      .rejects.toMatchObject({ codigo: "dependente_invalido" });
    await expect(pedirDependente(t.req, { nome: "X", cpf: "123", nascimento: "2999-01-01", nomeCurto: "", parentesco: "chefe" }))
      .rejects.toMatchObject({ codigo: "dados_invalidos" });
    for (let i = 0; i < 10; i++) {
      await pedirDependente(t.req, { nome: `Criança Fictícia ${"abcdefghij"[i]}`, cpf: cpfFicticio(), nascimento: "2018-01-01", nomeCurto: "Criança", parentesco: "filho" });
    }
    await expect(pedirDependente(t.req, { nome: "Criança Fictícia Onze", cpf: cpfFicticio(), nascimento: "2018-01-01", nomeCurto: "Onze", parentesco: "filho" }))
      .rejects.toMatchObject({ codigo: "limite_dependentes" });
  });

  it("isolamento: dependentes e aceites de um município não aparecem em outro", async () => {
    const t = await cidadaoCompleto(A);
    await incluirDependenteAssistido(recepcaoA.req, t.vinculoId, {
      nome: "Caio Fictício Lima", cpf: cpfFicticio(), nascimento: "2016-06-06", nomeCurto: "Caio", parentesco: "filho",
    });
    await comMunicipio({ tenantId: B, contaId: null }, async (tx) => {
      const d = await tx.query("SELECT count(*)::int AS n FROM app.dependente WHERE titular_vinculo_id = $1", [t.vinculoId]);
      expect(d.rows[0].n).toBe(0);
      const a = await tx.query("SELECT count(*)::int AS n FROM app.aceite_termos WHERE tenant_id = $1", [A]);
      expect(a.rows[0].n).toBe(0);
      await expect(tx.query("SELECT app.dependentes_do_titular($1)", [t.vinculoId])).rejects.toThrow(/sem_permissao/);
    });
    await comMunicipio({ tenantId: A, contaId: null }, async (tx) => {
      // Nem a aplicação grava direto nessas tabelas: só pelas funções do banco.
      await expect(tx.query(
        "INSERT INTO app.aceite_termos (tenant_id, vinculo_id, versao, canal) VALUES ($1, $2, '2026-11', 'assistido')", [A, t.vinculoId],
      )).rejects.toThrow();
    });
  });
});

describe("cadastro assistido e busca na recepção", () => {
  it("cadastra no balcão sem e-mail, já ativo, com aceite registrado por quem atendeu", async () => {
    const cpf = cpfFicticio();
    await expect(cadastrarAssistido(semPermissaoA, { nome: "Seu Fictício Nunes", cpf, nascimento: "1950-04-04", aceite: true }))
      .rejects.toBeInstanceOf(AcessoNegado);
    expect(await cadastrarAssistido(recepcaoA.req, { nome: "Seu Fictício Nunes", cpf, nascimento: "1950-04-04" }))
      .toEqual({ ok: false, campos: ["aceite"] });
    const r = await cadastrarAssistido(recepcaoA.req, { nome: "Seu Fictício Nunes", cpf, nascimento: "1950-04-04", email: "", aceite: true });
    expect(r).toMatchObject({ ok: true, situacao: "novo" });
    if (!r.ok || !("vinculoId" in r)) return;
    const v = await admin.query("SELECT estado FROM app.vinculo WHERE id = $1", [r.vinculoId]);
    expect(v.rows[0].estado).toBe("ativo");
    const aceite = await admin.query("SELECT versao, canal, registrado_por FROM app.aceite_termos WHERE vinculo_id = $1", [r.vinculoId]);
    expect(aceite.rows).toEqual([{ versao: VERSAO_TERMOS, canal: "assistido", registrado_por: recepcaoA.contaId }]);
    // Ninguém sabe a senha inicial: só entra depois do link de primeiro acesso.
    expect((await entrar({ cpf, senha: "qualquer frase longa que tentar", ip: "203.0.113.36" })).ok).toBe(false);

    expect(await cadastrarAssistido(recepcaoA.req, { nome: "Nome Diferente Fictício", cpf, nascimento: "1950-04-04", aceite: true }))
      .toMatchObject({ ok: true, situacao: "ja_cadastrado" });
  });

  it("aprova quem já tinha pedido pelo site e não troca o e-mail de quem já tem", async () => {
    const cpf = cpfFicticio();
    await cadastrarCidadao(A, { nome: "Dona Fictícia Barros", cpf, nascimento: "1972-07-07", email: "barros@exemplo.test", senha: SENHA, aceite: true });
    const r = await cadastrarAssistido(recepcaoA.req, { nome: "Dona Fictícia Barros", cpf, nascimento: "1972-07-07", email: "invasor@exemplo.test", aceite: true });
    expect(r).toMatchObject({ ok: true, situacao: "aprovado" });
    const p = await admin.query<{ email_cifrado: Buffer }>("SELECT email_cifrado FROM app.pessoa WHERE cpf_indice = $1", [indiceCego(cpf, "pessoa.cpf")]);
    expect(decifrar(p.rows[0]!.email_cifrado, "pessoa.email")).toBe("barros@exemplo.test");
    const canais = await admin.query("SELECT canal FROM app.aceite_termos a JOIN app.vinculo v ON v.id = a.vinculo_id JOIN app.conta c ON c.id = v.conta_id JOIN app.pessoa p ON p.id = c.pessoa_id WHERE p.cpf_indice = $1 ORDER BY a.criado_em", [indiceCego(cpf, "pessoa.cpf")]);
    expect(canais.rows.map((l) => l.canal)).toEqual(["autocadastro", "assistido"]);
  });

  it("cadastro recusado ou suspenso não é reativado pelo balcão", async () => {
    const t = await cidadaoCompleto(A);
    await admin.query("UPDATE app.vinculo SET estado = 'suspenso' WHERE id = $1", [t.vinculoId]);
    expect(await cadastrarAssistido(recepcaoA.req, { nome: "Titular Fictício", cpf: t.cpf, nascimento: "1985-03-02", aceite: true }))
      .toEqual({ ok: false, bloqueado: true });
  });

  it("busca por CPF ou nome, só no município, e exige permissão", async () => {
    const t = await cidadaoCompleto(A);
    const deB = await cidadaoCompleto(B);
    const nome = (await admin.query("SELECT nome FROM app.pessoa WHERE id = $1", [t.pessoaId])).rows[0].nome as string;
    expect((await buscarCidadaos(recepcaoA.req, t.cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4"))).map((c) => c.vinculo_id)).toEqual([t.vinculoId]);
    expect((await buscarCidadaos(recepcaoA.req, nome)).map((c) => c.vinculo_id)).toContain(t.vinculoId);
    expect(await buscarCidadaos(recepcaoA.req, deB.cpf)).toEqual([]);
    expect(await buscarCidadaos(recepcaoA.req, "ab")).toEqual([]);
    expect(await buscarCidadaos(recepcaoA.req, "%%%")).toEqual([]);
    await expect(buscarCidadaos(semPermissaoA, t.cpf)).rejects.toBeInstanceOf(AcessoNegado);
    // A busca fica na auditoria sem o termo buscado.
    const aud = await admin.query<{ detalhes: Record<string, unknown> }>(
      "SELECT detalhes FROM app.auditoria WHERE tenant_id = $1 AND acao = 'cidadao.buscar' ORDER BY criado_em DESC LIMIT 1", [A],
    );
    expect(JSON.stringify(aud.rows[0]!.detalhes)).not.toContain(t.cpf);
  });
});
