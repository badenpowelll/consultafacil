import { z } from "zod";
import { AcessoNegado, comPermissao } from "@/lib/auth/autorizar";
import { registrarAuditoria } from "@/lib/auditoria";
import { senhaInicialDesconhecida } from "@/lib/auth/recuperacao";
import { cifrar, indiceCego } from "@/lib/security/crypto";
import { cpfValido, normalizarCpf } from "@/lib/validation/documentos";
import type { Requisicao } from "@/lib/agendamento/servico";

/**
 * Recepção: busca de cidadão e cadastro assistido, para quem não tem e-mail nem smartphone.
 * O cadastro feito aqui nasce ativo (documento com foto e comprovante conferidos no balcão) e
 * registra que o atendente leu os termos para o cidadão, que concordou.
 */
export const VERSAO_TERMOS = "2026-11";

export interface CidadaoEncontrado {
  vinculo_id: string;
  nome: string;
  nascimento: Date | null;
  estado: string;
  dependentes: number;
}

export type BuscaCidadao = { cpf: string } | { nome: string };

/** Busca por CPF completo (exata) ou parte do nome (mínimo 3 letras). Exige `cidadao.ver`. */
export async function buscarCidadaos(req: Requisicao, termo: unknown): Promise<CidadaoEncontrado[]> {
  const texto = typeof termo === "string" ? termo.trim().slice(0, 160) : "";
  const digitos = texto.replace(/\D/g, "");
  const porCpf = digitos.length === 11 && /^[\d.\s-]+$/.test(texto);
  if (porCpf && !cpfValido(digitos)) return [];
  if (!porCpf && texto.length < 3) return [];
  return comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "cidadao.ver", qualquerUnidade: true }, async (tx) => {
    const r = await tx.query<CidadaoEncontrado>("SELECT * FROM app.cidadaos_buscar($1, $2)", [
      porCpf ? indiceCego(normalizarCpf(digitos), "pessoa.cpf") : null,
      porCpf ? null : texto,
    ]);
    // Registra a busca sem o termo (que pode ser nome ou CPF).
    await registrarAuditoria(tx, { acao: "cidadao.buscar", modulo: "recepcao", detalhes: { por: porCpf ? "cpf" : "nome", resultados: r.rows.length }, ip: req.ip });
    return r.rows;
  });
}

export interface FichaCidadao {
  vinculo_id: string;
  nome: string;
  estado: string;
}

export async function fichaDoCidadao(req: Requisicao, vinculoId: unknown): Promise<FichaCidadao | null> {
  const id = z.string().uuid().safeParse(vinculoId);
  if (!id.success) return null;
  return comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "cidadao.ver", qualquerUnidade: true }, async (tx) => {
    const v = await tx.query<{ estado: string }>("SELECT estado FROM app.vinculo WHERE id = $1 AND papel = 'cidadao'", [id.data]);
    if (!v.rows[0]) return null;
    const n = await tx.query<{ nome: string }>("SELECT nome FROM app.nomes_de_vinculos(ARRAY[$1]::uuid[])", [id.data]);
    return { vinculo_id: id.data, nome: n.rows[0]?.nome ?? "", estado: v.rows[0].estado };
  });
}

const esquemaAssistido = z.object({
  nome: z.string().trim().min(5).max(160).regex(/^[\p{L}' .-]+$/u),
  cpf: z.string().refine((v) => cpfValido(v)),
  nascimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => {
    const d = new Date(`${v}T12:00:00Z`);
    return d.getTime() < Date.now() && d.getUTCFullYear() > 1900;
  }),
  email: z.union([z.literal(""), z.string().trim().toLowerCase().email().max(200)]).optional(),
  aceite: z.literal(true),
});

export type ResultadoAssistido =
  | { ok: true; vinculoId: string; situacao: "novo" | "aprovado" | "ja_cadastrado" }
  | { ok: false; campos: string[] }
  | { ok: false; bloqueado: true };

export async function cadastrarAssistido(req: Requisicao, entrada: unknown): Promise<ResultadoAssistido> {
  const r = esquemaAssistido.safeParse(entrada);
  if (!r.success) return { ok: false, campos: [...new Set(r.error.issues.map((i) => String(i.path[0])))] };
  const d = r.data;
  const cpf = normalizarCpf(d.cpf);
  const senha = await senhaInicialDesconhecida();
  return comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "recepcao.assistido", qualquerUnidade: true }, async (tx) => {
    let linha: { vinculo_id: string; situacao: "novo" | "aprovado" | "ja_cadastrado" } | undefined;
    try {
      await tx.query("SAVEPOINT assistido");
      linha = (
        await tx.query<{ vinculo_id: string; situacao: "novo" | "aprovado" | "ja_cadastrado" }>(
          "SELECT * FROM app.cidadao_cadastro_assistido($1, $2, $3, $4, $5, $6)",
          [d.nome, cifrar(cpf, "pessoa.cpf"), indiceCego(cpf, "pessoa.cpf"), d.nascimento, d.email ? cifrar(d.email, "pessoa.email") : null, senha],
        )
      ).rows[0];
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (msg === "cidadao_bloqueado") {
        await tx.query("ROLLBACK TO SAVEPOINT assistido");
        await registrarAuditoria(tx, { acao: "cidadao.cadastro_assistido_recusado", modulo: "recepcao", ip: req.ip });
        return { ok: false, bloqueado: true } as const;
      }
      if (msg === "sem_permissao") throw new AcessoNegado("sem_permissao");
      throw e;
    }
    const l = linha!;
    await registrarAuditoria(tx, {
      acao: "cidadao.cadastro_assistido", modulo: "recepcao", objetoTipo: "vinculo", objetoId: l.vinculo_id,
      detalhes: { situacao: l.situacao, com_email: !!d.email, termos: VERSAO_TERMOS }, ip: req.ip,
    });
    return { ok: true, vinculoId: l.vinculo_id, situacao: l.situacao };
  });
}
