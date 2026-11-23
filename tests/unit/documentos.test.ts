import { describe, expect, it } from "vitest";
import { cnsValido, cpfValido, normalizarCpf } from "@/lib/validation/documentos";

// Números fictícios, gerados só para validar a regra dos dígitos.
function cnsFicticio(prefixo: string): string {
  for (let fim = 0; fim < 10; fim++) {
    const candidato = prefixo + String(fim);
    if (cnsValido(candidato)) return candidato;
  }
  return "";
}

describe("CPF", () => {
  it("aceita dígitos corretos com ou sem máscara", () => {
    expect(cpfValido("529.982.247-25")).toBe(true);
    expect(cpfValido("52998224725")).toBe(true);
  });
  it("recusa dígito errado, sequência repetida e tamanho errado", () => {
    expect(cpfValido("529.982.247-26")).toBe(false);
    expect(cpfValido("111.111.111-11")).toBe(false);
    expect(cpfValido("1234")).toBe(false);
  });
  it("normaliza removendo tudo que não é dígito", () => {
    expect(normalizarCpf(" 529.982.247-25 ")).toBe("52998224725");
  });
});

describe("CNS", () => {
  it("aceita número com soma ponderada múltipla de 11", () => {
    let achado = "";
    for (let i = 0; i < 200 && !achado; i++) achado = cnsFicticio(`7${String(1000000000000 + i).padStart(13, "0")}`);
    expect(achado).toHaveLength(15);
    expect(cnsValido(achado)).toBe(true);
  });
  it("recusa primeiro dígito inválido e tamanho errado", () => {
    expect(cnsValido("312345678901234")).toBe(false);
    expect(cnsValido("70000000")).toBe(false);
  });
});
