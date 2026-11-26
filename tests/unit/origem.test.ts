import { describe, expect, it } from "vitest";
import { pedidoDeOutroSite } from "@/lib/http/origem";

const pedido = (site?: string) => new Request("https://demo.consultafacil.test/equipe/painel/exportar", site ? { headers: { "sec-fetch-site": site } } : {});

describe("downloads só pela tela do sistema", () => {
  it("recusa link vindo de outro site ou de outro município (same-site)", () => {
    expect(pedidoDeOutroSite(pedido("cross-site"))).toBe(true);
    expect(pedidoDeOutroSite(pedido("same-site"))).toBe(true);
  });
  it("aceita a própria origem, endereço digitado e navegador sem o cabeçalho", () => {
    expect(pedidoDeOutroSite(pedido("same-origin"))).toBe(false);
    expect(pedidoDeOutroSite(pedido("none"))).toBe(false);
    expect(pedidoDeOutroSite(pedido())).toBe(false);
  });
});
