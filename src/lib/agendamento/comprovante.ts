import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import qrcode from "qrcode-generator";
import { indiceCego } from "@/lib/security/crypto";
import { env } from "@/lib/env";

/**
 * Comprovante de agendamento em PDF e o código de validação que vai nele.
 *
 * O código é derivado do id da consulta com HMAC e a chave secreta do índice cego: é sempre o
 * mesmo para a mesma consulta (a segunda via sai igual), não dá para adivinhar sem a chave e não
 * revela o id. O banco guarda só o SHA-256 do código.
 */
const PREFIXO = "AGD";

export function codigoDoComprovante(agendamentoId: string): string {
  const hex = indiceCego(agendamentoId, "comprovante.codigo").subarray(0, 16).toString("hex").toUpperCase();
  return `${PREFIXO}-${hex.match(/.{8}/g)!.join("-")}`;
}

/** Aceita o código digitado com ou sem hífens e em minúsculas. Devolve a forma canônica ou null. */
export function normalizarCodigo(texto: unknown): string | null {
  if (typeof texto !== "string" || texto.length > 80) return null;
  const limpo = texto.toUpperCase().replace(/^AGD/, "").replace(/[^0-9A-F]/g, "");
  if (limpo.length !== 32) return null;
  return `${PREFIXO}-${limpo.match(/.{8}/g)!.join("-")}`;
}

export function hashDoCodigo(codigoCanonico: string): Buffer {
  return createHash("sha256").update(codigoCanonico, "utf8").digest();
}

/** Endereço público de validação, no subdomínio do município. */
export function enderecoDeValidacao(slug: string, codigo: string): string {
  const base = env().CF_DOMINIO_BASE.toLowerCase();
  const origem = base === "localhost" ? `http://${slug}.localhost:${process.env.PORT ?? "3000"}` : `https://${slug}.${base}`;
  return `${origem}/validar/${codigo}`;
}

// ------------------------------------------------------------------ PDF
export interface DadosComprovante {
  municipio: string;
  corPrimaria: string | null;
  situacao: string;
  inicio: Date;
  fuso: string;
  unidade: string;
  profissional: string;
  especialidade: string;
  paciente: string;
  codigo: string;
  endereco: string;
  emitidoEm: Date;
}

function corHex(hex: string | null, padrao: RGB): RGB {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return padrao;
  const n = Number.parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function dataHoraCurta(d: Date, fuso: string): string {
  const p = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: fuso }).format(d);
  return p.replace(",", " às");
}

/** As fontes padrão do PDF cobrem o Latin-1; qualquer outro caractere vira "?" em vez de quebrar. */
function latin1(texto: string): string {
  return texto.normalize("NFC").replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
}

function centralizado(pagina: PDFPage, texto: string, y: number, fonte: PDFFont, tamanho: number, cor: RGB): void {
  const t = latin1(texto);
  const largura = fonte.widthOfTextAtSize(t, tamanho);
  pagina.drawText(t, { x: (pagina.getWidth() - largura) / 2, y, size: tamanho, font: fonte, color: cor });
}

/** Quebra um texto longo em linhas que cabem na largura. */
function linhas(texto: string, fonte: PDFFont, tamanho: number, largura: number): string[] {
  const saida: string[] = [];
  let atual = "";
  for (const palavra of latin1(texto).split(/\s+/)) {
    const tentativa = atual ? `${atual} ${palavra}` : palavra;
    if (fonte.widthOfTextAtSize(tentativa, tamanho) <= largura || !atual) atual = tentativa;
    else {
      saida.push(atual);
      atual = palavra;
    }
  }
  if (atual) saida.push(atual);
  return saida;
}

/** Marca genérica do sistema (círculo com cruz), desenhada em vetor. A logomarca do município entra aqui quando o envio de logo existir. */
function desenharMarca(pagina: PDFPage, cx: number, cy: number, cor: RGB): void {
  pagina.drawCircle({ x: cx, y: cy, size: 22, color: cor });
  pagina.drawRectangle({ x: cx - 4, y: cy - 13, width: 8, height: 26, color: rgb(1, 1, 1) });
  pagina.drawRectangle({ x: cx - 13, y: cy - 4, width: 26, height: 8, color: rgb(1, 1, 1) });
}

function desenharQr(pagina: PDFPage, texto: string, x: number, yTopo: number, lado: number): void {
  const qr = qrcode(0, "M");
  qr.addData(texto, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  const m = lado / n;
  for (let l = 0; l < n; l++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(l, c)) {
        // Um pouco de sobreposição evita frestas brancas entre os módulos em alguns leitores de PDF.
        pagina.drawRectangle({ x: x + c * m, y: yTopo - (l + 1) * m, width: m + 0.05, height: m + 0.05, color: rgb(0, 0, 0) });
      }
    }
  }
}

export async function gerarPdfComprovante(d: DadosComprovante): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("Comprovante de Agendamento");
  doc.setProducer("Consulta Fácil");
  doc.setCreator("Consulta Fácil");
  // Sem autor nem assunto: os metadados do arquivo não carregam dado pessoal.
  doc.setAuthor("");
  doc.setSubject("");
  doc.setKeywords([]);

  const pagina = doc.addPage([595.28, 841.89]); // A4
  const normal = await doc.embedFont(StandardFonts.Helvetica);
  const negrito = await doc.embedFont(StandardFonts.HelveticaBold);
  const cor = corHex(d.corPrimaria, rgb(0.13, 0.49, 0.3));
  const texto = rgb(0.13, 0.13, 0.13);
  const suave = rgb(0.42, 0.42, 0.42);
  const linhaCinza = rgb(0.88, 0.88, 0.88);
  const margem = 56;
  const largura = pagina.getWidth() - 2 * margem;

  let y = 780;
  desenharMarca(pagina, pagina.getWidth() / 2, y, cor);
  y -= 50;
  for (const l of linhas(d.municipio.toUpperCase(), negrito, 17, largura)) {
    centralizado(pagina, l, y, negrito, 17, texto);
    y -= 21;
  }
  centralizado(pagina, "Comprovante de Agendamento", y, normal, 12, texto);
  y -= 20;
  pagina.drawLine({ start: { x: margem, y }, end: { x: margem + largura, y }, thickness: 0.8, color: linhaCinza });
  y -= 30;

  const itens: [string, string][] = [
    ["Situação", d.situacao],
    ["Data e hora", dataHoraCurta(d.inicio, d.fuso)],
    ["Unidade", d.unidade],
    ["Profissional", `${d.profissional} (${d.especialidade})`],
    ["Paciente", d.paciente],
  ];
  for (const [rotulo, valor] of itens) {
    pagina.drawRectangle({ x: margem, y: y - 2, width: 3, height: 12, color: cor });
    const r = latin1(`${rotulo}: `);
    pagina.drawText(r, { x: margem + 10, y, size: 11, font: negrito, color: texto });
    const deslocamento = negrito.widthOfTextAtSize(r, 11);
    const partes = linhas(rotulo === "Data e hora" ? valor : valor.toUpperCase(), normal, 11, largura - 10 - deslocamento);
    partes.forEach((p, i) => pagina.drawText(p, { x: margem + 10 + deslocamento, y: y - i * 15, size: 11, font: normal, color: texto }));
    y -= 15 * partes.length + 8;
  }

  y -= 6;
  const ladoQr = 96;
  desenharQr(pagina, d.endereco, margem, y, ladoQr);
  const xTexto = margem + ladoQr + 20;
  let yt = y - 22;
  pagina.drawText("Código de validação", { x: xTexto, y: yt, size: 9, font: normal, color: suave });
  yt -= 15;
  pagina.drawText(latin1(d.codigo), { x: xTexto, y: yt, size: 10.5, font: negrito, color: texto });
  yt -= 22;
  pagina.drawText("Valide este comprovante em:", { x: xTexto, y: yt, size: 9, font: normal, color: suave });
  yt -= 14;
  for (const l of linhas(d.endereco.replace(/\/validar\//, "/validar/ "), normal, 9, margem + largura - xTexto)) {
    pagina.drawText(l.replace("/validar/ ", "/validar/"), { x: xTexto, y: yt, size: 9, font: normal, color: cor });
    yt -= 12;
  }
  y -= ladoQr + 22;

  pagina.drawLine({ start: { x: margem, y }, end: { x: margem + largura, y }, thickness: 0.8, color: linhaCinza });
  y -= 22;
  for (const aviso of [
    "Chegue com 15 minutos de antecedência e leve um documento com foto e o cartão do SUS.",
    "Se não puder comparecer, desmarque pelo sistema para liberar a vaga para outra pessoa.",
  ]) {
    centralizado(pagina, aviso, y, normal, 9, suave);
    y -= 13;
  }
  y -= 8;
  centralizado(pagina, `Emitido em: ${dataHoraCurta(d.emitidoEm, d.fuso).replace(" às", "")}`, y, normal, 9, texto);

  return doc.save();
}
