import { describe, expect, it } from "vitest";
import { slugDoHost } from "@/lib/web/municipio-host";

describe("município pelo endereço", () => {
  it("extrai o slug do subdomínio", () => {
    expect(slugDoHost("natal.consultafacil.com.br", "consultafacil.com.br")).toBe("natal");
    expect(slugDoHost("Natal.ConsultaFacil.com.br:443", "consultafacil.com.br")).toBe("natal");
  });
  it("recusa domínio alheio, subdomínio aninhado e formatos inválidos", () => {
    expect(slugDoHost("natal.consultafacil.com.br.evil.test", "consultafacil.com.br")).toBeNull();
    expect(slugDoHost("a.b.consultafacil.com.br", "consultafacil.com.br")).toBeNull();
    expect(slugDoHost("consultafacil.com.br", "consultafacil.com.br")).toBeNull();
    expect(slugDoHost("-x.consultafacil.com.br", "consultafacil.com.br")).toBeNull();
    expect(slugDoHost(null, "consultafacil.com.br")).toBeNull();
  });
});
