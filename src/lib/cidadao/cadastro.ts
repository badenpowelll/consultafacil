import { z } from "zod";
import { comMunicipio } from "@/lib/db/contexto";
import { comPermissao } from "@/lib/auth/autorizar";
import { registrarAuditoria } from "@/lib/auditoria";
import { cifrar, indiceCego } from "@/lib/security/crypto";
import { avaliarSenha, gerarHashSenha } from "@/lib/security/password";
import { cpfValido, normalizarCpf } from "@/lib/validation/documentos";
import type { Requisicao } from "@/lib/agendamento/servico";

/**
 * Autocadastro do cidadão. O cadastro nasce aguardando aprovação da unidade (residência e
 * identidade), e a resposta é a mesma exista ou não o CPF, para o formulário não servir de
 * consulta de cadastros.
 */
const esquema = z.object({
  nome: z.string().trim().min(5).max(160).regex(/^[\p{L}' .-]+$/u),
  cpf: z.string().refine((v) => cpfValido(v)),
  nascimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => {
    const d = new Date(`${v}T12:00:00Z`);
    return d.getTime() < Date.now() && d.getUTCFullYear() > 1900;
  }),
  email: z.string().trim().toLowerCase().email().max(200),
  senha: z.string().refine((s) => avaliarSenha(s) === null),
  aceite: z.literal(true),
});

export type ResultadoCadastro = { ok: true } | { ok: false; campos: string[] };

export async function cadastrarCidadao(tenantId: string, entrada: unknown): Promise<ResultadoCadastro> {
  const r = esquema.safeParse(entrada);
  if (!r.success) return { ok: false, campos: [...new Set(r.error.issues.map((i) => String(i.path[0])))] };
  const d = r.data;
  const cpf = normalizarCpf(d.cpf);
  const hash = await gerarHashSenha(d.senha);
  await comMunicipio({ tenantId, contaId: null }, async (tx) => {
    const c = await tx.query<{ conta: string | null }>("SELECT app.cidadao_autocadastro($1, $2, $3, $4, $5, $6) AS conta", [
      d.nome,
      cifrar(cpf, "pessoa.cpf"),
      indiceCego(cpf, "pessoa.cpf"),
      d.nascimento,
      cifrar(d.email, "pessoa.email"),
      hash,
    ]);
    // Auditoria sem identificar a pessoa: só que houve um pedido e se criou conta.
    await registrarAuditoria(tx, { acao: "cidadao.autocadastro", modulo: "cadastro", detalhes: { conta_criada: c.rows[0]?.conta !== null } });
  });
  return { ok: true };
}

export interface CidadaoPendente {
  vinculo_id: string;
  nome: string;
}

export async function cadastrosPendentes(req: Requisicao): Promise<CidadaoPendente[]> {
  return comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "cidadao.aprovar", qualquerUnidade: true }, async (tx) => {
    const r = await tx.query<{ vinculo_id: string; nome: string; estado: string }>("SELECT * FROM app.membros_do_municipio('cidadao')");
    return r.rows.filter((l) => l.estado === "convidado").map(({ vinculo_id, nome }) => ({ vinculo_id, nome }));
  });
}

export async function decidirCadastro(req: Requisicao, vinculoId: unknown, aprovar: boolean): Promise<void> {
  const id = z.string().uuid().parse(vinculoId);
  await comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "cidadao.aprovar", qualquerUnidade: true }, async (tx) => {
    const r = await tx.query(
      "UPDATE app.vinculo SET estado = $2 WHERE id = $1 AND papel = 'cidadao' AND estado = 'convidado'",
      [id, aprovar ? "ativo" : "revogado"],
    );
    if (r.rowCount === 1) {
      await registrarAuditoria(tx, { acao: aprovar ? "cidadao.aprovar" : "cidadao.recusar", modulo: "cadastro", objetoTipo: "vinculo", objetoId: id, ip: req.ip });
    }
  });
}
