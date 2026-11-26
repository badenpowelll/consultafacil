import { exportarAuditoria } from "@/lib/gestao/auditoria";
import { ErroGestao } from "@/lib/gestao/perfis";
import { AcessoNegado } from "@/lib/auth/autorizar";
import { cabecalhosDownload, ExportacaoGrandeDemais } from "@/lib/exportacao/exportar";
import { LimiteExcedido } from "@/lib/security/limites";
import { requisicaoAtual } from "@/lib/web/requisicao";
import { pedidoDeOutroSite } from "@/lib/http/origem";

/** CSV da auditoria com os filtros da tela. Exige auditoria.exportar com MFA; nomes saem mascarados. */
export async function GET(req: Request) {
  if (pedidoDeOutroSite(req)) return new Response("Abra a exportação pela tela do sistema.", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) return new Response(null, { status: 303, headers: { Location: "/entrar" } });
  const q = new URL(req.url).searchParams;
  const filtros = Object.fromEntries(["de", "ate", "modulo", "acao"].map((k) => [k, q.get(k) || undefined]));
  try {
    const arq = await exportarAuditoria(atual.req, filtros);
    return new Response(arq.conteudo, { headers: cabecalhosDownload(arq.nomeArquivo) });
  } catch (e) {
    const texto =
      e instanceof AcessoNegado ? "Sem permissão para exportar a auditoria (exige verificação em duas etapas)."
      : e instanceof ExportacaoGrandeDemais ? "Muitos registros: aplique filtros de data ou módulo."
      : e instanceof LimiteExcedido ? "Limite de exportações por hora atingido. Tente mais tarde."
      : e instanceof ErroGestao ? "Filtro inválido."
      : null;
    if (!texto) throw e;
    return new Response(texto, { status: e instanceof AcessoNegado ? 403 : 400, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
}
