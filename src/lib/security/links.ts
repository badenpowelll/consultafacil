import type { Conexao } from "@/lib/db/pool";
import { formatoDeTokenValido, gerarTokenOpaco, hashDoToken } from "@/lib/security/tokens";

/**
 * Links de ação enviados por e-mail. São credenciais ao portador, então:
 *  - o token tem 256 bits e só o SHA-256 fica no banco;
 *  - prazo curto por finalidade (o banco impõe um teto, ver migração 0005);
 *  - uso único, atômico (UPDATE ... WHERE usado_em IS NULL);
 *  - preso ao município: o RLS impede usar um link de A no subdomínio de B;
 *  - toda falha (inexistente, vencido, usado, outra finalidade, outro município) devolve o
 *    mesmo `null`, para que o link não sirva de oráculo;
 *  - a página que recebe o token não envia Referer nem é guardada em cache.
 * Devem ser chamados dentro de `comMunicipio`.
 */
export type FinalidadeLink =
  | "convite" | "verificar_contato" | "recuperar_senha" | "confirmar" | "cancelar" | "checkin" | "documento";

export const PRAZO_MINUTOS: Record<FinalidadeLink, number> = {
  recuperar_senha: 30,
  verificar_contato: 60,
  documento: 15,
  checkin: 12 * 60,
  confirmar: 48 * 60,
  cancelar: 7 * 24 * 60,
  convite: 3 * 24 * 60,
};

export async function criarLinkAcao(tx: Conexao, finalidade: FinalidadeLink, objetoId: string): Promise<string> {
  const token = gerarTokenOpaco();
  await tx.query(
    `INSERT INTO app.token_acao (tenant_id, finalidade, objeto_id, token_hash, expira_em)
     VALUES (app.tenant_atual(), $1, $2, $3, now() + make_interval(mins => $4))`,
    [finalidade, objetoId, hashDoToken(token), PRAZO_MINUTOS[finalidade]],
  );
  return token;
}

export async function consumirLinkAcao(tx: Conexao, finalidade: FinalidadeLink, token: string): Promise<string | null> {
  if (!formatoDeTokenValido(token)) return null;
  const r = await tx.query<{ objeto_id: string }>(
    `UPDATE app.token_acao SET usado_em = now()
     WHERE token_hash = $1 AND finalidade = $2 AND usado_em IS NULL AND expira_em > now()
     RETURNING objeto_id`,
    [hashDoToken(token), finalidade],
  );
  return r.rows[0]?.objeto_id ?? null;
}

/**
 * Para a página aberta pelo link: o token está na URL, então ela não pode vazar por
 * Referer para recursos externos nem ficar em cache compartilhado. Depois de consumir o
 * token, redirecione para uma URL sem ele.
 */
export const CABECALHOS_PAGINA_COM_TOKEN = {
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store, private, max-age=0",
} as const;
