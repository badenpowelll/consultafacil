import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encerrarPool } from "@/lib/db/pool";
import { criarSessao, definirMunicipio, validarSessao } from "@/lib/auth/sessao";
import { entrar } from "@/lib/auth/login";
import { cadastrarCidadao, cadastrosPendentes, decidirCadastro } from "@/lib/cidadao/cadastro";
import { AcessoNegado } from "@/lib/auth/autorizar";
import type { Requisicao } from "@/lib/agendamento/servico";
import { admin, criarMunicipio, criarPessoaEConta, vincular } from "./ambiente";

// CPF fictício com dígitos válidos, exclusivo deste teste.
const CPF = "86288366757";
const SENHA = "uma frase longa e fictícia";
let municipio: string;
let gestor: Requisicao;

beforeAll(async () => {
  await admin.query("DELETE FROM app.limite_tentativa");
  municipio = await criarMunicipio("Município Fictício Cadastro");
  const g = await criarPessoaEConta();
  await vincular(municipio, g.contaId, "gestor");
  const token = await criarSessao(g.contaId, true);
  await definirMunicipio(token, municipio);
  gestor = { sessao: await validarSessao(token), tenantDaUrl: municipio };
});

afterAll(async () => {
  await encerrarPool();
  await admin.end();
});

describe("autocadastro do cidadão", () => {
  it("cria o cadastro aguardando aprovação; só entra no município depois de aprovado", async () => {
    const dados = { nome: "Fulana Fictícia de Tal", cpf: CPF, nascimento: "1990-05-10", email: "fulana@exemplo.test", senha: SENHA, aceite: true };
    expect(await cadastrarCidadao(municipio, dados)).toEqual({ ok: true });

    const login = await entrar({ cpf: CPF, senha: SENHA, ip: "203.0.113.50" });
    expect(login.ok).toBe(true);
    if (!login.ok) return;
    expect(await definirMunicipio(login.token, municipio)).toBe(false);

    const pendentes = await cadastrosPendentes(gestor);
    const meu = pendentes.find((p) => p.nome === "Fulana Fictícia de Tal");
    expect(meu).toBeTruthy();
    await decidirCadastro(gestor, meu!.vinculo_id, true);
    expect(await definirMunicipio(login.token, municipio)).toBe(true);
  });

  it("o mesmo CPF de novo não cria nada nem troca a senha, e a resposta é igual", async () => {
    const r = await cadastrarCidadao(municipio, { nome: "Outra Pessoa Fictícia", cpf: CPF, nascimento: "1980-01-01", email: "x@exemplo.test", senha: "outra senha bem longa aqui", aceite: true });
    expect(r).toEqual({ ok: true });
    await admin.query("DELETE FROM app.limite_tentativa");
    expect((await entrar({ cpf: CPF, senha: "outra senha bem longa aqui", ip: "203.0.113.51" })).ok).toBe(false);
    expect((await entrar({ cpf: CPF, senha: SENHA, ip: "203.0.113.51" })).ok).toBe(true);
  });

  it("valida campos e não grava dado pessoal na auditoria", async () => {
    const r = await cadastrarCidadao(municipio, { nome: "X", cpf: "123", nascimento: "2999-01-01", email: "inválido", senha: "curta" });
    expect(r).toEqual({ ok: false, campos: ["nome", "cpf", "nascimento", "email", "senha", "aceite"] });
    const a = await admin.query("SELECT detalhes::text AS d FROM app.auditoria WHERE tenant_id = $1 AND acao = 'cidadao.autocadastro'", [municipio]);
    for (const l of a.rows) expect(l.d).not.toMatch(/Fulana|86288366757|exemplo\.test/);
  });

  it("aprovar cadastro exige a permissão", async () => {
    const { contaId } = await criarPessoaEConta();
    await vincular(municipio, contaId, "equipe");
    const token = await criarSessao(contaId, true);
    await definirMunicipio(token, municipio);
    await expect(cadastrosPendentes({ sessao: await validarSessao(token), tenantDaUrl: municipio })).rejects.toThrow(AcessoNegado);
  });
});
