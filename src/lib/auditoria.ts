import type { Conexao } from "@/lib/db/pool";
import { pareceSensivel } from "@/lib/security/redacao";

/**
 * Registro de auditoria (somente inserção). Os detalhes passam por um filtro que descarta
 * qualquer chave com cara de dado pessoal, para que a auditoria não vire um vazamento.
 * Valores também são conferidos: um CPF, e-mail ou token dentro de uma chave inocente
 * ("referencia": "529.982.247-25") é descartado.
 */
export interface EventoAuditoria {
  acao: string; // ex.: "agenda.marcar", "perfil.alterar"
  modulo: string;
  objetoTipo?: string;
  objetoId?: string;
  detalhes?: Record<string, string | number | boolean | null>;
  ip?: string | null;
}

const CHAVES_PROIBIDAS = /cpf|cns|senha|token|segredo|nome|email|e_mail|telefone|celular|endereco|nascimento|mae/i;

export function filtrarDetalhes(detalhes: EventoAuditoria["detalhes"]): Record<string, string | number | boolean | null> {
  const saida: Record<string, string | number | boolean | null> = {};
  for (const [chave, valor] of Object.entries(detalhes ?? {})) {
    if (CHAVES_PROIBIDAS.test(chave)) continue;
    if (typeof valor === "string" && (valor.length > 200 || pareceSensivel(valor))) continue;
    saida[chave] = valor;
  }
  return saida;
}

/** Deve ser chamado dentro de `comMunicipio`; o município e a conta vêm do contexto da transação. */
export async function registrarAuditoria(tx: Conexao, evento: EventoAuditoria): Promise<void> {
  await tx.query(
    `INSERT INTO app.auditoria (tenant_id, conta_id, acao, modulo, objeto_tipo, objeto_id, detalhes, ip)
     VALUES (app.tenant_atual(), app.conta_atual(), $1, $2, $3, $4, $5, $6)`,
    [
      evento.acao,
      evento.modulo,
      evento.objetoTipo ?? null,
      evento.objetoId ?? null,
      JSON.stringify(filtrarDetalhes(evento.detalhes)),
      evento.ip ?? null,
    ],
  );
}
