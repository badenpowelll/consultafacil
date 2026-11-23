import { describe, expect, it } from "vitest";
import { codigoTotp, gerarSegredoTotp, passoAtual, verificarTotp } from "@/lib/security/totp";

// Segredo do apêndice B da RFC 6238 ("12345678901234567890" em base32).
const SEGREDO_RFC = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("TOTP (RFC 6238)", () => {
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ])("vetor de teste T=%i", (t, esperado) => {
    expect(codigoTotp(SEGREDO_RFC, Math.floor(t / 30))).toBe(esperado);
  });
  it("aceita ±1 passo e devolve o passo usado", () => {
    const agora = 1_700_000_000_000;
    const passo = passoAtual(agora);
    expect(verificarTotp(SEGREDO_RFC, codigoTotp(SEGREDO_RFC, passo - 1), agora)).toBe(passo - 1);
    expect(verificarTotp(SEGREDO_RFC, codigoTotp(SEGREDO_RFC, passo + 2), agora)).toBeNull();
  });
  it("recusa formato inválido", () => {
    expect(verificarTotp(SEGREDO_RFC, "abc123")).toBeNull();
    expect(verificarTotp(SEGREDO_RFC, "1234567")).toBeNull();
  });
  it("gera segredos de 160 bits em base32", () => {
    const s = gerarSegredoTotp();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(gerarSegredoTotp()).not.toBe(s);
  });
});
