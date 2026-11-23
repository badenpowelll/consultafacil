import { describe, expect, it } from "vitest";
import { cifrar, decifrar, indiceCego, versaoDaChave, iguaisEmTempoConstante } from "@/lib/security/crypto";

describe("criptografia de campo", () => {
  it("cifra e decifra com a chave ativa", () => {
    const c = cifrar("52998224725", "pessoa.cpf");
    expect(versaoDaChave(c)).toBe(2);
    expect(decifrar(c, "pessoa.cpf")).toBe("52998224725");
  });
  it("gera texto cifrado diferente a cada chamada (IV aleatório)", () => {
    expect(cifrar("x", "a").equals(cifrar("x", "a"))).toBe(false);
  });
  it("falha se o valor for colado em outro campo (contexto autenticado)", () => {
    const c = cifrar("52998224725", "pessoa.cpf");
    expect(() => decifrar(c, "pessoa.cns")).toThrow();
  });
  it("falha se um único byte for adulterado", () => {
    const c = cifrar("segredo", "conta.mfa");
    c[c.length - 1] = c[c.length - 1]! ^ 1;
    expect(() => decifrar(c, "conta.mfa")).toThrow();
  });
  it("índice cego é determinístico e separado por contexto", () => {
    expect(indiceCego("52998224725", "pessoa.cpf").equals(indiceCego("52998224725", "pessoa.cpf"))).toBe(true);
    expect(indiceCego("52998224725", "pessoa.cpf").equals(indiceCego("52998224725", "pessoa.cns"))).toBe(false);
  });
  it("comparação em tempo constante", () => {
    expect(iguaisEmTempoConstante(Buffer.from("abc"), Buffer.from("abc"))).toBe(true);
    expect(iguaisEmTempoConstante(Buffer.from("abc"), Buffer.from("abd"))).toBe(false);
    expect(iguaisEmTempoConstante(Buffer.from("abc"), Buffer.from("ab"))).toBe(false);
  });
});
