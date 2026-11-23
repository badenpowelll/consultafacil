import { describe, expect, it } from "vitest";
import { filtrarDetalhes } from "@/lib/auditoria";

describe("filtro de detalhes da auditoria", () => {
  it("descarta chaves com dado pessoal e textos longos", () => {
    const r = filtrarDetalhes({
      cpf: "52998224725",
      nome_paciente: "Fulano",
      email: "a@b.c",
      senha: "x",
      unidade: "UBS Centro",
      longo: "x".repeat(300),
      quantidade: 3,
    });
    expect(r).toEqual({ unidade: "UBS Centro", quantidade: 3 });
  });
});
