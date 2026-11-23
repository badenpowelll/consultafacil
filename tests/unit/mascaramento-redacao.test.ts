import { describe, expect, it } from "vitest";
import { mascararCns, mascararCpf, mascararEmail, mascararNome, mascararTelefone } from "@/lib/security/mascaramento";
import { pareceSensivel, redigir } from "@/lib/security/redacao";
import { filtrarDetalhes } from "@/lib/auditoria";
import { montarLinha } from "@/lib/log";

// Todos os valores abaixo são fictícios.
describe("mascaramento", () => {
  it("CPF mostra só os dígitos do meio", () => {
    expect(mascararCpf("529.982.247-25")).toBe("***.982.247-**");
    expect(mascararCpf("52998224725")).toBe("***.982.247-**");
  });

  it("valor malformado vira máscara total, nunca passa inteiro", () => {
    expect(mascararCpf("123")).toBe("***");
    expect(mascararCpf(null)).toBe("***");
    expect(mascararCns("abc")).toBe("***");
    expect(mascararTelefone("12")).toBe("***");
    expect(mascararEmail("sem-arroba")).toBe("***");
    expect(mascararNome("   ")).toBe("***");
  });

  it("CNS, telefone, e-mail e nome", () => {
    expect(mascararCns("898 0012 3456 7890")).toBe("*** **** **** 7890");
    expect(mascararTelefone("(84) 99876-5432")).toBe("(84) *****-5432");
    expect(mascararTelefone("+55 84 99876-5432")).toBe("(84) *****-5432");
    expect(mascararEmail("maria.silva@exemplo.gov.br")).toBe("m***@e***.gov.br");
    expect(mascararNome("Maria Aparecida da Silva")).toBe("Maria A. d. S.");
  });
});

describe("redação de texto livre", () => {
  it("remove CPF, CNS, e-mail, telefone, token e credencial de conexão", () => {
    const texto =
      'Key (cpf)=(529.982.247-25) dup; cns 898001234567890; fulano@exemplo.com; (84) 99876-5432; ' +
      "cookie AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde; postgres://cf_app:s3nh4-forte@db.interno:5432/x; " +
      "Authorization: Bearer abc.def.ghi123456; senha=Segredo123";
    const r = redigir(texto);
    for (const vazado of ["529.982.247-25", "898001234567890", "fulano@exemplo.com", "99876-5432",
      "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde", "s3nh4-forte", "abc.def.ghi123456", "Segredo123"]) {
      expect(r).not.toContain(vazado);
    }
    expect(r).toContain("[cpf]");
    expect(r).toContain("postgres://[credencial]@db.interno");
  });

  it("não altera texto sem dado pessoal", () => {
    const texto = "agenda 3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f publicada com 12 vagas";
    expect(redigir(texto)).toBe(texto);
    expect(pareceSensivel(texto)).toBe(false);
  });
});

describe("auditoria e log não carregam dado pessoal", () => {
  it("auditoria descarta valor sensível mesmo em chave inocente", () => {
    expect(filtrarDetalhes({ referencia: "529.982.247-25", contato: "a@b.com.br", vagas: 4 })).toEqual({ vagas: 4 });
  });

  it("log só aceita campos permitidos e redige os textos", () => {
    const linha = JSON.parse(
      montarLinha("erro", { evento: "x.y", motivo: "falhou para 529.982.247-25", cpf: "52998224725", corpo: "{...}" } as never),
    );
    expect(linha.cpf).toBeUndefined();
    expect(linha.corpo).toBeUndefined();
    expect(linha.motivo).toBe("falhou para [cpf]");
  });
});
