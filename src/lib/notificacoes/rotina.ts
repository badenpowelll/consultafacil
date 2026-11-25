import { comConta, comMunicipio } from "@/lib/db/contexto";

/**
 * Rotinas periódicas do worker, município por município, sem sessão de pessoa:
 *   * oferece vagas livres a quem está na lista de espera (inclui as de ofertas vencidas ou
 *     recusadas e as de escalas novas);
 *   * gera o lembrete da véspera (uma vez por consulta, das 9h às 20h do município).
 * Nada aqui desmarca consulta: falta de resposta nunca tira a vaga de ninguém.
 */
export async function executarRotinas(): Promise<{ ofertas: number; lembretes: number }> {
  const municipios = await comConta(null, async (tx) =>
    (await tx.query<{ tenant_id: string }>("SELECT tenant_id FROM app.municipios_para_rotina()")).rows.map((l) => l.tenant_id),
  );
  const total = { ofertas: 0, lembretes: 0 };
  for (const tenantId of municipios) {
    try {
      const r = await comMunicipio({ tenantId, contaId: null }, async (tx) => {
        const o = await tx.query<{ n: number }>("SELECT app.espera_distribuir(100) AS n");
        const l = await tx.query<{ n: number }>("SELECT app.lembretes_gerar() AS n");
        return { ofertas: o.rows[0]!.n, lembretes: l.rows[0]!.n };
      });
      total.ofertas += r.ofertas;
      total.lembretes += r.lembretes;
    } catch {
      // Um município com problema não impede os outros; sem detalhes no log.
      console.error(`rotina do município ${tenantId}: falhou, nova tentativa no próximo ciclo`);
    }
  }
  return total;
}
