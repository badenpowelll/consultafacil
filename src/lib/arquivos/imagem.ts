import { randomUUID } from "node:crypto";

/**
 * Upload de imagens (logomarca e brasão do município; fotos no futuro).
 *
 *  - Tipo decidido pelos bytes iniciais, nunca pela extensão nem pelo Content-Type do cliente.
 *  - Só PNG e JPEG. SVG fica de fora: é XML com script e vira XSS se servido inline.
 *  - Tamanho máximo fixo.
 *  - Metadados removidos (EXIF com GPS, modelo do aparelho, nome do autor, textos PNG):
 *    uma foto tirada no celular carrega a localização de quem tirou.
 *  - Nome do objeto gerado pelo servidor dentro do prefixo do município. O nome enviado pelo
 *    usuário é descartado (evita path traversal e dado pessoal no nome do arquivo).
 */
export const TAMANHO_MAXIMO = 1024 * 1024;

export type TipoImagem = "png" | "jpeg";

export class ImagemRecusada extends Error {
  constructor(public readonly motivo: "vazia" | "grande" | "tipo" | "corrompida") {
    super(`Imagem recusada: ${motivo}`);
    this.name = "ImagemRecusada";
  }
}

const ASSINATURA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function detectarTipo(dados: Buffer): TipoImagem | null {
  if (dados.length >= 8 && dados.subarray(0, 8).equals(ASSINATURA_PNG)) return "png";
  if (dados.length >= 3 && dados[0] === 0xff && dados[1] === 0xd8 && dados[2] === 0xff) return "jpeg";
  return null;
}

/** Chunks PNG que carregam texto livre ou metadados. Os demais são necessários para a imagem. */
const CHUNKS_PNG_REMOVIDOS = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);

function limparPng(dados: Buffer): Buffer {
  const partes: Buffer[] = [ASSINATURA_PNG];
  let pos = 8;
  let fim = false;
  while (pos + 12 <= dados.length) {
    const tamanho = dados.readUInt32BE(pos);
    const tipo = dados.toString("latin1", pos + 4, pos + 8);
    const total = 12 + tamanho;
    if (pos + total > dados.length) throw new ImagemRecusada("corrompida");
    if (!CHUNKS_PNG_REMOVIDOS.has(tipo)) partes.push(dados.subarray(pos, pos + total));
    pos += total;
    if (tipo === "IEND") {
      fim = true;
      break;
    }
  }
  // Bytes depois do IEND (arquivo "poliglota" com outro conteúdo anexado) são descartados.
  if (!fim) throw new ImagemRecusada("corrompida");
  return Buffer.concat(partes);
}

/**
 * Remove segmentos APP1–APP15 (EXIF, XMP, IPTC, ...) e COM (comentário) do JPEG.
 * APP0 (JFIF) é mantido. A partir do SOS os dados comprimidos são copiados até o EOI.
 */
function limparJpeg(dados: Buffer): Buffer {
  const partes: Buffer[] = [dados.subarray(0, 2)];
  let pos = 2;
  while (pos + 4 <= dados.length) {
    if (dados[pos] !== 0xff) throw new ImagemRecusada("corrompida");
    const marcador = dados[pos + 1]!;
    if (marcador === 0xd9) break; // EOI sem imagem
    const tamanho = dados.readUInt16BE(pos + 2);
    if (tamanho < 2 || pos + 2 + tamanho > dados.length) throw new ImagemRecusada("corrompida");
    const segmento = dados.subarray(pos, pos + 2 + tamanho);
    const removido = (marcador >= 0xe1 && marcador <= 0xef) || marcador === 0xfe;
    if (marcador === 0xda) {
      const eoi = dados.lastIndexOf(Buffer.from([0xff, 0xd9]));
      if (eoi < pos) throw new ImagemRecusada("corrompida");
      partes.push(dados.subarray(pos, eoi + 2));
      return Buffer.concat(partes);
    }
    if (!removido) partes.push(segmento);
    pos += 2 + tamanho;
  }
  throw new ImagemRecusada("corrompida");
}

export interface ImagemLimpa {
  tipo: TipoImagem;
  dados: Buffer;
  contentType: "image/png" | "image/jpeg";
}

export function validarELimparImagem(dados: Buffer): ImagemLimpa {
  if (dados.length === 0) throw new ImagemRecusada("vazia");
  if (dados.length > TAMANHO_MAXIMO) throw new ImagemRecusada("grande");
  const tipo = detectarTipo(dados);
  if (!tipo) throw new ImagemRecusada("tipo");
  return tipo === "png"
    ? { tipo, dados: limparPng(dados), contentType: "image/png" }
    : { tipo, dados: limparJpeg(dados), contentType: "image/jpeg" };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIAS = ["marca"] as const;

/** Chave do objeto no bucket privado: tenant/<id>/<categoria>/<uuid>.<ext>. */
export function chaveDoObjeto(tenantId: string, categoria: (typeof CATEGORIAS)[number], tipo: TipoImagem): string {
  if (!UUID.test(tenantId)) throw new Error("Município inválido");
  if (!CATEGORIAS.includes(categoria)) throw new Error("Categoria inválida");
  return `tenant/${tenantId}/${categoria}/${randomUUID()}.${tipo === "png" ? "png" : "jpg"}`;
}

/** Confere que uma chave pedida pertence ao município da sessão antes de servir o arquivo. */
export function chavePertenceAoMunicipio(chave: string, tenantId: string): boolean {
  return (
    UUID.test(tenantId) &&
    new RegExp(`^tenant/${tenantId}/(${CATEGORIAS.join("|")})/[0-9a-f-]{36}\\.(png|jpg)$`, "i").test(chave)
  );
}

/** Cabeçalhos para servir uma imagem enviada por usuário. */
export function cabecalhosImagem(contentType: ImagemLimpa["contentType"]): Record<string, string> {
  return {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "private, max-age=300",
  };
}
