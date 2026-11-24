import { cabecalhosImagem } from "@/lib/arquivos/imagem";
import { logomarcaPublica } from "@/lib/gestao/identidade";
import { municipioAtual } from "@/lib/web/requisicao";

/** Logomarca do município do endereço acessado. Pública: aparece no topo do site e no comprovante. */
export async function GET() {
  const municipio = await municipioAtual();
  const logo = municipio ? await logomarcaPublica(municipio.id) : null;
  if (!logo) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  return new Response(new Uint8Array(logo.dados), { headers: cabecalhosImagem(logo.contentType) });
}
