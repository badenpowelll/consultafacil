import qrcode from "qrcode-generator";
import { env } from "@/lib/env";

/** Origem pública do município (subdomínio). Em desenvolvimento, http://<slug>.localhost:<porta>. */
export function origemDoMunicipio(slug: string): string {
  const base = env().CF_DOMINIO_BASE.toLowerCase();
  // Município único (ambiente de teste): o endereço é o próprio domínio base.
  if (slug === process.env.CF_MUNICIPIO_UNICO && base !== "localhost") return `https://${base}`;
  return base === "localhost" ? `http://${slug}.localhost:${process.env.PORT ?? "3000"}` : `https://${slug}.${base}`;
}

/** QR em caminho SVG (um quadrado por módulo escuro), para desenhar sem HTML injetado. */
export function qrEmCaminhoSvg(texto: string): { tamanho: number; caminho: string } {
  const qr = qrcode(0, "M");
  qr.addData(texto, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  const partes: string[] = [];
  for (let l = 0; l < n; l++) for (let c = 0; c < n; c++) if (qr.isDark(l, c)) partes.push(`M${c} ${l}h1v1h-1z`);
  return { tamanho: n, caminho: partes.join("") };
}
