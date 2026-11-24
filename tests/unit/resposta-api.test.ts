import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CampoProibidoNaResposta, encontrarCampoProibido, projetar, respostaDeErro, respostaSegura } from "@/lib/http/resposta";
import { AcessoNegado } from "@/lib/auth/autorizar";

const Unidade = z.object({ id: z.string(), nome: z.string() });

describe("projeção de respostas da API", () => {
  it("descarta campos fora do esquema", () => {
    const linhaDoBanco = { id: "u1", nome: "UBS Centro", tenant_id: "t1", criado_em: "2026-01-01", senha_hash: "x" };
    expect(projetar(Unidade, linhaDoBanco)).toEqual({ id: "u1", nome: "UBS Centro" });
  });

  it("bloqueia a resposta inteira se o esquema deixar passar campo proibido", () => {
    const EsquemaErrado = z.object({ id: z.string(), cpf_cifrado: z.string() });
    expect(() => projetar(EsquemaErrado, { id: "p1", cpf_cifrado: "..." })).toThrow(CampoProibidoNaResposta);
    const Aninhado = z.object({ itens: z.array(z.object({ conta: z.object({ mfa_segredo: z.string() }) })) });
    expect(() => projetar(Aninhado, { itens: [{ conta: { mfa_segredo: "x" } }] })).toThrow(CampoProibidoNaResposta);
  });

  it("reconhece os campos proibidos e aceita o documento mascarado", () => {
    for (const campo of ["senha_hash", "cpf", "cpf_indice", "cns_cifrado", "token_hash", "mfa_ativo", "segredo"]) {
      expect(encontrarCampoProibido({ [campo]: 1 })).not.toBeNull();
    }
    expect(encontrarCampoProibido({ cpf_mascarado: "***.982.247-**", nome: "Maria" })).toBeNull();
    expect(encontrarCampoProibido({ arquivo: Buffer.from("x") })).not.toBeNull();
  });

  it("resposta sai sem cache", async () => {
    const r = respostaSegura(Unidade, { id: "u1", nome: "UBS" });
    expect(r.headers.get("cache-control")).toContain("no-store");
    expect(r.headers.get("vary")).toBe("Cookie");
    expect(await r.json()).toEqual({ id: "u1", nome: "UBS" });
  });

  it("erro interno não expõe mensagem e traz só id de correlação", async () => {
    const espiao = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = respostaDeErro(new Error('duplicate key (email)=(fulano@exemplo.com)'), "/api/x");
    const corpo = await r.json();
    expect(r.status).toBe(500);
    expect(JSON.stringify(corpo)).not.toContain("fulano");
    expect(corpo.correlacao).toMatch(/^[0-9a-f-]{36}$/);
    expect(espiao.mock.calls.flat().join(" ")).not.toContain("fulano");
    espiao.mockRestore();
  });

  it("sem permissão e inexistente respondem igual (não revela existência)", async () => {
    const r = respostaDeErro(new AcessoNegado("sem_permissao"), "/api/x");
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ erro: "nao_encontrado" });
  });
});
