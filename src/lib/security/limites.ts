import { createHash } from "node:crypto";
import { comConta } from "@/lib/db/contexto";

/**
 * Limites de volume por conta para operações que, repetidas, viram vazamento em massa:
 * buscar cidadão por CPF (enumeração), exportar (extração da base), revelar documento
 * completo (consulta abusiva por servidor). A sessão válida não basta: um servidor
 * legítimo com a conta comprometida, ou mal-intencionado, ainda esbarra no teto.
 *
 * Usa a mesma tabela e função do limite de login (`app.limite_consumir`, janela fixa).
 */
export const POLITICAS = {
  buscaCidadao: { tentativas: 60, janelaSegundos: 60 * 60 },
  exportacao: { tentativas: 5, janelaSegundos: 60 * 60 },
  revelarDocumento: { tentativas: 20, janelaSegundos: 24 * 60 * 60 },
  recuperarSenhaIp: { tentativas: 10, janelaSegundos: 60 * 60 },
  recuperarSenhaCpf: { tentativas: 3, janelaSegundos: 60 * 60 },
} as const;

export type Politica = keyof typeof POLITICAS;

export class LimiteExcedido extends Error {
  constructor(public readonly politica: Politica) {
    super(`Limite excedido: ${politica}`);
    this.name = "LimiteExcedido";
  }
}

/** A chave nunca carrega o identificador em claro (CPF, IP): só um resumo truncado. */
export function chaveLimite(politica: Politica, identificador: string): string {
  return `${politica}:${createHash("sha256").update(identificador).digest("base64url").slice(0, 32)}`;
}

export async function consumirLimite(politica: Politica, identificador: string): Promise<boolean> {
  const { tentativas, janelaSegundos } = POLITICAS[politica];
  return comConta(null, async (tx) => {
    const r = await tx.query<{ ok: boolean }>("SELECT app.limite_consumir($1, $2, $3) AS ok", [
      chaveLimite(politica, identificador),
      tentativas,
      janelaSegundos,
    ]);
    return r.rows[0]?.ok === true;
  });
}

export async function exigirLimite(politica: Politica, identificador: string): Promise<void> {
  if (!(await consumirLimite(politica, identificador))) throw new LimiteExcedido(politica);
}
