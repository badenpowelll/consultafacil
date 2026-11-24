import { comConta, comMunicipio } from "@/lib/db/contexto";
import { env } from "@/lib/env";
import { decifrar } from "@/lib/security/crypto";
import { montarMensagem, type DadosConsulta, type Modelo } from "@/lib/notificacoes/modelos";
import type { Transporte } from "@/lib/notificacoes/transporte";

/**
 * Processa a fila de notificações. Reserva um lote (SKIP LOCKED: vários workers não pegam a mesma),
 * busca os dados da consulta no contexto do município da notificação e envia.
 * Falha temporária volta para a fila com espera crescente; após 5 tentativas fica como "falhou".
 */
interface ItemFila {
  id: string;
  tenant_id: string;
  modelo: Modelo;
  dados: { agendamento_id?: string; pela_unidade?: boolean };
  email_cifrado: Buffer | null;
  pessoa_id: string;
}

async function concluir(id: string, estado: "enviada" | "falhou" | "sem_contato"): Promise<void> {
  await comConta(null, (tx) => tx.query("SELECT app.notificacao_concluir($1, $2)", [id, estado]));
}

async function dadosDaConsulta(tenantId: string, agendamentoId: string): Promise<Omit<DadosConsulta, "pelaUnidade"> | null> {
  return comMunicipio({ tenantId, contaId: null }, async (tx) => {
    const r = await tx.query<{ municipio: string; slug: string; fuso: string; unidade: string; profissional: string; especialidade: string; inicio: Date }>(
      `SELECT t.nome AS municipio, t.slug, t.fuso, u.nome AS unidade, p.nome_exibicao AS profissional, p.especialidade,
              lower(v.periodo) AS inicio
       FROM app.agendamento a
       JOIN app.vaga v ON v.id = a.vaga_id
       JOIN app.unidade u ON u.id = v.unidade_id
       JOIN app.profissional p ON p.id = v.profissional_id
       JOIN app.tenant t ON t.id = a.tenant_id
       WHERE a.id = $1`,
      [agendamentoId],
    );
    const l = r.rows[0];
    if (!l) return null;
    return { ...l, link: `https://${l.slug}.${env().CF_DOMINIO_BASE}/minhas-consultas` };
  });
}

export async function processarLote(transporte: Transporte, limite = 20): Promise<{ enviadas: number; falhas: number; semContato: number }> {
  const lote = await comConta(null, async (tx) => (await tx.query<ItemFila>("SELECT * FROM app.notificacao_reservar_lote($1)", [limite])).rows);
  const totais = { enviadas: 0, falhas: 0, semContato: 0 };
  for (const item of lote) {
    try {
      if (!item.email_cifrado) {
        await concluir(item.id, "sem_contato");
        totais.semContato++;
        continue;
      }
      const consulta = item.dados.agendamento_id ? await dadosDaConsulta(item.tenant_id, item.dados.agendamento_id) : null;
      if (!consulta) {
        await concluir(item.id, "falhou");
        totais.falhas++;
        continue;
      }
      const destino = decifrar(item.email_cifrado, "pessoa.email");
      await transporte.enviar(destino, montarMensagem(item.modelo, { ...consulta, pelaUnidade: item.dados.pela_unidade }));
      await concluir(item.id, "enviada");
      totais.enviadas++;
    } catch {
      // Sem detalhes no log: a mensagem do erro pode conter o endereço.
      console.error(`notificação ${item.id}: falha no envio, nova tentativa programada`);
      await concluir(item.id, "falhou");
      totais.falhas++;
    }
  }
  return totais;
}
