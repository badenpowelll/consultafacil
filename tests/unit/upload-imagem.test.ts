import { describe, expect, it } from "vitest";
import { chaveDoObjeto, chavePertenceAoMunicipio, ImagemRecusada, validarELimparImagem } from "@/lib/arquivos/imagem";

function chunkPng(tipo: string, dados: Buffer): Buffer {
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(dados.length);
  return Buffer.concat([tamanho, Buffer.from(tipo, "latin1"), dados, Buffer.alloc(4)]); // CRC irrelevante aqui
}
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (...chunks: Buffer[]) => Buffer.concat([PNG_SIG, ...chunks]);

function segJpeg(marcador: number, dados: Buffer): Buffer {
  const t = Buffer.alloc(2);
  t.writeUInt16BE(dados.length + 2);
  return Buffer.concat([Buffer.from([0xff, marcador]), t, dados]);
}

const TENANT = "3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";

describe("upload de imagem", () => {
  it("remove textos e EXIF do PNG e descarta bytes depois do IEND", () => {
    const entrada = png(
      chunkPng("IHDR", Buffer.alloc(13)),
      chunkPng("tEXt", Buffer.from("Author\0Maria Fictícia")),
      chunkPng("eXIf", Buffer.from("GPS -5.79,-35.20")),
      chunkPng("IDAT", Buffer.from([1, 2, 3])),
      chunkPng("IEND", Buffer.alloc(0)),
      Buffer.from("<script>alert(1)</script>"),
    );
    const r = validarELimparImagem(entrada);
    expect(r.contentType).toBe("image/png");
    const texto = r.dados.toString("latin1");
    expect(texto).not.toContain("Maria");
    expect(texto).not.toContain("GPS");
    expect(texto).not.toContain("script");
    expect(texto).toContain("IDAT");
  });

  it("remove EXIF (APP1) e comentário do JPEG e mantém JFIF", () => {
    const entrada = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      segJpeg(0xe0, Buffer.from("JFIF\0")),
      segJpeg(0xe1, Buffer.from("Exif\0\0GPS -5.79 iPhone")),
      segJpeg(0xfe, Buffer.from("autor: Maria")),
      segJpeg(0xdb, Buffer.alloc(4)),
      segJpeg(0xda, Buffer.alloc(4)),
      Buffer.from([9, 9, 9, 0xff, 0xd9]),
    ]);
    const r = validarELimparImagem(entrada);
    const texto = r.dados.toString("latin1");
    expect(r.contentType).toBe("image/jpeg");
    expect(texto).toContain("JFIF");
    expect(texto).not.toContain("GPS");
    expect(texto).not.toContain("Maria");
    expect(r.dados.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
  });

  it("recusa SVG, HTML disfarçado, vazio, grande e corrompido", () => {
    const tentar = (b: Buffer) => {
      try { validarELimparImagem(b); return null; } catch (e) { return (e as ImagemRecusada).motivo; }
    };
    expect(tentar(Buffer.from('<svg onload="alert(1)"/>'))).toBe("tipo");
    expect(tentar(Buffer.from("<html>logo.png</html>"))).toBe("tipo");
    expect(tentar(Buffer.alloc(0))).toBe("vazia");
    expect(tentar(Buffer.concat([PNG_SIG, Buffer.alloc(1024 * 1024)]))).toBe("grande");
    expect(tentar(png(chunkPng("IHDR", Buffer.alloc(13))))).toBe("corrompida");
  });

  it("chave do objeto é gerada pelo servidor e presa ao município", () => {
    const chave = chaveDoObjeto(TENANT, "marca", "png");
    expect(chave).toMatch(new RegExp(`^tenant/${TENANT}/marca/[0-9a-f-]{36}\\.png$`));
    expect(chavePertenceAoMunicipio(chave, TENANT)).toBe(true);
    expect(chavePertenceAoMunicipio(chave, "00000000-0000-0000-0000-000000000000")).toBe(false);
    expect(chavePertenceAoMunicipio(`tenant/${TENANT}/marca/../../outro/x.png`, TENANT)).toBe(false);
  });
});
