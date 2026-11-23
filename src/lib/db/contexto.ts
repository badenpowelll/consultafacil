import type { Conexao } from "@/lib/db/pool";
import { obterPool } from "@/lib/db/pool";

/**
 * Toda operação de dados municipais roda dentro de `comMunicipio`: abre uma transação,
 * fixa município e conta com set_config(..., true) (vale só para esta transação) e só então
 * executa o trabalho. Ao devolver a conexão ao pool, o contexto já não existe, então uma
 * requisição nunca herda o município de outra.
 *
 * As políticas RLS comparam tenant_id com esse contexto: sem contexto, nada é lido ou gravado.
 */
export interface ContextoMunicipal {
  tenantId: string;
  contaId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function comMunicipio<T>(ctx: ContextoMunicipal, trabalho: (tx: Conexao) => Promise<T>): Promise<T> {
  if (!UUID.test(ctx.tenantId)) throw new Error("Município inválido no contexto");
  if (ctx.contaId !== null && !UUID.test(ctx.contaId)) throw new Error("Conta inválida no contexto");
  return emTransacao(async (tx) => {
    await tx.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.conta_id', $2, true)", [
      ctx.tenantId,
      ctx.contaId ?? "",
    ]);
    return trabalho(tx);
  });
}

/** Transação sem município: só para funções globais de autenticação e sessão. */
export async function comConta<T>(contaId: string | null, trabalho: (tx: Conexao) => Promise<T>): Promise<T> {
  if (contaId !== null && !UUID.test(contaId)) throw new Error("Conta inválida no contexto");
  return emTransacao(async (tx) => {
    await tx.query("SELECT set_config('app.conta_id', $1, true)", [contaId ?? ""]);
    return trabalho(tx);
  });
}

async function emTransacao<T>(trabalho: (tx: Conexao) => Promise<T>): Promise<T> {
  const conexao = await obterPool().connect();
  try {
    await conexao.query("BEGIN");
    const resultado = await trabalho(conexao);
    await conexao.query("COMMIT");
    return resultado;
  } catch (erro) {
    await conexao.query("ROLLBACK").catch(() => undefined);
    throw erro;
  } finally {
    conexao.release();
  }
}
