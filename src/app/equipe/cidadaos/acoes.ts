"use server";

import { gerarAcessoAssistido } from "@/lib/auth/recuperacao";
import { requisicaoAtual } from "@/lib/web/requisicao";
import { origemDoMunicipio, qrEmCaminhoSvg } from "@/lib/web/endereco";
import { AcessoNegado } from "@/lib/auth/autorizar";

export type EstadoAcesso =
  | { situacao: "inicial" }
  | { situacao: "erro"; mensagem: string }
  | { situacao: "gerado"; link: string; validoAte: string; qr: { tamanho: number; caminho: string } };

/**
 * Gera o link de primeiro acesso. Devolvido no corpo da resposta (useActionState), nunca na URL:
 * aparece uma vez na tela para imprimir ou mostrar ao cidadão.
 */
export async function acaoGerarAcesso(_anterior: EstadoAcesso, f: FormData): Promise<EstadoAcesso> {
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) return { situacao: "erro", mensagem: "Sua sessão terminou. Entre de novo." };
  try {
    const acesso = await gerarAcessoAssistido(atual.req, f.get("vinculo"));
    if (!acesso) {
      return { situacao: "erro", mensagem: "Não é possível gerar acesso para este cadastro aqui. Contas da equipe recuperam o acesso com a gestão." };
    }
    const link = `${origemDoMunicipio(atual.municipio.slug)}/primeiro-acesso#${acesso.token}`;
    return { situacao: "gerado", link, validoAte: acesso.validoAte.toISOString(), qr: qrEmCaminhoSvg(link) };
  } catch (e) {
    if (e instanceof AcessoNegado) return { situacao: "erro", mensagem: "Você não tem permissão para atendimento assistido." };
    throw e;
  }
}
