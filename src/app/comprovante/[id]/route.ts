import { emitirComprovante } from "@/lib/agendamento/servico";
import { gerarPdfComprovante } from "@/lib/agendamento/comprovante";
import { ErroAgendamento } from "@/lib/agendamento/erros";
import { AcessoNegado } from "@/lib/auth/autorizar";
import { requisicaoAtual } from "@/lib/web/requisicao";

/** PDF do comprovante. Só o próprio cidadão ou a equipe da unidade; nada vai para cache. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const atual = await requisicaoAtual();
  if (!atual) return new Response("Município não encontrado.", { status: 404 });
  if (!atual.req.sessao) return new Response(null, { status: 303, headers: { Location: "/entrar" } });
  const { id } = await params;
  try {
    const { dados } = await emitirComprovante(atual.req, id);
    const pdf = await gerarPdfComprovante(dados);
    return new Response(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'inline; filename="comprovante-agendamento.pdf"',
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (erro) {
    if (erro instanceof ErroAgendamento || erro instanceof AcessoNegado) {
      return new Response("Consulta não encontrada.", { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    throw erro;
  }
}
