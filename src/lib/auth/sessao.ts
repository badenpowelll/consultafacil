import { env } from "@/lib/env";
import { comConta } from "@/lib/db/contexto";
import { formatoDeTokenValido, gerarTokenOpaco, hashDoToken } from "@/lib/security/tokens";

/**
 * Sessões opacas e revogáveis. O cookie leva 32 bytes aleatórios; o banco guarda só o SHA-256.
 * Quem lê o banco não consegue montar um cookie válido, e revogar é uma escrita, sem esperar
 * um JWT expirar.
 */
export const COOKIE_SESSAO = "__Host-cf_sessao";

/** __Host-: exige Secure, Path=/ e proíbe Domain, então um subdomínio não sobrescreve o cookie. */
export function opcoesCookieSessao() {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: env().CF_SESSAO_ABSOLUTA_H * 3600,
  };
}

export interface SessaoValida {
  contaId: string;
  tenantId: string | null;
  mfaVerificado: boolean;
  superAdmin: boolean;
}

export async function criarSessao(contaId: string, mfaVerificado: boolean): Promise<string> {
  const token = gerarTokenOpaco();
  const expira = new Date(Date.now() + env().CF_SESSAO_ABSOLUTA_H * 3600 * 1000);
  await comConta(contaId, (tx) =>
    tx.query("SELECT app.sessao_criar($1, $2, $3, $4)", [hashDoToken(token), contaId, expira, mfaVerificado]),
  );
  return token;
}

export async function validarSessao(token: string | undefined): Promise<SessaoValida | null> {
  if (!token || !formatoDeTokenValido(token)) return null;
  const linhas = await comConta(null, async (tx) => {
    const r = await tx.query<{ conta_id: string; tenant_id: string | null; mfa_verificado: boolean; super_admin: boolean }>(
      "SELECT * FROM app.sessao_validar($1, $2)",
      [hashDoToken(token), env().CF_SESSAO_OCIOSA_MIN * 60],
    );
    return r.rows;
  });
  const s = linhas[0];
  if (!s) return null;
  return { contaId: s.conta_id, tenantId: s.tenant_id, mfaVerificado: s.mfa_verificado, superAdmin: s.super_admin };
}

export async function revogarSessao(token: string, motivo: string): Promise<void> {
  if (!formatoDeTokenValido(token)) return;
  await comConta(null, (tx) => tx.query("SELECT app.sessao_revogar($1, $2)", [hashDoToken(token), motivo]));
}

export async function revogarTodasDaConta(contaId: string, motivo: string): Promise<number> {
  return comConta(contaId, async (tx) => {
    const r = await tx.query<{ n: number }>("SELECT app.sessao_revogar_conta($1, $2) AS n", [contaId, motivo]);
    return r.rows[0]?.n ?? 0;
  });
}

/**
 * Rotação: depois do login completo (senha + MFA) o identificador muda, para que um
 * identificador fixado antes da autenticação nunca vire sessão autenticada.
 */
export async function rotacionarSessao(tokenAtual: string, contaId: string, mfaVerificado: boolean): Promise<string> {
  await revogarSessao(tokenAtual, "rotacao");
  return criarSessao(contaId, mfaVerificado);
}

export async function marcarMfaVerificado(token: string): Promise<void> {
  if (!formatoDeTokenValido(token)) return;
  await comConta(null, (tx) => tx.query("SELECT app.sessao_marcar_mfa($1)", [hashDoToken(token)]));
}

/** Escolha do município de atuação. O banco confere vínculo ativo e município ativo. */
export async function definirMunicipio(token: string, tenantId: string): Promise<boolean> {
  if (!formatoDeTokenValido(token)) return false;
  return comConta(null, async (tx) => {
    const r = await tx.query<{ ok: boolean }>("SELECT app.sessao_definir_municipio($1, $2) AS ok", [
      hashDoToken(token),
      tenantId,
    ]);
    return r.rows[0]?.ok === true;
  });
}
