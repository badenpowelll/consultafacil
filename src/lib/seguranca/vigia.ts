import { comConta } from "@/lib/db/contexto";
import { logInfo } from "@/lib/log";

/**
 * Vigia de segurança, rodada pelo worker a cada minuto. Não bloqueia nada sozinha (os limites
 * progressivos já fazem isso na hora): ela torna visível o que está acontecendo.
 *  - conta da equipe com volume anormal de ações em 10 minutos → registro `seguranca.volume_anormal`
 *    na auditoria do município (o gestor vê no menu Auditoria) e linha de log `alerta.seguranca`;
 *  - bloqueios progressivos recentes por tipo (login, recuperação, cadastro…) → linha de log, para
 *    alerta no Railway quando um ataque de força bruta ou de robôs começa.
 * Nada de dado pessoal: só ids, tipos e contagens.
 */
export const LIMITE_ACOES_10_MIN = 300;

export interface ResultadoVigia {
  contasAnormais: number;
  bloqueios: { tipo: string; bloqueios: number; nivel_maximo: number }[];
}

export async function vigiarSeguranca(limiteAcoes = LIMITE_ACOES_10_MIN): Promise<ResultadoVigia> {
  return comConta(null, async (tx) => {
    const v = await tx.query<{ tenant_id: string; conta_id: string; acoes: number }>(
      "SELECT tenant_id, conta_id, acoes FROM app.seguranca_volume_anormal($1)", [limiteAcoes],
    );
    for (const l of v.rows) {
      logInfo({ evento: "alerta.seguranca", motivo: "volume_anormal", tenant_id: l.tenant_id, conta_id: l.conta_id, quantidade: l.acoes });
    }
    const b = await tx.query<{ tipo: string; bloqueios: number; nivel_maximo: number }>(
      "SELECT tipo, bloqueios, nivel_maximo FROM app.seguranca_bloqueios_recentes(1)",
    );
    for (const l of b.rows) {
      logInfo({ evento: "alerta.seguranca", motivo: `bloqueio_${l.tipo}`, quantidade: l.bloqueios, codigo: `nivel_${l.nivel_maximo}` });
    }
    return { contasAnormais: v.rowCount ?? 0, bloqueios: b.rows };
  });
}
