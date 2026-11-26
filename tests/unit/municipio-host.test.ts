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
    expect(slugDoHost("consultafacil.com.br", "consultafacil.com.br", "")).toBeNull();
    expect(slugDoHost("-x.consultafacil.com.br", "consultafacil.com.br")).toBeNull();
    expect(slugDoHost(null, "consultafacil.com.br")).toBeNull();
  });
  it("com município único, o domínio base abre esse município e só ele", () => {
    expect(slugDoHost("teste.up.railway.app", "teste.up.railway.app", "demo")).toBe("demo");
    expect(slugDoHost("Teste.up.railway.app:443", "teste.up.railway.app", "demo")).toBe("demo");
    expect(slugDoHost("outro.up.railway.app", "teste.up.railway.app", "demo")).toBeNull();
    expect(slugDoHost("natal.teste.up.railway.app", "teste.up.railway.app", "demo")).toBe("natal");
    expect(slugDoHost("teste.up.railway.app", "teste.up.railway.app", "Inválido!")).toBeNull();
  });
});
