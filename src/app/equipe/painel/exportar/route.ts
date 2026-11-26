import { exportarConsultas, exportarIndicadores, FiltroInvalido } from "@/lib/gestao/indicadores";
import { AcessoNegado } from "@/lib/auth/autorizar";
import { cabecalhosDownload, ExportacaoGrandeDemais } from "@/lib/exportacao/exportar";
import { LimiteExcedido } from "@/lib/security/limites";
import { requisicaoAtual } from "@/lib/web/requisicao";

/** CSV do painel (indicadores ou consultas do período). Exige gestao.exportar com MFA. */
export async function GET(req: Request) {
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) return new Response(null, { status: 303, headers: { Location: "/entrar" } });
  const q = new URL(req.url).searchParams;
  const filtro = { de: q.get("de") ?? "", ate: q.get("ate") ?? "", unidadeId: q.get("unidade") ?? "" };
  try {
    const arq = q.get("tipo") === "consultas" ? await exportarConsultas(atual.req, filtro) : await exportarIndicadores(atual.req, filtro);
    return new Response(arq.conteudo, { headers: cabecalhosDownload(arq.nomeArquivo) });
  } catch (e) {
    const texto =
      e instanceof AcessoNegado ? "Sem permissão para exportar (exige a permissão de exportar relatórios e verificação em duas etapas)."
      : e instanceof ExportacaoGrandeDemais ? "Muitas linhas: escolha um período menor ou uma unidade."
      : e instanceof LimiteExcedido ? "Limite de exportações por hora atingido. Tente mais tarde."
      : e instanceof FiltroInvalido ? e.message
      : null;
    if (!texto) throw e;
    return new Response(texto, { status: e instanceof AcessoNegado ? 403 : 400, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
}
