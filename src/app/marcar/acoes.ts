"use server";

import { redirect } from "next/navigation";
import { marcarParaMim, remarcarMinha } from "@/lib/agendamento/servico";
import { ErroAgendamento } from "@/lib/agendamento/erros";
import { requisicaoAtual } from "@/lib/web/requisicao";

export async function acaoMarcar(formulario: FormData): Promise<void> {
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  const remarcar = formulario.get("remarcar");
  try {
    if (remarcar) await remarcarMinha(atual.req, remarcar, formulario.get("vaga"));
    else await marcarParaMim(atual.req, formulario.get("vaga"), formulario.get("para"));
  } catch (erro) {
    if (erro instanceof ErroAgendamento) redirect(`/marcar?erro=${erro.codigo}`);
    throw erro;
  }
  redirect(`/minhas-consultas?ok=${remarcar ? "remarcada" : "marcada"}`);
}
