import { AcessoNegado } from "@/lib/auth/autorizar";
import { TAMANHO_MAXIMO } from "@/lib/arquivos/imagem";
import { enviarLogomarca } from "@/lib/gestao/identidade";
import { ErroGestao } from "@/lib/gestao/perfis";
import { requisicaoAtual } from "@/lib/web/requisicao";

function para(destino: string): Response {
  return new Response(null, { status: 303, headers: { Location: destino } });
}

/** Envio da logomarca por formulário comum (multipart). Só da própria origem e até 1 MB. */
export async function POST(req: Request) {
  const origem = req.headers.get("origin");
  if (!origem || new URL(origem).host !== req.headers.get("host")) return new Response(null, { status: 403 });
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) return para("/entrar");
  // Recusa cedo um corpo grande demais, antes de ler (a imagem tem 1 MB; sobra para o envelope).
  if (Number(req.headers.get("content-length") ?? 0) > TAMANHO_MAXIMO + 64 * 1024) return para("/equipe/identidade?erro=imagem_invalida");

  const arquivo = (await req.formData()).get("logomarca");
  if (!(arquivo instanceof File)) return para("/equipe/identidade?erro=imagem_invalida");
  try {
    await enviarLogomarca(atual.req, Buffer.from(await arquivo.arrayBuffer()));
  } catch (e) {
    if (e instanceof ErroGestao) return para(`/equipe/identidade?erro=${e.codigo}`);
    if (e instanceof AcessoNegado) return para("/equipe/identidade");
    throw e;
  }
  return para("/equipe/identidade?ok=logomarca");
}
