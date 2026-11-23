"use server";

import { redirect } from "next/navigation";
import { desmarcarPelaUnidade, marcarParaCidadao, registrarSituacao } from "@/lib/agendamento/servico";
import { ErroAgendamento } from "@/lib/agendamento/erros";
import { AcessoNegado } from "@/lib/auth/autorizar";
import { requisicaoAtual } from "@/lib/web/requisicao";

function voltar(formulario: FormData, extra: string): never {
  const u = String(formulario.get("unidade") ?? "");
  const d = String(formulario.get("dia") ?? "");
  redirect(`/equipe/agenda?unidade=${encodeURIComponent(u)}&dia=${encodeURIComponent(d)}&${extra}`);
}

async function executar(formulario: FormData, acao: (req: NonNullable<Awaited<ReturnType<typeof requisicaoAtual>>>["req"]) => Promise<unknown>) {
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  try {
    await acao(atual.req);
  } catch (erro) {
    if (erro instanceof ErroAgendamento) voltar(formulario, `erro=${erro.codigo}`);
    if (erro instanceof AcessoNegado) voltar(formulario, "erro=sem_permissao");
    throw erro;
  }
  voltar(formulario, "ok=1");
}

export async function acaoSituacao(f: FormData) {
  await executar(f, (req) => registrarSituacao(req, f.get("consulta"), f.get("estado")));
}

export async function acaoDesmarcarUnidade(f: FormData) {
  await executar(f, (req) => desmarcarPelaUnidade(req, f.get("consulta"), f.get("motivo")));
}

export async function acaoMarcarParaCidadao(f: FormData) {
  await executar(f, (req) => marcarParaCidadao(req, f.get("vaga"), f.get("cidadao")));
}
