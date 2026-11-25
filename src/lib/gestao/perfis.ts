import { z } from "zod";
import type { Conexao } from "@/lib/db/pool";
import { comPermissao, AcessoNegado } from "@/lib/auth/autorizar";
import { registrarAuditoria } from "@/lib/auditoria";
import type { Requisicao } from "@/lib/agendamento/servico";

/**
 * Perfis de acesso por setor. O gestor monta perfis (conjuntos de permissões) e atribui a cada
 * membro da equipe, numa unidade ou no município inteiro. Tudo exige `gestao.perfis` com MFA.
 * O banco recusa conceder permissão que quem está concedendo não tem (sem escalada) e
 * permissões clínicas (fora do piloto).
 */
export const SETORES = {
  agendamento: "Agendamento",
  recepcao: "Recepção",
  enfermagem: "Enfermagem",
  medicos: "Médicos",
  auxiliares: "Auxiliares",
  outros: "Outros",
} as const;
export type Setor = keyof typeof SETORES;

/** Ponto de partida de cada setor. O gestor ajusta à vontade. */
export const MODELOS_POR_SETOR: Record<Setor, string[]> = {
  agendamento: ["agenda.ver", "agenda.marcar", "agenda.desmarcar", "agenda.remarcar", "cidadao.ver", "recepcao.assistido"],
  recepcao: ["agenda.ver", "agenda.marcar", "recepcao.checkin", "recepcao.fechar_agenda", "recepcao.assistido", "cidadao.ver", "cidadao.aprovar"],
  enfermagem: ["agenda.ver", "recepcao.checkin"],
  medicos: ["agenda.ver", "recepcao.fechar_agenda"],
  auxiliares: ["agenda.ver"],
  outros: [],
};

export class ErroGestao extends Error {
  constructor(public readonly codigo: keyof typeof MENSAGENS_GESTAO) {
    super(MENSAGENS_GESTAO[codigo]);
    this.name = "ErroGestao";
  }
}

export const MENSAGENS_GESTAO = {
  dados_invalidos: "Dados inválidos.",
  nome_repetido: "Já existe um perfil com esse nome.",
  acima_do_proprio_acesso: "Você não pode conceder uma permissão que não tem.",
  permissao_clinica: "Permissões clínicas ficam fora do piloto.",
  perfil_so_para_equipe: "Perfis só podem ser dados a membros da equipe.",
  perfil_inativo: "Este perfil está desativado.",
  ja_atribuido: "Essa pessoa já tem esse perfil nessa unidade.",
  inexistente: "Não encontrado.",
  imagem_invalida: "Envie uma imagem PNG ou JPEG de até 1 MB.",
} as const;

function traduzir(erro: unknown): never {
  if (erro instanceof AcessoNegado || erro instanceof ErroGestao) throw erro;
  const msg = erro instanceof Error ? erro.message : "";
  const codigo = (erro as { code?: string }).code;
  if (msg === "concessao_acima_do_proprio_acesso") throw new ErroGestao("acima_do_proprio_acesso");
  if (msg === "permissao_clinica_fora_do_piloto") throw new ErroGestao("permissao_clinica");
  if (msg === "perfil_so_para_equipe") throw new ErroGestao("perfil_so_para_equipe");
  if (msg === "perfil_inativo") throw new ErroGestao("perfil_inativo");
  if (codigo === "23505" && /perfil_acesso_tenant_id_nome/.test(msg)) throw new ErroGestao("nome_repetido");
  if (codigo === "23505" && /vinculo_perfil_unico/.test(msg)) throw new ErroGestao("ja_atribuido");
  if (codigo === "23503" || codigo === "22P02") throw new ErroGestao("inexistente");
  throw erro;
}

function comGestaoDePerfis<T>(req: Requisicao, trabalho: (tx: Conexao) => Promise<T>): Promise<T> {
  return comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "gestao.perfis", exigeMfa: true }, trabalho).catch(traduzir);
}

const uuid = z.string().uuid();
const codigoPermissao = z.string().regex(/^[a-z]+(\.[a-z_]+)+$/);
const dadosPerfil = z.object({
  nome: z.string().trim().min(2).max(80),
  setor: z.enum(Object.keys(SETORES) as [Setor, ...Setor[]]),
  permissoes: z.array(codigoPermissao).max(60),
});

function validar<T>(esquema: z.ZodType<T>, valor: unknown): T {
  const r = esquema.safeParse(valor);
  if (!r.success) throw new ErroGestao("dados_invalidos");
  return r.data;
}

export interface PermissaoCatalogo {
  codigo: string;
  modulo: string;
  descricao: string;
}

export interface Perfil {
  id: string;
  nome: string;
  setor: Setor;
  ativo: boolean;
  permissoes: string[];
  pessoas: number;
}

export interface Membro {
  vinculo_id: string;
  nome: string;
  papel: string;
  estado: string;
}

export interface Atribuicao {
  id: string;
  vinculo_id: string;
  perfil_id: string;
  perfil: string;
  unidade_id: string | null;
  unidade: string | null;
}

export interface PainelPerfis {
  catalogo: PermissaoCatalogo[];
  perfis: Perfil[];
  membros: Membro[];
  unidades: { id: string; nome: string }[];
  atribuicoes: Atribuicao[];
}

/** Tudo o que a tela de perfis precisa, numa transação. O catálogo traz só o que quem vê pode conceder. */
export async function painelDePerfis(req: Requisicao): Promise<PainelPerfis> {
  return comGestaoDePerfis(req, async (tx) => {
    const catalogo = await tx.query<PermissaoCatalogo>(
      `SELECT p.codigo, p.modulo, p.descricao FROM app.permissao p
       WHERE NOT p.clinica AND p.codigo IN (SELECT m.codigo FROM app.minhas_permissoes(NULL) AS m(codigo))
       ORDER BY p.modulo, p.codigo`,
    );
    const perfis = await tx.query<Perfil>(
      `SELECT pa.id, pa.nome, pa.setor, pa.ativo,
              COALESCE(array_agg(pp.permissao ORDER BY pp.permissao) FILTER (WHERE pp.permissao IS NOT NULL), '{}') AS permissoes,
              (SELECT count(DISTINCT vp.vinculo_id)::int FROM app.vinculo_perfil vp WHERE vp.perfil_id = pa.id) AS pessoas
       FROM app.perfil_acesso pa
       LEFT JOIN app.perfil_permissao pp ON pp.perfil_id = pa.id
       GROUP BY pa.id ORDER BY pa.ativo DESC, pa.setor, pa.nome`,
    );
    const membros = await tx.query<Membro>(
      `SELECT * FROM app.membros_do_municipio('equipe')
       UNION ALL SELECT * FROM app.membros_do_municipio('gestor')
       ORDER BY nome`,
    );
    const unidades = await tx.query<{ id: string; nome: string }>("SELECT id, nome FROM app.unidade WHERE ativa ORDER BY nome");
    const atribuicoes = await tx.query<Atribuicao>(
      `SELECT vp.id, vp.vinculo_id, vp.perfil_id, pa.nome AS perfil, vp.unidade_id, u.nome AS unidade
       FROM app.vinculo_perfil vp
       JOIN app.perfil_acesso pa ON pa.id = vp.perfil_id
       LEFT JOIN app.unidade u ON u.id = vp.unidade_id
       ORDER BY pa.nome, u.nome NULLS FIRST`,
    );
    return { catalogo: catalogo.rows, perfis: perfis.rows, membros: membros.rows, unidades: unidades.rows, atribuicoes: atribuicoes.rows };
  });
}

async function gravarPermissoes(tx: Conexao, perfilId: string, permissoes: string[]): Promise<void> {
  await tx.query("DELETE FROM app.perfil_permissao WHERE perfil_id = $1", [perfilId]);
  for (const p of [...new Set(permissoes)]) {
    await tx.query("INSERT INTO app.perfil_permissao (tenant_id, perfil_id, permissao) VALUES (app.tenant_atual(), $1, $2)", [perfilId, p]);
  }
}

export async function criarPerfil(req: Requisicao, dados: unknown): Promise<string> {
  const d = validar(dadosPerfil, dados);
  return comGestaoDePerfis(req, async (tx) => {
    const r = await tx.query<{ id: string }>(
      "INSERT INTO app.perfil_acesso (tenant_id, nome, setor) VALUES (app.tenant_atual(), $1, $2) RETURNING id",
      [d.nome, d.setor],
    );
    const id = r.rows[0]!.id;
    await gravarPermissoes(tx, id, d.permissoes);
    await registrarAuditoria(tx, {
      acao: "perfil.criar", modulo: "gestao", objetoTipo: "perfil", objetoId: id,
      detalhes: { setor: d.setor, permissoes: d.permissoes.join(",").slice(0, 200) }, ip: req.ip,
    });
    return id;
  });
}

export async function alterarPerfil(req: Requisicao, perfilId: unknown, dados: unknown): Promise<void> {
  const id = validar(uuid, perfilId);
  const d = validar(dadosPerfil.extend({ ativo: z.boolean() }), dados);
  await comGestaoDePerfis(req, async (tx) => {
    const r = await tx.query("UPDATE app.perfil_acesso SET nome = $2, setor = $3, ativo = $4 WHERE id = $1", [id, d.nome, d.setor, d.ativo]);
    if (r.rowCount !== 1) throw new ErroGestao("inexistente");
    await gravarPermissoes(tx, id, d.permissoes);
    await registrarAuditoria(tx, {
      acao: "perfil.alterar", modulo: "gestao", objetoTipo: "perfil", objetoId: id,
      detalhes: { setor: d.setor, ativo: d.ativo, permissoes: d.permissoes.join(",").slice(0, 200) }, ip: req.ip,
    });
  });
}

export async function atribuirPerfil(req: Requisicao, dados: unknown): Promise<void> {
  const d = validar(z.object({ vinculoId: uuid, perfilId: uuid, unidadeId: uuid.nullable() }), dados);
  await comGestaoDePerfis(req, async (tx) => {
    const r = await tx.query<{ id: string }>(
      "INSERT INTO app.vinculo_perfil (tenant_id, vinculo_id, perfil_id, unidade_id) VALUES (app.tenant_atual(), $1, $2, $3) RETURNING id",
      [d.vinculoId, d.perfilId, d.unidadeId],
    );
    await registrarAuditoria(tx, {
      acao: "perfil.atribuir", modulo: "gestao", objetoTipo: "vinculo", objetoId: d.vinculoId,
      detalhes: { perfil: d.perfilId, unidade: d.unidadeId ?? "todas", atribuicao: r.rows[0]!.id }, ip: req.ip,
    });
  });
}

export async function removerAtribuicao(req: Requisicao, atribuicaoId: unknown): Promise<void> {
  const id = validar(uuid, atribuicaoId);
  await comGestaoDePerfis(req, async (tx) => {
    const r = await tx.query<{ vinculo_id: string; perfil_id: string }>(
      "DELETE FROM app.vinculo_perfil WHERE id = $1 RETURNING vinculo_id, perfil_id",
      [id],
    );
    const linha = r.rows[0];
    if (!linha) throw new ErroGestao("inexistente");
    await registrarAuditoria(tx, {
      acao: "perfil.remover", modulo: "gestao", objetoTipo: "vinculo", objetoId: linha.vinculo_id,
      detalhes: { perfil: linha.perfil_id, atribuicao: id }, ip: req.ip,
    });
  });
}
