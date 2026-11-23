"use server";

import { redirect } from "next/navigation";
import { cadastrarProfissional, criarEscala, registrarAusencia } from "@/lib/agendamento/servico";
import { ErroAgendamento } from "@/lib/agendamento/erros";
import { AcessoNegado } from "@/lib/auth/autorizar";
import { requisicaoAtual } from "@/lib/web/requisicao";

async function executar(acao: (req: NonNullable<Awaited<ReturnType<typeof requisicaoAtual>>>["req"]) => Promise<string>): Promise<never> {
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  let destino: string;
  try {
    destino = await acao(atual.req);
  } catch (erro) {
    if (erro instanceof ErroAgendamento) redirect(`/equipe/escalas?erro=${erro.codigo}`);
    if (erro instanceof AcessoNegado) redirect(`/equipe/escalas?erro=${erro.motivo}`);
    throw erro;
  }
  redirect(destino);
}

export async function acaoProfissional(f: FormData) {
  await executar(async (req) => {
    await cadastrarProfissional(req, {
      vinculoId: f.get("vinculo"),
      nomeExibicao: f.get("nome"),
      especialidade: f.get("especialidade"),
      registro: String(f.get("registro") ?? "").trim() || undefined,
    });
    return "/equipe/escalas?ok=profissional";
  });
}

export async function acaoEscala(f: FormData) {
  await executar(async (req) => {
    const dias = f.getAll("dia").map(Number);
    let criadas = 0;
    let conflitos = 0;
    for (const diaSemana of dias) {
      const r = await criarEscala(req, {
        profissionalId: f.get("profissional"),
        unidadeId: f.get("unidade"),
        diaSemana,
        horaInicio: f.get("inicio"),
        horaFim: f.get("fim"),
        duracaoMin: Number(f.get("duracao")),
        vigenciaInicio: f.get("vigencia_inicio"),
        vigenciaFim: String(f.get("vigencia_fim") ?? "") || undefined,
        gerarAte: f.get("gerar_ate"),
      });
      criadas += r.criadas;
      conflitos += r.conflitos;
    }
    return `/equipe/escalas?ok=escala&criadas=${criadas}&conflitos=${conflitos}`;
  });
}

export async function acaoAusencia(f: FormData) {
  await executar(async (req) => {
    const n = await registrarAusencia(req, {
      profissionalId: f.get("profissional"),
      unidadeId: f.get("unidade"),
      inicio: `${f.get("inicio")}:00-03:00`,
      fim: `${f.get("fim")}:00-03:00`,
      motivo: f.get("motivo"),
    });
    return `/equipe/escalas?ok=ausencia&afetadas=${n}`;
  });
}
