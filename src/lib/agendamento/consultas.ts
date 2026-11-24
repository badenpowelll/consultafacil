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
  if (!s?.tenantId || s.tenantId !== req.tenantDaUrl) return [];
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

/** Nomes dos pacientes de uma agenda, só para quem pode ver a agenda daquela unidade. */
export async function nomesDosPacientes(req: Requisicao, unidadeId: string, vinculos: string[]): Promise<Map<string, string>> {
  if (vinculos.length === 0) return new Map();
  return comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "agenda.ver", unidadeId }, async (tx) => {
    const r = await tx.query<{ vinculo_id: string; nome: string }>("SELECT vinculo_id, nome FROM app.nomes_de_vinculos($1)", [vinculos]);
    return new Map(r.rows.map((l) => [l.vinculo_id, l.nome]));
  });
}
