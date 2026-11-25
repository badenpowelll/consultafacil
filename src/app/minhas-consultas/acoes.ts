"use server";

import { redirect } from "next/navigation";
import { confirmarMinha, desmarcarMinha } from "@/lib/agendamento/servico";
import { ErroAgendamento } from "@/lib/agendamento/erros";
import { requisicaoAtual } from "@/lib/web/requisicao";

export async function acaoDesmarcar(formulario: FormData): Promise<void> {
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  try {
    await desmarcarMinha(atual.req, formulario.get("consulta"), formulario.get("motivo"));
  } catch (erro) {
    if (erro instanceof ErroAgendamento) redirect(`/minhas-consultas?erro=${erro.codigo}`);
    throw erro;
  }
  redirect("/minhas-consultas?ok=desmarcada");
}

export async function acaoConfirmar(formulario: FormData): Promise<void> {
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  try {
    await confirmarMinha(atual.req, formulario.get("consulta"));
  } catch (erro) {
    if (erro instanceof ErroAgendamento) redirect(`/minhas-consultas?erro=${erro.codigo}`);
    throw erro;
  }
  redirect("/minhas-consultas?ok=confirmada");
}
