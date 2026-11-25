import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { comConta, comMunicipio } from "@/lib/db/contexto";
import { comPermissao } from "@/lib/auth/autorizar";
import { registrarAuditoria } from "@/lib/auditoria";
import { cifrar, indiceCego } from "@/lib/security/crypto";
import { criarLinkAcao } from "@/lib/security/links";
import { avaliarSenha, gerarHashSenha } from "@/lib/security/password";
import { formatoDeTokenValido, hashDoToken } from "@/lib/security/tokens";
import { cpfValido, normalizarCpf } from "@/lib/validation/documentos";
import type { Requisicao } from "@/lib/agendamento/servico";

/**
 * Recuperação de acesso, por dois caminhos:
 *  - por e-mail: a pessoa informa o CPF e, se houver conta com e-mail neste município, recebe um
 *    link de 30 minutos. A resposta é sempre a mesma, exista o CPF ou não.
 *  - pela recepção: com documento conferido em mãos, o atendente gera um link de primeiro acesso
 *    (3 dias) para quem não tem e-mail ou foi cadastrado na unidade. Nunca para conta de equipe.
 * Os dois links são de uso único, só valem no município em que nasceram e, ao trocar a senha,
 * todas as sessões da conta caem. O token vai depois do "#" do endereço: não chega ao servidor
 * em logs de acesso nem sai em Referer.
 */
export const LIMITES_RECUPERACAO = {
  porIp: { tentativas: 10, janelaSegundos: 3600 },
  porCpf: { tentativas: 3, janelaSegundos: 3600 },
} as const;

export type FinalidadeAcesso = "recuperar_senha" | "convite";

function chaveLimite(tipo: string, valor: string): string {
  return `recuperar:${tipo}:${createHash("sha256").update(valor).digest("base64url").slice(0, 32)}`;
}

async function consumirLimite(chave: string, limite: number, janela: number): Promise<boolean> {
  return comConta(null, async (tx) => {
    const r = await tx.query<{ ok: boolean }>("SELECT app.limite_consumir($1, $2, $3) AS ok", [chave, limite, janela]);
    return r.rows[0]?.ok === true;
  });
}

export type ResultadoPedido = "enviado" | "limite";

/** Pede o link por e-mail. "enviado" não diz se havia conta: é a mesma resposta para todo CPF. */
export async function pedirRecuperacao(tenantId: string, cpfDigitado: unknown, ip: string): Promise<ResultadoPedido> {
  const cpf = normalizarCpf(typeof cpfDigitado === "string" ? cpfDigitado : "");
  const valido = cpfValido(cpf);
  const indice = valido ? indiceCego(cpf, "pessoa.cpf") : null;
  const dentroIp = await consumirLimite(chaveLimite("ip", ip), LIMITES_RECUPERACAO.porIp.tentativas, LIMITES_RECUPERACAO.porIp.janelaSegundos);
  const dentroCpf = await consumirLimite(
    chaveLimite("cpf", indice ? indice.toString("base64") : `invalido:${cpf}`),
    LIMITES_RECUPERACAO.porCpf.tentativas,
    LIMITES_RECUPERACAO.porCpf.janelaSegundos,
  );
  if (!dentroIp || !dentroCpf) return "limite";
  if (!indice) return "enviado";

  await comMunicipio({ tenantId, contaId: null }, async (tx) => {
    const r = await tx.query<{ conta_id: string; pessoa_id: string }>("SELECT * FROM app.recuperacao_conta($1)", [indice]);
    const conta = r.rows[0];
    if (conta) {
      const token = await criarLinkAcao(tx, "recuperar_senha", conta.conta_id);
      // Na fila, o token vai cifrado; sai de lá quando o envio termina (ver notificacao_concluir).
      await tx.query(
        "INSERT INTO app.notificacao (tenant_id, pessoa_id, modelo, dados) VALUES (app.tenant_atual(), $1, 'recuperar_senha', $2)",
        [conta.pessoa_id, { token_cifrado: cifrar(token, "notificacao.recuperar_senha").toString("base64") }],
      );
    }
    // Sem identificar a pessoa nem dizer se havia conta.
    await registrarAuditoria(tx, { acao: "conta.recuperacao_pedida", modulo: "cadastro", ip });
  });
  return "enviado";
}

const senhaNova = z.string().refine((s) => avaliarSenha(s) === null);

export type ResultadoRedefinicao = "ok" | "link_invalido" | "senha_fraca";

/** Troca a senha com o link. Mesma resposta para link inexistente, vencido, usado ou de outro município. */
export async function redefinirSenha(
  tenantId: string,
  finalidade: FinalidadeAcesso,
  token: unknown,
  senha: unknown,
  ip?: string | null,
): Promise<ResultadoRedefinicao> {
  if (typeof token !== "string" || !formatoDeTokenValido(token)) return "link_invalido";
  const s = senhaNova.safeParse(senha);
  if (!s.success) return "senha_fraca";
  const hash = await gerarHashSenha(s.data);
  return comMunicipio({ tenantId, contaId: null }, async (tx) => {
    const r = await tx.query<{ conta: string | null }>("SELECT app.senha_redefinir_com_link($1, $2, $3) AS conta", [
      hashDoToken(token),
      finalidade,
      hash,
    ]);
    const conta = r.rows[0]?.conta ?? null;
    if (!conta) return "link_invalido";
    await registrarAuditoria(tx, {
      acao: finalidade === "convite" ? "conta.primeiro_acesso" : "conta.senha_redefinida",
      modulo: "cadastro", objetoTipo: "conta", objetoId: conta, ip,
    });
    return "ok";
  });
}

export interface AcessoAssistido {
  token: string;
  validoAte: Date;
}

/**
 * Link de primeiro acesso entregue na recepção (impresso ou mostrado na tela, uma vez só).
 * Exige `recepcao.assistido`. A conta do cidadão precisa ser só de cidadão: o banco recusa
 * conta que tenha papel de equipe ou gestor em qualquer município.
 */
export async function gerarAcessoAssistido(req: Requisicao, vinculoId: unknown): Promise<AcessoAssistido | null> {
  const id = z.string().uuid().safeParse(vinculoId);
  if (!id.success) return null;
  return comPermissao(
    { sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "recepcao.assistido", qualquerUnidade: true },
    async (tx) => {
      const r = await tx.query<{ conta: string | null }>("SELECT app.acesso_assistido_conta($1) AS conta", [id.data]);
      const conta = r.rows[0]?.conta ?? null;
      if (!conta) return null;
      const token = await criarLinkAcao(tx, "convite", conta);
      const v = await tx.query<{ expira_em: Date }>("SELECT expira_em FROM app.token_acao WHERE token_hash = $1", [hashDoToken(token)]);
      await registrarAuditoria(tx, { acao: "conta.acesso_assistido", modulo: "recepcao", objetoTipo: "vinculo", objetoId: id.data, ip: req.ip });
      return { token, validoAte: v.rows[0]!.expira_em };
    },
  );
}

/** Senha que ninguém conhece, para a conta criada pela recepção antes do primeiro acesso. */
export async function senhaInicialDesconhecida(): Promise<string> {
  return gerarHashSenha(randomBytes(32).toString("base64url"));
}
