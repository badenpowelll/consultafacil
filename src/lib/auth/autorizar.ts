import type { Conexao } from "@/lib/db/pool";
import { comMunicipio } from "@/lib/db/contexto";
import type { SessaoValida } from "@/lib/auth/sessao";

/**
 * Contrato de autorização (plano v2): sessão válida → município de atuação escolhido →
 * vínculo ativo nesse município → permissão no escopo (município ou unidade).
 * Toda verificação é refeita no servidor a cada requisição; a interface só esconde botões.
 */
export class AcessoNegado extends Error {
  constructor(public readonly motivo: "sem_sessao" | "sem_municipio" | "municipio_divergente" | "sem_mfa" | "sem_permissao") {
    super(`Acesso negado: ${motivo}`);
    this.name = "AcessoNegado";
  }
}

export interface Pedido {
  sessao: SessaoValida | null;
  /** Município resolvido pelo subdomínio da requisição. */
  tenantDaUrl: string;
  permissao: string;
  unidadeId?: string | null;
  /**
   * Mantido por compatibilidade: desde o reforço contra ataques automatizados, TODA ação da equipe
   * exige MFA verificado na sessão (senha vazada ou adivinhada por robô não basta).
   */
  exigeMfa?: boolean;
  /**
   * Para o cadastro do cidadão (que é do município, não de uma unidade): basta a permissão no
   * município ou em qualquer unidade dele. Ignora `unidadeId`.
   */
  qualquerUnidade?: boolean;
}

export async function comPermissao<T>(p: Pedido, trabalho: (tx: Conexao) => Promise<T>): Promise<T> {
  const s = p.sessao;
  if (!s) throw new AcessoNegado("sem_sessao");
  if (!s.tenantId) throw new AcessoNegado("sem_municipio");
  // A sessão atua num município; uma URL de outro município não herda essa atuação.
  if (s.tenantId !== p.tenantDaUrl) throw new AcessoNegado("municipio_divergente");
  if (!s.mfaVerificado) throw new AcessoNegado("sem_mfa");

  return comMunicipio({ tenantId: s.tenantId, contaId: s.contaId }, async (tx) => {
    const r = p.qualquerUnidade
      ? await tx.query<{ ok: boolean }>("SELECT app.pode_no_municipio($1) AS ok", [p.permissao])
      : await tx.query<{ ok: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM app.minhas_permissoes($1) AS m(codigo) WHERE m.codigo = $2) AS ok",
          [p.unidadeId ?? null, p.permissao],
        );
    if (r.rows[0]?.ok !== true) throw new AcessoNegado("sem_permissao");
    return trabalho(tx);
  });
}
