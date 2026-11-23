import { describe, expect, it } from "vitest";
import { avaliarSenha, conferirSenha, gerarHashSenha } from "@/lib/security/password";
import { formatoDeTokenValido, gerarTokenOpaco, hashDoToken } from "@/lib/security/tokens";

describe("senhas", () => {
  it("recusa senhas curtas, comuns e repetitivas", () => {
    expect(avaliarSenha("curta")).toBe("curta");
    expect(avaliarSenha("consultafacil")).toBe("comum");
    expect(avaliarSenha("aaaaaaaaaaaaaa")).toBe("repetitiva");
    expect(avaliarSenha("x".repeat(129))).toBe("longa");
    expect(avaliarSenha("cavalo bateria grampo correto")).toBeNull();
  });
  it("gera Argon2id e confere", async () => {
    const h = await gerarHashSenha("cavalo bateria grampo correto");
    expect(h.startsWith("$argon2id$")).toBe(true);
    expect(await conferirSenha(h, "cavalo bateria grampo correto")).toBe(true);
    expect(await conferirSenha(h, "cavalo bateria grampo errado")).toBe(false);
  });
});

describe("tokens opacos", () => {
  it("têm 256 bits, formato fixo e hash de 32 bytes", () => {
    const t = gerarTokenOpaco();
    expect(formatoDeTokenValido(t)).toBe(true);
    expect(hashDoToken(t)).toHaveLength(32);
    expect(gerarTokenOpaco()).not.toBe(t);
    expect(formatoDeTokenValido("' OR 1=1 --")).toBe(false);
  });
});
