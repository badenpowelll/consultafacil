import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comConta } from "@/lib/db/contexto";
import { encerrarPool } from "@/lib/db/pool";
import { AcessoNegado, comPermissao } from "@/lib/auth/autorizar";
import { entrar, LIMITES } from "@/lib/auth/login";
import { criarSessao, definirMunicipio, revogarSessao, revogarTodasDaConta, validarSessao } from "@/lib/auth/sessao";
import { cifrar, indiceCego } from "@/lib/security/crypto";
import { gerarHashSenha } from "@/lib/security/password";
import { codigoTotp, gerarSegredoTotp, passoAtual } from "@/lib/security/totp";
import { admin, atribuirPerfil, criarMunicipio, criarPessoaEConta, criarUnidade, vincular } from "./ambiente";

let municipioA: string;
let municipioB: string;
let unidade1: string;
let unidade2: string;

beforeAll(async () => {
  municipioA = await criarMunicipio("Município Fictício Sessão A");
  municipioB = await criarMunicipio("Município Fictício Sessão B");
  unidade1 = await criarUnidade(municipioB, "UBS Fictícia 1");
  unidade2 = await criarUnidade(municipioB, "UBS Fictícia 2");
});

afterAll(async () => {
  await encerrarPool();
  await admin.end();
});

describe("sessões", () => {
  it("cria, valida e revoga", async () => {
    const { contaId } = await criarPessoaEConta();
    const token = await criarSessao(contaId, false);
    expect((await validarSessao(token))?.contaId).toBe(contaId);
    await revogarSessao(token, "saida");
    expect(await validarSessao(token)).toBeNull();
  });

  it("recusa token mal formado e token inexistente", async () => {
    expect(await validarSessao("abc")).toBeNull();
    expect(await validarSessao("A".repeat(43))).toBeNull();
  });

  it("revoga todas as sessões da conta (troca de senha)", async () => {
    const { contaId } = await criarPessoaEConta();
    const t1 = await criarSessao(contaId, false);
    const t2 = await criarSessao(contaId, false);
    expect(await revogarTodasDaConta(contaId, "troca_senha")).toBe(2);
    expect(await validarSessao(t1)).toBeNull();
    expect(await validarSessao(t2)).toBeNull();
  });

  it("encerra sessão de conta bloqueada na próxima requisição", async () => {
    const { contaId } = await criarPessoaEConta();
    const token = await criarSessao(contaId, false);
    await admin.query("UPDATE app.conta SET bloqueada = true WHERE id = $1", [contaId]);
    expect(await validarSessao(token)).toBeNull();
  });

  it("encerra sessão ociosa", async () => {
    const { contaId } = await criarPessoaEConta();
    const token = await criarSessao(contaId, false);
    await admin.query("UPDATE app.sessao SET ultima_atividade = now() - interval '2 hours' WHERE conta_id = $1", [contaId]);
    expect(await validarSessao(token)).toBeNull();
  });

  it("só escolhe município com vínculo ativo, e a suspensão do município derruba a sessão", async () => {
    const { contaId } = await criarPessoaEConta();
    await vincular(municipioA, contaId, "equipe");
    const token = await criarSessao(contaId, true);
    expect(await definirMunicipio(token, municipioB)).toBe(false);
    expect(await definirMunicipio(token, municipioA)).toBe(true);
    expect((await validarSessao(token))?.tenantId).toBe(municipioA);

    const sa = await criarPessoaEConta({ superAdmin: true });
    await comConta(sa.contaId, (tx) => tx.query("SELECT app.municipio_alterar_estado($1, 'suspenso')", [municipioA]));
    expect(await validarSessao(token)).toBeNull();
    await admin.query("UPDATE app.tenant SET estado = 'ativo' WHERE id = $1", [municipioA]);
  });
});

describe("autorização por permissão e unidade", () => {
  it("vale só na unidade atribuída, só no município da sessão, e clínica exige perfil", async () => {
    const { contaId } = await criarPessoaEConta();
    const vinculo = await vincular(municipioB, contaId, "equipe");
    await atribuirPerfil(municipioB, vinculo, ["recepcao.checkin"], unidade1);
    const token = await criarSessao(contaId, true);
    await definirMunicipio(token, municipioB);
    const sessao = await validarSessao(token);
    const semMfa = await criarSessao(contaId, false);
    await definirMunicipio(semMfa, municipioB);
    const sessaoSemMfa = await validarSessao(semMfa);

    const pedir = (permissao: string, unidadeId: string | null, tenantDaUrl = municipioB) =>
      comPermissao({ sessao, tenantDaUrl, permissao, unidadeId }, async () => "ok");

    await expect(pedir("recepcao.checkin", unidade1)).resolves.toBe("ok");
    await expect(pedir("recepcao.checkin", unidade2)).rejects.toThrow(AcessoNegado);
    await expect(pedir("agenda.marcar", unidade1)).rejects.toThrow(/sem_permissao/);
    await expect(pedir("recepcao.checkin", unidade1, municipioA)).rejects.toThrow(/municipio_divergente/);
    // Toda ação da equipe exige MFA, mesmo sem pedir explicitamente.
    await expect(comPermissao({ sessao: sessaoSemMfa, tenantDaUrl: municipioB, permissao: "recepcao.checkin", unidadeId: unidade1 }, async () => 1)).rejects.toThrow(/sem_mfa/);
  });

  it("gestor recebe permissões administrativas, mas não clínicas", async () => {
    const { contaId } = await criarPessoaEConta();
    await vincular(municipioB, contaId, "gestor");
    const token = await criarSessao(contaId, true);
    await definirMunicipio(token, municipioB);
    const sessao = await validarSessao(token);
    await expect(comPermissao({ sessao, tenantDaUrl: municipioB, permissao: "gestao.perfis" }, async () => 1)).resolves.toBe(1);
    await expect(comPermissao({ sessao, tenantDaUrl: municipioB, permissao: "clinico.observacao.ver" }, async () => 1)).rejects.toThrow(
      /sem_permissao/,
    );
  });

  it("vínculo suspenso perde as permissões imediatamente", async () => {
    const { contaId } = await criarPessoaEConta();
    const vinculo = await vincular(municipioB, contaId, "gestor");
    const token = await criarSessao(contaId, true);
    await definirMunicipio(token, municipioB);
    const sessao = await validarSessao(token);
    await admin.query("UPDATE app.vinculo SET estado = 'suspenso' WHERE id = $1", [vinculo]);
    await expect(comPermissao({ sessao, tenantDaUrl: municipioB, permissao: "gestao.perfis" }, async () => 1)).rejects.toThrow(
      /sem_permissao/,
    );
  });

  it("sem sessão ou sem município escolhido, nada passa", async () => {
    await expect(comPermissao({ sessao: null, tenantDaUrl: municipioB, permissao: "agenda.ver" }, async () => 1)).rejects.toThrow(/sem_sessao/);
    const { contaId } = await criarPessoaEConta();
    const sessao = await validarSessao(await criarSessao(contaId, false));
    await expect(comPermissao({ sessao, tenantDaUrl: municipioB, permissao: "agenda.ver" }, async () => 1)).rejects.toThrow(/sem_municipio/);
  });
});

describe("login", () => {
  // CPFs fictícios com dígitos válidos, gerados para teste.
  const cpfComMfa = "52998224725";
  const cpfSemMfa = "11144477735";
  const senha = "cavalo bateria grampo correto";
  let segredo: string;

  async function cadastrar(cpf: string): Promise<string> {
    await admin.query("DELETE FROM app.limite_tentativa");
    const existente = await admin.query("SELECT c.id FROM app.conta c JOIN app.pessoa p ON p.id = c.pessoa_id WHERE p.cpf_indice = $1", [
      indiceCego(cpf, "pessoa.cpf"),
    ]);
    if (existente.rows[0]) return existente.rows[0].id;
    const p = await admin.query<{ id: string }>(
      "INSERT INTO app.pessoa (nome, cpf_cifrado, cpf_indice) VALUES ('Pessoa Fictícia Login', $1, $2) RETURNING id",
      [cifrar(cpf, "pessoa.cpf"), indiceCego(cpf, "pessoa.cpf")],
    );
    const c = await admin.query<{ id: string }>("INSERT INTO app.conta (pessoa_id, senha_hash) VALUES ($1, $2) RETURNING id", [
      p.rows[0]!.id,
      await gerarHashSenha(senha),
    ]);
    return c.rows[0]!.id;
  }

  beforeAll(async () => {
    await cadastrar(cpfSemMfa);
    const contaMfa = await cadastrar(cpfComMfa);
    segredo = gerarSegredoTotp();
    await admin.query("UPDATE app.conta SET mfa_ativo = true, mfa_segredo_cifrado = $2, mfa_ultimo_passo = 0 WHERE id = $1", [
      contaMfa,
      cifrar(segredo, `conta.mfa:${contaMfa}`),
    ]);
  });

  it("entra com CPF e senha corretos", async () => {
    await admin.query("DELETE FROM app.limite_tentativa");
    const r = await entrar({ cpf: "111.444.777-35", senha, ip: "203.0.113.10" });
    expect(r.ok).toBe(true);
  });

  it("dá a mesma resposta para senha errada e CPF inexistente", async () => {
    await admin.query("DELETE FROM app.limite_tentativa");
    const errada = await entrar({ cpf: cpfSemMfa, senha: "senha errada qualquer", ip: "203.0.113.11" });
    const inexistente = await entrar({ cpf: "39053344705", senha, ip: "203.0.113.11" });
    expect(errada).toEqual({ ok: false, motivo: "credenciais" });
    expect(inexistente).toEqual({ ok: false, motivo: "credenciais" });
  });

  it("bloqueia depois do limite por CPF, mesmo com a senha certa", async () => {
    await admin.query("DELETE FROM app.limite_tentativa");
    for (let i = 0; i < LIMITES.porCpf.tentativas; i++) {
      await entrar({ cpf: cpfSemMfa, senha: "senha errada qualquer", ip: `198.51.100.${i}` });
    }
    expect(await entrar({ cpf: cpfSemMfa, senha, ip: "198.51.100.200" })).toEqual({ ok: false, motivo: "limite" });
  });

  it("exige MFA e não aceita o mesmo código duas vezes", async () => {
    await admin.query("DELETE FROM app.limite_tentativa");
    expect(await entrar({ cpf: cpfComMfa, senha, ip: "203.0.113.20" })).toEqual({ ok: false, motivo: "mfa_necessario" });
    const codigo = codigoTotp(segredo, passoAtual());
    const primeira = await entrar({ cpf: cpfComMfa, senha, codigoMfa: codigo, ip: "203.0.113.20" });
    expect(primeira.ok).toBe(true);
    const repetida = await entrar({ cpf: cpfComMfa, senha, codigoMfa: codigo, ip: "203.0.113.20" });
    expect(repetida).toEqual({ ok: false, motivo: "credenciais" });
  });
});

