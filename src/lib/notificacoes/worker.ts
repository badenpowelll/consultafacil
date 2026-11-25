import { comConta, comMunicipio } from "@/lib/db/contexto";
import { decifrar } from "@/lib/security/crypto";
import {
  montarMensagem, montarMensagemConta, montarMensagemOferta, type DadosConsulta, type DadosOferta, type Mensagem, type Modelo, type ModeloConta,
} from "@/lib/notificacoes/modelos";
import { PRAZO_MINUTOS } from "@/lib/security/links";
import { origemDoMunicipio } from "@/lib/web/endereco";
import type { Transporte } from "@/lib/notificacoes/transporte";

/**
 * Processa a fila de notificações. Reserva um lote (SKIP LOCKED: vários workers não pegam a mesma),
 * busca os dados da consulta no contexto do município da notificação e envia.
 * Falha temporária volta para a fila com espera crescente; após 5 tentativas fica como "falhou".
 */
interface ItemFila {
  id: string;
  tenant_id: string;
  modelo: Modelo | ModeloConta | "vaga_oferecida";
  dados: { agendamento_id?: string; oferta_id?: string; pela_unidade?: boolean; token_cifrado?: string };
  email_cifrado: Buffer | null;
  pessoa_id: string;
}

type Conclusao = "enviada" | "falhou" | "sem_contato" | "descartada";

async function concluir(id: string, estado: Conclusao): Promise<void> {
  await comConta(null, (tx) => tx.query("SELECT app.notificacao_concluir($1, $2)", [id, estado]));
}

async function dadosDaConsulta(tenantId: string, agendamentoId: string): Promise<(Omit<DadosConsulta, "pelaUnidade"> & { estado: string }) | null> {
  return comMunicipio({ tenantId, contaId: null }, async (tx) => {
    const r = await tx.query<{
      municipio: string; slug: string; fuso: string; unidade: string; profissional: string; especialidade: string; inicio: Date;
      dependente: string | null; estado: string;
    }>(
      `SELECT t.nome AS municipio, t.slug, t.fuso, u.nome AS unidade, p.nome_exibicao AS profissional, p.especialidade,
              lower(v.periodo) AS inicio, d.nome_curto AS dependente, a.estado
       FROM app.agendamento a
       LEFT JOIN app.dependente d ON d.id = a.dependente_id
       JOIN app.vaga v ON v.id = a.vaga_id
       JOIN app.unidade u ON u.id = v.unidade_id
       JOIN app.profissional p ON p.id = v.profissional_id
       JOIN app.tenant t ON t.id = a.tenant_id
       WHERE a.id = $1`,
      [agendamentoId],
    );
    const l = r.rows[0];
    if (!l) return null;
    return { ...l, confirmada: l.estado === "confirmada", link: `${origemDoMunicipio(l.slug)}/minhas-consultas` };
  });
}

/** Oferta ainda no prazo; NULL quando já foi respondida, venceu ou foi cancelada. */
async function dadosDaOferta(tenantId: string, ofertaId: string): Promise<DadosOferta | null> {
  return comMunicipio({ tenantId, contaId: null }, async (tx) => {
    const r = await tx.query<{
      municipio: string; slug: string; fuso: string; unidade: string; profissional: string; especialidade: string; inicio: Date;
      dependente: string | null; expira_em: Date;
    }>(
      `SELECT t.nome AS municipio, t.slug, t.fuso, u.nome AS unidade, p.nome_exibicao AS profissional, p.especialidade,
              lower(v.periodo) AS inicio, d.nome_curto AS dependente, o.expira_em
       FROM app.oferta o
       JOIN app.espera e ON e.id = o.espera_id
       LEFT JOIN app.dependente d ON d.id = e.dependente_id
       JOIN app.vaga v ON v.id = o.vaga_id
       JOIN app.unidade u ON u.id = v.unidade_id
       JOIN app.profissional p ON p.id = v.profissional_id
       JOIN app.tenant t ON t.id = o.tenant_id
       WHERE o.id = $1 AND o.estado = 'ativa' AND o.expira_em > now() + interval '10 minutes'`,
      [ofertaId],
    );
    const l = r.rows[0];
    if (!l) return null;
    return { ...l, expiraEm: l.expira_em, link: `${origemDoMunicipio(l.slug)}/lista-de-espera` };
  });
}

/** Monta a mensagem do item; "descartada" quando o aviso perdeu o sentido antes de sair. */
async function mensagemDoItem(item: ItemFila): Promise<Mensagem | "descartada" | null> {
  if (item.modelo === "recuperar_senha") return mensagemDeConta(item);
  if (item.modelo === "vaga_oferecida") {
    if (!item.dados.oferta_id) return null;
    const oferta = await dadosDaOferta(item.tenant_id, item.dados.oferta_id);
    return oferta ? montarMensagemOferta(oferta) : "descartada";
  }
  const consulta = item.dados.agendamento_id ? await dadosDaConsulta(item.tenant_id, item.dados.agendamento_id) : null;
  if (!consulta) return null;
  if (item.modelo === "lembrete_vespera" && (!["marcada", "confirmada"].includes(consulta.estado) || consulta.inicio.getTime() <= Date.now())) {
    return "descartada";
  }
  return montarMensagem(item.modelo, { ...consulta, pelaUnidade: item.dados.pela_unidade });
}

/** Mensagem de conta (recuperação de senha): o token sai cifrado da fila e vira o link. */
async function mensagemDeConta(item: ItemFila) {
  if (!item.dados.token_cifrado) return null;
  const token = decifrar(Buffer.from(item.dados.token_cifrado, "base64"), "notificacao.recuperar_senha");
  const t = await comMunicipio({ tenantId: item.tenant_id, contaId: null }, async (tx) =>
    (await tx.query<{ nome: string; slug: string }>("SELECT nome, slug FROM app.tenant WHERE id = app.tenant_atual()")).rows[0],
  );
  if (!t) return null;
  return montarMensagemConta("recuperar_senha", {
    municipio: t.nome,
    link: `${origemDoMunicipio(t.slug)}/recuperar/nova#${token}`,
    minutos: PRAZO_MINUTOS.recuperar_senha,
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
      const mensagem = await mensagemDoItem(item);
      if (mensagem === "descartada") {
        await concluir(item.id, "descartada");
        continue;
      }
      if (!mensagem) {
        await concluir(item.id, "falhou");
        totais.falhas++;
        continue;
      }
      // A chave de idempotência faz o provedor ignorar a repetição se o worker cair entre o
      // envio e o registro (a notificação volta para a fila e seria mandada de novo).
      await transporte.enviar(decifrar(item.email_cifrado, "pessoa.email"), mensagem, `notificacao-${item.id}`);
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
