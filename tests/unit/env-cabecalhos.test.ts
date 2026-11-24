import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { conferirSegregacaoDeSegredos, type Env } from "@/lib/env";
import { middleware } from "@/middleware";

const base: Env = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://cf_app:x@db:5432/cf",
  CF_CHAVES_DADOS: "1:x",
  CF_CHAVE_DADOS_ATIVA: 1,
  CF_CHAVE_INDICE: "x",
  CF_DOMINIO_BASE: "consultafacil.test",
  CF_SESSAO_OCIOSA_MIN: 30,
  CF_SESSAO_ABSOLUTA_H: 12,
};

describe("segregação de segredos em produção", () => {
  it("recusa subir a aplicação com credencial administrativa no ambiente", () => {
    expect(() => conferirSegregacaoDeSegredos(base, { DATABASE_URL_ADMIN: "postgres://postgres:x@db/cf" })).toThrow(/DATABASE_URL_ADMIN/);
    expect(() => conferirSegregacaoDeSegredos(base, { CF_SEED_SENHA: "abc" })).toThrow(/CF_SEED_SENHA/);
  });

  it("recusa conectar com papel diferente de cf_app", () => {
    expect(() => conferirSegregacaoDeSegredos({ ...base, DATABASE_URL: "postgres://postgres:x@db:5432/cf" }, {})).toThrow(/cf_app/);
  });

  it("aceita a configuração correta e não se aplica fora de produção", () => {
    expect(() => conferirSegregacaoDeSegredos(base, {})).not.toThrow();
    expect(() => conferirSegregacaoDeSegredos({ ...base, NODE_ENV: "development" }, { DATABASE_URL_ADMIN: "x" })).not.toThrow();
  });
});

describe("cabeçalhos do middleware", () => {
  it("proíbe cache de respostas dinâmicas e descarta cabeçalho interno forjado", () => {
    const req = new NextRequest("https://demo.consultafacil.test/painel", {
      headers: { host: "demo.consultafacil.test", "x-cf-municipio": "outro" },
    });
    const r = middleware(req);
    expect(r.headers.get("cache-control")).toContain("no-store");
    expect(r.headers.get("vary")).toBe("Cookie");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    // O valor repassado ao servidor é o do subdomínio, não o que o cliente mandou.
    expect(r.headers.get("x-middleware-request-x-cf-municipio")).toBe("demo");
  });
});
