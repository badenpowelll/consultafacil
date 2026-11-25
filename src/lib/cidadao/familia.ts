import { z } from "zod";
import type { Conexao } from "@/lib/db/pool";
import { comMunicipio } from "@/lib/db/contexto";
import { AcessoNegado, comPermissao } from "@/lib/auth/autorizar";
import { registrarAuditoria } from "@/lib/auditoria";
import { cifrar, indiceCego } from "@/lib/security/crypto";
import { cpfValido, normalizarCpf } from "@/lib/validation/documentos";
import type { Requisicao } from "@/lib/agendamento/servico";

/**
 * Dependentes: crianças e pessoas sob cuidado, sem conta própria, que o titular agenda.
 * O titular pede e a unidade confere o documento (certidão, termo de guarda ou curatela) antes
 * de aprovar; a recepção, com o documento em mãos, já inclui aprovado. O banco garante que só
 * a equipe aprova e que a consulta de dependente é só do dependente ativo do próprio titular.
 */
export const PARENTESCOS = {
  filho: "Filho ou filha",
  enteado: "Enteado ou enteada",
  neto: "Neto ou neta",
  tutelado: "Sob tutela ou guarda",
  curatelado: "Sob curatela",
  outro: "Outro (a unidade confere)",
} as const;
export type Parentesco = keyof typeof PARENTESCOS;

export const MENSAGENS_FAMILIA = {
  dados_invalidos: "Confira os dados: nome completo, CPF válido, data de nascimento e como você chama a pessoa.",
  limite_dependentes: "Você já tem o número máximo de dependentes. Procure a unidade de saúde.",
  dependente_invalido: "Essa pessoa não pode ser incluída como sua dependente.",
  titular_invalido: "O cadastro do titular não está ativo neste município.",
  sem_vinculo_cidadao: "Seu cadastro neste município ainda não está ativo.",
  inexistente: "Dependente não encontrado.",
  transicao_invalida: "Esse pedido já foi decidido.",
} as const;
export type CodigoFamilia = keyof typeof MENSAGENS_FAMILIA;

export class ErroFamilia extends Error {
  constructor(public readonly codigo: CodigoFamilia) {
    super(MENSAGENS_FAMILIA[codigo]);
    this.name = "ErroFamilia";
  }
}

function traduzir(erro: unknown): never {
  const msg = erro instanceof Error ? erro.message : "";
  if (msg in MENSAGENS_FAMILIA) throw new ErroFamilia(msg as CodigoFamilia);
  if (msg === "sem_permissao") throw new AcessoNegado("sem_permissao");
  throw erro;
}

const esquemaDependente = z.object({
  nome: z.string().trim().min(5).max(160).regex(/^[\p{L}' .-]+$/u),
  cpf: z.string().refine((v) => cpfValido(v)),
  nascimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => {
    const d = new Date(`${v}T12:00:00Z`);
    return d.getTime() < Date.now() && d.getUTCFullYear() > 1900;
  }),
  nomeCurto: z.string().trim().min(2).max(40).regex(/^[\p{L}' .-]+$/u),
  parentesco: z.enum(Object.keys(PARENTESCOS) as [Parentesco, ...Parentesco[]]),
});

async function solicitar(tx: Conexao, titularVinculo: string, entrada: unknown): Promise<string> {
  const r = esquemaDependente.safeParse(entrada);
  if (!r.success) throw new ErroFamilia("dados_invalidos");
  const d = r.data;
  const cpf = normalizarCpf(d.cpf);
  try {
    const q = await tx.query<{ id: string }>("SELECT app.dependente_solicitar($1, $2, $3, $4, $5, $6, $7) AS id", [
      titularVinculo, d.nome, cifrar(cpf, "pessoa.cpf"), indiceCego(cpf, "pessoa.cpf"), d.nascimento, d.nomeCurto, d.parentesco,
    ]);
    return q.rows[0]!.id;
  } catch (e) {
    return traduzir(e);
  }
}

/** Vínculo de cidadão ativo de quem está na sessão, no município da URL. */
async function comoTitular<T>(req: Requisicao, trabalho: (tx: Conexao, vinculoId: string) => Promise<T>): Promise<T> {
  const s = req.sessao;
  if (!s) throw new AcessoNegado("sem_sessao");
  if (!s.tenantId) throw new AcessoNegado("sem_municipio");
  if (s.tenantId !== req.tenantDaUrl) throw new AcessoNegado("municipio_divergente");
  return comMunicipio({ tenantId: s.tenantId, contaId: s.contaId }, async (tx) => {
    const v = await tx.query<{ id: string }>(
      "SELECT id FROM app.vinculo WHERE conta_id = app.conta_atual() AND papel = 'cidadao' AND estado = 'ativo'",
    );
    const id = v.rows[0]?.id;
    if (!id) throw new ErroFamilia("sem_vinculo_cidadao");
    return trabalho(tx, id);
  });
}

// ------------------------------------------------------------------ titular
export interface MeuDependente {
  id: string;
  nome_curto: string;
  parentesco: Parentesco;
  estado: "pendente" | "ativo";
}

export async function meusDependentes(req: Requisicao): Promise<MeuDependente[]> {
  return comoTitular(req, async (tx, vinculo) => {
    const r = await tx.query<MeuDependente>(
      `SELECT id, nome_curto, parentesco, estado FROM app.dependente
       WHERE titular_vinculo_id = $1 AND estado IN ('pendente', 'ativo') ORDER BY criado_em`,
      [vinculo],
    );
    return r.rows;
  });
}

/** O titular pede a inclusão; fica pendente até a unidade conferir o documento. */
export async function pedirDependente(req: Requisicao, entrada: unknown): Promise<void> {
  await comoTitular(req, async (tx, vinculo) => {
    const id = await solicitar(tx, vinculo, entrada);
    await registrarAuditoria(tx, { acao: "dependente.pedir", modulo: "cadastro", objetoTipo: "dependente", objetoId: id, ip: req.ip });
  });
}

/** O titular tira um dependente (ou desiste do pedido). As consultas já marcadas continuam. */
export async function encerrarDependente(req: Requisicao, dependenteId: unknown): Promise<void> {
  const id = z.string().uuid().safeParse(dependenteId);
  if (!id.success) throw new ErroFamilia("inexistente");
  await comoTitular(req, async (tx, vinculo) => {
    const r = await tx.query(
      "UPDATE app.dependente SET estado = 'encerrado' WHERE id = $1 AND titular_vinculo_id = $2 AND estado IN ('pendente', 'ativo')",
      [id.data, vinculo],
    );
    if (r.rowCount !== 1) throw new ErroFamilia("inexistente");
    await registrarAuditoria(tx, { acao: "dependente.encerrar", modulo: "cadastro", objetoTipo: "dependente", objetoId: id.data, ip: req.ip });
  });
}

// ------------------------------------------------------------------ equipe
export interface DependenteParaConferir {
  id: string;
  titular_vinculo_id: string;
  titular: string;
  nome: string;
  nome_curto: string;
  parentesco: Parentesco;
  nascimento: Date | null;
  tem_conta: boolean;
  criado_em: Date;
}

export async function dependentesParaConferir(req: Requisicao): Promise<DependenteParaConferir[]> {
  return comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "cidadao.aprovar", qualquerUnidade: true }, async (tx) =>
    (await tx.query<DependenteParaConferir>("SELECT * FROM app.dependentes_para_conferir()")).rows,
  );
}

export async function decidirDependente(req: Requisicao, dependenteId: unknown, aprovar: boolean): Promise<void> {
  const id = z.string().uuid().safeParse(dependenteId);
  if (!id.success) throw new ErroFamilia("inexistente");
  await comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "cidadao.aprovar", qualquerUnidade: true }, async (tx) => {
    try {
      const r = await tx.query("UPDATE app.dependente SET estado = $2 WHERE id = $1 AND estado = 'pendente'", [
        id.data,
        aprovar ? "ativo" : "recusado",
      ]);
      if (r.rowCount !== 1) throw new ErroFamilia("transicao_invalida");
    } catch (e) {
      if (e instanceof ErroFamilia) throw e;
      traduzir(e);
    }
    await registrarAuditoria(tx, {
      acao: aprovar ? "dependente.aprovar" : "dependente.recusar", modulo: "cadastro", objetoTipo: "dependente", objetoId: id.data, ip: req.ip,
    });
  });
}

export interface DependenteNaFicha {
  id: string;
  nome: string;
  nome_curto: string;
  parentesco: Parentesco;
  nascimento: Date | null;
  estado: "pendente" | "ativo";
}

export async function dependentesDoCidadao(req: Requisicao, titularVinculo: unknown): Promise<DependenteNaFicha[]> {
  const id = z.string().uuid().safeParse(titularVinculo);
  if (!id.success) return [];
  return comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "cidadao.ver", qualquerUnidade: true }, async (tx) =>
    (await tx.query<DependenteNaFicha>("SELECT * FROM app.dependentes_do_titular($1)", [id.data])).rows,
  );
}

/** Na recepção, com o documento conferido: o dependente já entra aprovado. */
export async function incluirDependenteAssistido(req: Requisicao, titularVinculo: unknown, entrada: unknown): Promise<string> {
  const titular = z.string().uuid().safeParse(titularVinculo);
  if (!titular.success) throw new ErroFamilia("titular_invalido");
  return comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "recepcao.assistido", qualquerUnidade: true }, async (tx) => {
    const id = await solicitar(tx, titular.data, entrada);
    await registrarAuditoria(tx, { acao: "dependente.incluir_assistido", modulo: "recepcao", objetoTipo: "dependente", objetoId: id, ip: req.ip });
    return id;
  });
}
