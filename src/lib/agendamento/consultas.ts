import { comPermissao } from "@/lib/auth/autorizar";
import { comMunicipio } from "@/lib/db/contexto";
import type { Requisicao } from "@/lib/agendamento/servico";

/** Listas de apoio das telas de equipe e gestão. */
export interface Opcao {
  id: string;
  nome: string;
}

/** Unidades onde a conta tem a permissão. minhas_permissoes já exige vínculo e município ativos. */
export async function unidadesComPermissao(req: Requisicao, permissao: string): Promise<Opcao[]> {
  const s = req.sessao;
  if (!s?.tenantId || s.tenantId !== req.tenantDaUrl || !s.mfaVerificado) return [];
  return comMunicipio({ tenantId: s.tenantId, contaId: s.contaId }, async (tx) =>
    (await tx.query<Opcao>(
      `SELECT u.id, u.nome FROM app.unidade u
       WHERE u.ativa AND EXISTS (SELECT 1 FROM app.minhas_permissoes(u.id) AS m(codigo) WHERE m.codigo = $1)
       ORDER BY u.nome`,
      [permissao],
    )).rows,
  );
}

export async function profissionaisAtivos(req: Requisicao): Promise<(Opcao & { especialidade: string })[]> {
  return comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "agenda.ver" }, async (tx) =>
    (await tx.query<Opcao & { especialidade: string }>(
      "SELECT id, nome_exibicao AS nome, especialidade FROM app.profissional WHERE ativo ORDER BY nome_exibicao",
    )).rows,
  );
}

export async function equipeSemCadastroProfissional(req: Requisicao): Promise<Opcao[]> {
  return comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "gestao.profissionais" }, async (tx) =>
    (await tx.query<Opcao>(
      `SELECT m.vinculo_id AS id, m.nome FROM app.membros_do_municipio('equipe') m
       WHERE m.estado = 'ativo' AND NOT EXISTS (SELECT 1 FROM app.profissional p WHERE p.vinculo_id = m.vinculo_id)`,
    )).rows,
  );
}

/**
 * Nome de quem é atendido em cada consulta (o titular ou o dependente), só para quem pode ver a
 * agenda daquela unidade. O banco confere de novo a permissão.
 */
export async function nomesDosPacientes(req: Requisicao, unidadeId: string, agendamentos: string[]): Promise<Map<string, string>> {
  if (agendamentos.length === 0) return new Map();
  return comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "agenda.ver", unidadeId }, async (tx) => {
    const r = await tx.query<{ agendamento_id: string; nome: string; dependente: boolean }>(
      "SELECT agendamento_id, nome, dependente FROM app.nomes_de_pacientes($1)",
      [agendamentos],
    );
    return new Map(r.rows.map((l) => [l.agendamento_id, l.dependente ? `${l.nome} (dependente)` : l.nome]));
  });
}
