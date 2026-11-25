import { z } from "zod";
import type { Conexao } from "@/lib/db/pool";
import { comMunicipio } from "@/lib/db/contexto";
import { AcessoNegado, comPermissao } from "@/lib/auth/autorizar";
import { registrarAuditoria } from "@/lib/auditoria";
import { ErroAgendamento, traduzirErroBanco } from "@/lib/agendamento/erros";
import { comoCidadao, type Requisicao } from "@/lib/agendamento/servico";

/**
 * Lista de espera e ofertas. Quando uma vaga abre, o banco a oferece só para o primeiro da fila
 * compatível, por um prazo; quem recebe aceita (vira consulta) ou recusa (vai para o próximo).
 * Prioridade (idoso, gestante, PcD) só a equipe marca. As regras ficam no banco; aqui ficam a
 * validação de entrada, a posse do pedido e a auditoria.
 */
export const TURNOS = { qualquer: "Qualquer horário", manha: "Manhã", tarde: "Tarde" } as const;
export type Turno = keyof typeof TURNOS;

export const PRIORIDADES = {
  idoso: "Pessoa idosa (60 anos ou mais)",
  gestante: "Gestante",
  pcd: "Pessoa com deficiência",
  remanejamento: "Consulta cancelada pela unidade",
  outra: "Outra prioridade legal (a unidade confere)",
} as const;
export type Prioridade = keyof typeof PRIORIDADES;

const uuid = z.string().uuid();
// Campos de formulário ausentes chegam como null (FormData.get).
const opcionalUuid = z.union([z.literal(""), z.literal("eu"), uuid]).nullish().transform((v) => (v && v !== "eu" ? v : null));

const esquemaPedido = z.object({
  especialidade: z.string().trim().min(2).max(80),
  unidadeId: z.union([z.literal(""), uuid]).nullish().transform((v) => v || null),
  turno: z.enum(Object.keys(TURNOS) as [Turno, ...Turno[]]).nullish().transform((v) => v ?? "qualquer"),
  para: opcionalUuid,
});

const esquemaPrioridade = z.union([z.literal(""), z.enum(Object.keys(PRIORIDADES) as [Prioridade, ...Prioridade[]])])
  .nullish()
  .transform((v) => (v ? v : null));

function validar<E extends z.ZodType>(esquema: E, valor: unknown): z.output<E> {
  const r = esquema.safeParse(valor);
  if (!r.success) throw new ErroAgendamento("dados_invalidos");
  return r.data;
}

async function executar<T>(trabalho: () => Promise<T>): Promise<T> {
  try {
    return await trabalho();
  } catch (erro) {
    if (erro instanceof AcessoNegado || erro instanceof ErroAgendamento) throw erro;
    return traduzirErroBanco(erro);
  }
}

// ------------------------------------------------------------------ listas de apoio
/** Especialidades com profissional ativo e unidades ativas do município da sessão. */
export async function opcoesDaEspera(req: Requisicao): Promise<{ especialidades: string[]; unidades: { id: string; nome: string }[] }> {
  const s = req.sessao;
  if (!s?.tenantId || s.tenantId !== req.tenantDaUrl) return { especialidades: [], unidades: [] };
  return comMunicipio({ tenantId: s.tenantId, contaId: s.contaId }, async (tx) => {
    const e = await tx.query<{ especialidade: string }>(
      "SELECT min(especialidade) AS especialidade FROM app.profissional WHERE ativo GROUP BY lower(especialidade) ORDER BY 1",
    );
    const u = await tx.query<{ id: string; nome: string }>("SELECT id, nome FROM app.unidade WHERE ativa ORDER BY nome");
    return { especialidades: e.rows.map((l) => l.especialidade), unidades: u.rows };
  });
}

async function inserirPedido(tx: Conexao, vinculoId: string, p: z.infer<typeof esquemaPedido>, prioridade: Prioridade | null): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO app.espera (tenant_id, cidadao_vinculo_id, dependente_id, pessoa_id, especialidade, unidade_id, turno, prioridade)
     VALUES (app.tenant_atual(), $1, $2, '00000000-0000-0000-0000-000000000000', $3, $4, $5, $6) RETURNING id`,
    [vinculoId, p.para, p.especialidade, p.unidadeId, p.turno, prioridade],
  );
  const id = r.rows[0]!.id;
  // Se já existe vaga livre que combina, a oferta sai na hora.
  await tx.query("SELECT app.espera_distribuir(50)");
  return id;
}

// ------------------------------------------------------------------ cidadão
export interface PedidoDeEspera {
  id: string;
  especialidade: string;
  unidade: string | null;
  turno: Turno;
  prioridade: Prioridade | null;
  estado: "aguardando" | "atendida" | "cancelada";
  valida_ate: Date;
  criado_em: Date;
  paciente: string | null;
}

export interface OfertaDeVaga {
  id: string;
  espera_id: string;
  expira_em: Date;
  inicio: Date;
  unidade: string;
  profissional: string;
  especialidade: string;
  paciente: string | null;
}

export async function minhaEspera(req: Requisicao): Promise<{ pedidos: PedidoDeEspera[]; ofertas: OfertaDeVaga[] }> {
  return comoCidadao(req, async (tx, vinculoId) => {
    const pedidos = await tx.query<PedidoDeEspera>(
      `SELECT e.id, e.especialidade, u.nome AS unidade, e.turno, e.prioridade, e.estado, e.valida_ate, e.criado_em, d.nome_curto AS paciente
       FROM app.espera e
       LEFT JOIN app.unidade u ON u.id = e.unidade_id
       LEFT JOIN app.dependente d ON d.id = e.dependente_id
       WHERE e.cidadao_vinculo_id = $1 AND (e.estado = 'aguardando' OR e.encerrada_em > now() - interval '30 days')
       ORDER BY e.estado = 'aguardando' DESC, e.criado_em DESC
       LIMIT 30`,
      [vinculoId],
    );
    const ofertas = await tx.query<OfertaDeVaga>(
      `SELECT o.id, o.espera_id, o.expira_em, lower(v.periodo) AS inicio, u.nome AS unidade, p.nome_exibicao AS profissional,
              p.especialidade, d.nome_curto AS paciente
       FROM app.oferta o
       JOIN app.espera e ON e.id = o.espera_id
       JOIN app.vaga v ON v.id = o.vaga_id
       JOIN app.unidade u ON u.id = v.unidade_id
       JOIN app.profissional p ON p.id = v.profissional_id
       LEFT JOIN app.dependente d ON d.id = e.dependente_id
       WHERE e.cidadao_vinculo_id = $1 AND o.estado = 'ativa' AND o.expira_em > now()
       ORDER BY o.expira_em`,
      [vinculoId],
    );
    return { pedidos: pedidos.rows, ofertas: ofertas.rows };
  });
}

export async function entrarNaEspera(req: Requisicao, entrada: unknown): Promise<string> {
  const p = validar(esquemaPedido, entrada);
  return executar(() =>
    comoCidadao(req, async (tx, vinculoId) => {
      const id = await inserirPedido(tx, vinculoId, p, null);
      await registrarAuditoria(tx, {
        acao: "espera.entrar", modulo: "agendamento", objetoTipo: "espera", objetoId: id,
        detalhes: { autoatendimento: true, dependente: p.para !== null, turno: p.turno }, ip: req.ip,
      });
      return id;
    }),
  );
}

async function garantirPedidoDoCidadao(tx: Conexao, esperaId: string, vinculoId: string): Promise<void> {
  const r = await tx.query("SELECT 1 FROM app.espera WHERE id = $1 AND cidadao_vinculo_id = $2", [esperaId, vinculoId]);
  if (r.rowCount !== 1) throw new ErroAgendamento("espera_encerrada");
}

export async function sairDaEspera(req: Requisicao, esperaId: unknown): Promise<void> {
  const id = validar(uuid, esperaId);
  await executar(() =>
    comoCidadao(req, async (tx, vinculoId) => {
      await garantirPedidoDoCidadao(tx, id, vinculoId);
      await tx.query("SELECT app.espera_sair($1)", [id]);
      await registrarAuditoria(tx, { acao: "espera.sair", modulo: "agendamento", objetoTipo: "espera", objetoId: id, detalhes: { autoatendimento: true }, ip: req.ip });
    }),
  );
}

/** Oferta da própria pessoa (titular ou dependente dele), ainda no prazo. */
async function ofertaDoCidadao(tx: Conexao, ofertaId: string, vinculoId: string) {
  const r = await tx.query<{ vaga_id: string; dependente_id: string | null }>(
    `SELECT o.vaga_id, e.dependente_id FROM app.oferta o JOIN app.espera e ON e.id = o.espera_id
     WHERE o.id = $1 AND e.cidadao_vinculo_id = $2 AND o.estado = 'ativa' AND o.expira_em > now()`,
    [ofertaId, vinculoId],
  );
  const o = r.rows[0];
  if (!o) throw new ErroAgendamento("oferta_encerrada");
  return o;
}

/** Aceitar vira consulta marcada (o banco confere de novo que a oferta é desta pessoa). */
export async function aceitarOferta(req: Requisicao, ofertaId: unknown): Promise<string> {
  const id = validar(uuid, ofertaId);
  return executar(() =>
    comoCidadao(req, async (tx, vinculoId) => {
      const o = await ofertaDoCidadao(tx, id, vinculoId);
      const r = await tx.query<{ id: string }>("SELECT app.agendamento_marcar($1, $2, NULL, $3) AS id", [o.vaga_id, vinculoId, o.dependente_id]);
      const consulta = r.rows[0]!.id;
      await registrarAuditoria(tx, {
        acao: "espera.aceitar", modulo: "agendamento", objetoTipo: "agendamento", objetoId: consulta,
        detalhes: { autoatendimento: true, dependente: o.dependente_id !== null }, ip: req.ip,
      });
      return consulta;
    }),
  );
}

export async function recusarOferta(req: Requisicao, ofertaId: unknown): Promise<void> {
  const id = validar(uuid, ofertaId);
  await executar(() =>
    comoCidadao(req, async (tx, vinculoId) => {
      await ofertaDoCidadao(tx, id, vinculoId);
      await tx.query("SELECT app.oferta_recusar($1)", [id]);
      await registrarAuditoria(tx, { acao: "espera.recusar", modulo: "agendamento", objetoTipo: "oferta", objetoId: id, detalhes: { autoatendimento: true }, ip: req.ip });
    }),
  );
}

// ------------------------------------------------------------------ equipe
export interface ItemDaFila {
  id: string;
  especialidade: string;
  unidade: string | null;
  turno: Turno;
  prioridade: Prioridade | null;
  criado_em: Date;
  valida_ate: Date;
  cidadao_vinculo_id: string;
  oferta_ate: Date | null;
  oferta_inicio: Date | null;
}

/** Fila vigente, na ordem em que as vagas são oferecidas. Sem nomes: vêm por função própria. */
export async function filaDeEspera(req: Requisicao, especialidade?: unknown): Promise<ItemDaFila[]> {
  const filtro = typeof especialidade === "string" && especialidade.trim().length >= 2 ? especialidade.trim().slice(0, 80) : null;
  return comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "agenda.ver", qualquerUnidade: true }, async (tx) =>
    (await tx.query<ItemDaFila>(
      `SELECT e.id, e.especialidade, u.nome AS unidade, e.turno, e.prioridade, e.criado_em, e.valida_ate, e.cidadao_vinculo_id,
              o.expira_em AS oferta_ate, lower(v.periodo) AS oferta_inicio
       FROM app.espera e
       LEFT JOIN app.unidade u ON u.id = e.unidade_id
       LEFT JOIN app.oferta o ON o.espera_id = e.id AND o.estado = 'ativa' AND o.expira_em > now()
       LEFT JOIN app.vaga v ON v.id = o.vaga_id
       WHERE e.estado = 'aguardando' AND e.valida_ate >= current_date
         AND ($1::text IS NULL OR lower(e.especialidade) = lower($1))
       ORDER BY lower(e.especialidade), (e.prioridade IS NOT NULL) DESC, e.criado_em, e.id
       LIMIT 300`,
      [filtro],
    )).rows,
  );
}

export async function nomesNaEspera(req: Requisicao, esperas: string[]): Promise<Map<string, string>> {
  if (esperas.length === 0) return new Map();
  return comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "agenda.ver", qualquerUnidade: true }, async (tx) => {
    const r = await tx.query<{ espera_id: string; nome: string; dependente: boolean }>("SELECT * FROM app.nomes_da_espera($1)", [esperas]);
    return new Map(r.rows.map((l) => [l.espera_id, l.dependente ? `${l.nome} (dependente)` : l.nome]));
  });
}

/** A recepção inclui o cidadão (ou dependente dele) na lista, já com a prioridade conferida. */
export async function incluirNaEsperaPelaUnidade(req: Requisicao, titularVinculo: unknown, entrada: unknown): Promise<string> {
  const vinculo = validar(uuid, titularVinculo);
  const p = validar(esquemaPedido, entrada);
  const prioridade = validar(esquemaPrioridade, (entrada as { prioridade?: unknown } | null)?.prioridade);
  return executar(() =>
    comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "agenda.marcar", qualquerUnidade: true }, async (tx) => {
      const id = await inserirPedido(tx, vinculo, p, prioridade);
      await registrarAuditoria(tx, {
        acao: "espera.incluir", modulo: "recepcao", objetoTipo: "espera", objetoId: id,
        detalhes: { dependente: p.para !== null, prioridade: prioridade !== null, turno: p.turno }, ip: req.ip,
      });
      return id;
    }),
  );
}

export async function definirPrioridade(req: Requisicao, esperaId: unknown, prioridade: unknown): Promise<void> {
  const id = validar(uuid, esperaId);
  const p = validar(esquemaPrioridade, prioridade);
  await executar(() =>
    comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "agenda.marcar", qualquerUnidade: true }, async (tx) => {
      const r = await tx.query("UPDATE app.espera SET prioridade = $2 WHERE id = $1 AND estado = 'aguardando'", [id, p]);
      if (r.rowCount !== 1) throw new ErroAgendamento("espera_encerrada");
      await registrarAuditoria(tx, { acao: "espera.prioridade", modulo: "recepcao", objetoTipo: "espera", objetoId: id, detalhes: { prioridade: p }, ip: req.ip });
    }),
  );
}

export async function removerDaEspera(req: Requisicao, esperaId: unknown): Promise<void> {
  const id = validar(uuid, esperaId);
  await executar(() =>
    comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "agenda.marcar", qualquerUnidade: true }, async (tx) => {
      await tx.query("SELECT app.espera_sair($1)", [id]);
      await registrarAuditoria(tx, { acao: "espera.remover", modulo: "recepcao", objetoTipo: "espera", objetoId: id, ip: req.ip });
    }),
  );
}

/** Pedidos de um cidadão (na ficha da recepção). */
export async function esperaDoCidadao(req: Requisicao, titularVinculo: unknown): Promise<(PedidoDeEspera & { oferta_ate: Date | null })[]> {
  const r = z.string().uuid().safeParse(titularVinculo);
  if (!r.success) return [];
  return comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "agenda.ver", qualquerUnidade: true }, async (tx) =>
    (await tx.query<PedidoDeEspera & { oferta_ate: Date | null }>(
      `SELECT e.id, e.especialidade, u.nome AS unidade, e.turno, e.prioridade, e.estado, e.valida_ate, e.criado_em,
              d.nome_curto AS paciente, o.expira_em AS oferta_ate
       FROM app.espera e
       LEFT JOIN app.unidade u ON u.id = e.unidade_id
       LEFT JOIN app.dependente d ON d.id = e.dependente_id
       LEFT JOIN app.oferta o ON o.espera_id = e.id AND o.estado = 'ativa' AND o.expira_em > now()
       WHERE e.cidadao_vinculo_id = $1 AND e.estado = 'aguardando'
       ORDER BY e.criado_em`,
      [r.data],
    )).rows,
  );
}

// ------------------------------------------------------------------ ligações da recepção
export interface ContatoPendente {
  agendamento_id: string;
  inicio: Date;
  profissional: string;
  especialidade: string;
  estado: string;
  motivo: "sem_confirmacao" | "aguardando_remanejamento";
  aviso: "sem_contato" | "falhou" | null;
}

export interface OfertaUrgente {
  oferta_id: string;
  espera_id: string;
  inicio: Date;
  expira_em: Date;
  profissional: string;
  especialidade: string;
}

/**
 * Quem a recepção precisa procurar, numa unidade: consultas das próximas 48 horas ainda sem
 * confirmação, consultas aguardando novo horário (profissional ausente) e vagas oferecidas
 * que acontecem em menos de 24 horas. Nada é desmarcado por falta de resposta.
 */
export async function contatosPendentes(req: Requisicao, unidadeId: unknown): Promise<{ consultas: ContatoPendente[]; ofertas: OfertaUrgente[] }> {
  const unidade = validar(uuid, unidadeId);
  return comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "agenda.ver", unidadeId: unidade }, async (tx) => {
    const c = await tx.query<Omit<ContatoPendente, "aviso">>(
      `SELECT a.id AS agendamento_id, lower(v.periodo) AS inicio, p.nome_exibicao AS profissional, p.especialidade, a.estado,
              CASE WHEN a.estado = 'aguardando_remanejamento' THEN 'aguardando_remanejamento' ELSE 'sem_confirmacao' END AS motivo
       FROM app.agendamento a
       JOIN app.vaga v ON v.id = a.vaga_id
       JOIN app.profissional p ON p.id = v.profissional_id
       WHERE v.unidade_id = $1 AND lower(v.periodo) > now()
         AND ((a.estado = 'marcada' AND lower(v.periodo) < now() + interval '48 hours') OR a.estado = 'aguardando_remanejamento')
       ORDER BY lower(v.periodo)
       LIMIT 300`,
      [unidade],
    );
    const ids = c.rows.map((l) => l.agendamento_id);
    const avisos = ids.length
      ? await tx.query<{ agendamento_id: string; sem_contato: boolean; falhou: boolean }>("SELECT * FROM app.avisos_das_consultas($1)", [ids])
      : { rows: [] };
    const porConsulta = new Map(avisos.rows.map((a) => [a.agendamento_id, a.sem_contato ? "sem_contato" as const : a.falhou ? "falhou" as const : null]));
    const o = await tx.query<OfertaUrgente>(
      `SELECT o.id AS oferta_id, o.espera_id, lower(v.periodo) AS inicio, o.expira_em, p.nome_exibicao AS profissional, p.especialidade
       FROM app.oferta o
       JOIN app.vaga v ON v.id = o.vaga_id
       JOIN app.profissional p ON p.id = v.profissional_id
       WHERE v.unidade_id = $1 AND o.estado = 'ativa' AND o.expira_em > now() AND lower(v.periodo) < now() + interval '24 hours'
       ORDER BY lower(v.periodo)`,
      [unidade],
    );
    return { consultas: c.rows.map((l) => ({ ...l, aviso: porConsulta.get(l.agendamento_id) ?? null })), ofertas: o.rows };
  });
}

/** Aceite pela recepção, depois de falar com a pessoa por telefone ou no balcão. */
export async function aceitarOfertaPelaUnidade(req: Requisicao, ofertaId: unknown): Promise<string> {
  const id = validar(uuid, ofertaId);
  return executar(() =>
    comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "agenda.marcar", qualquerUnidade: true }, async (tx) => {
      const r = await tx.query<{ vaga_id: string; cidadao_vinculo_id: string; dependente_id: string | null; unidade_id: string }>(
        `SELECT o.vaga_id, e.cidadao_vinculo_id, e.dependente_id, v.unidade_id FROM app.oferta o
         JOIN app.espera e ON e.id = o.espera_id JOIN app.vaga v ON v.id = o.vaga_id
         WHERE o.id = $1 AND o.estado = 'ativa' AND o.expira_em > now()`,
        [id],
      );
      const o = r.rows[0];
      if (!o) throw new ErroAgendamento("oferta_encerrada");
      // Marcar exige a permissão na unidade da vaga.
      const ok = await tx.query<{ ok: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM app.minhas_permissoes($1) AS m(codigo) WHERE m.codigo = 'agenda.marcar') AS ok",
        [o.unidade_id],
      );
      if (ok.rows[0]?.ok !== true) throw new AcessoNegado("sem_permissao");
      const a = await tx.query<{ id: string }>("SELECT app.agendamento_marcar($1, $2, NULL, $3) AS id", [o.vaga_id, o.cidadao_vinculo_id, o.dependente_id]);
      const consulta = a.rows[0]!.id;
      await registrarAuditoria(tx, { acao: "espera.aceitar", modulo: "recepcao", objetoTipo: "agendamento", objetoId: consulta, ip: req.ip });
      return consulta;
    }),
  );
}
