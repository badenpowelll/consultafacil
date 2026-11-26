import { z } from "zod";
import type { Conexao } from "@/lib/db/pool";
import { comMunicipio } from "@/lib/db/contexto";
import { comPermissao, AcessoNegado } from "@/lib/auth/autorizar";
import type { SessaoValida } from "@/lib/auth/sessao";
import { registrarAuditoria } from "@/lib/auditoria";
import { ErroAgendamento, traduzirErroBanco } from "@/lib/agendamento/erros";
import { obterPool } from "@/lib/db/pool";
import { consumirLimite } from "@/lib/security/limites";
import {
  codigoDoComprovante, enderecoDeValidacao, hashDoCodigo, normalizarCodigo, type DadosComprovante,
} from "@/lib/agendamento/comprovante";

/**
 * Serviço de agendamento. Toda regra crítica (vaga livre, conflito de horário, limite por cidadão,
 * máquina de estados, reabertura da vaga) é garantida pelo banco; aqui ficam a autorização,
 * a validação de entrada e a auditoria.
 */
const uuid = z.string().uuid();
const motivo = z.string().trim().min(3).max(300);

export interface Requisicao {
  sessao: SessaoValida | null;
  tenantDaUrl: string;
  ip?: string | null;
}

function validar<T>(esquema: z.ZodType<T>, valor: unknown): T {
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

// ------------------------------------------------------------------ cidadão (autoatendimento)
/** O cidadão age só sobre as próprias consultas, com vínculo de cidadão ativo no município. */
export async function comoCidadao<T>(req: Requisicao, trabalho: (tx: Conexao, vinculoId: string) => Promise<T>): Promise<T> {
  const s = req.sessao;
  if (!s) throw new AcessoNegado("sem_sessao");
  if (!s.tenantId) throw new AcessoNegado("sem_municipio");
  if (s.tenantId !== req.tenantDaUrl) throw new AcessoNegado("municipio_divergente");
  return comMunicipio({ tenantId: s.tenantId, contaId: s.contaId }, async (tx) => {
    const v = await tx.query<{ id: string }>(
      "SELECT id FROM app.vinculo WHERE conta_id = app.conta_atual() AND papel = 'cidadao' AND estado = 'ativo'",
    );
    const vinculoId = v.rows[0]?.id;
    if (!vinculoId) throw new ErroAgendamento("sem_vinculo_cidadao");
    return trabalho(tx, vinculoId);
  });
}

/** Teto de volume por conta no autoatendimento (ver POLITICAS em security/limites). */
async function limitarCidadao(req: Requisicao, politica: "buscaVagas" | "marcacao"): Promise<void> {
  if (!req.sessao) throw new AcessoNegado("sem_sessao");
  if (!(await consumirLimite(politica, req.sessao.contaId))) throw new ErroAgendamento("limite_uso");
}

export interface VagaLivre {
  id: string;
  inicio: Date;
  fim: Date;
  unidade: string;
  profissional: string;
  especialidade: string;
}

const filtroVagas = z.object({
  unidadeId: uuid.optional(),
  especialidade: z.string().trim().min(2).max(80).optional(),
  de: z.coerce.date(),
  ate: z.coerce.date(),
});

async function buscarVagas(tx: Conexao, filtro: z.infer<typeof filtroVagas>): Promise<VagaLivre[]> {
  const r = await tx.query<{ id: string; inicio: Date; fim: Date; unidade: string; profissional: string; especialidade: string }>(
    `SELECT v.id, lower(v.periodo) AS inicio, upper(v.periodo) AS fim, u.nome AS unidade,
            p.nome_exibicao AS profissional, p.especialidade
     FROM app.vaga v
     JOIN app.unidade u ON u.id = v.unidade_id AND u.ativa
     JOIN app.profissional p ON p.id = v.profissional_id AND p.ativo
     WHERE v.estado = 'livre' AND lower(v.periodo) > now()
       -- Vaga oferecida a alguém da lista de espera fica com essa pessoa até o prazo.
       AND NOT EXISTS (SELECT 1 FROM app.oferta o WHERE o.vaga_id = v.id AND o.estado = 'ativa' AND o.expira_em > now())
       AND lower(v.periodo) >= $1 AND lower(v.periodo) < $2
       AND ($3::uuid IS NULL OR v.unidade_id = $3)
       AND ($4::text IS NULL OR p.especialidade ILIKE $4)
     ORDER BY lower(v.periodo)
     LIMIT 200`,
    [filtro.de, filtro.ate, filtro.unidadeId ?? null, filtro.especialidade ?? null],
  );
  return r.rows;
}

export async function vagasParaCidadao(req: Requisicao, filtro: unknown): Promise<VagaLivre[]> {
  const f = validar(filtroVagas, filtro);
  await limitarCidadao(req, "buscaVagas");
  return comoCidadao(req, (tx) => buscarVagas(tx, f));
}

/** Dependente opcional: vazio é o próprio titular. O banco só aceita dependente ativo dele. */
function dependenteOpcional(valor: unknown): string | null {
  if (valor === undefined || valor === null || valor === "" || valor === "eu") return null;
  return validar(uuid, valor);
}

export async function marcarParaMim(req: Requisicao, vagaId: unknown, dependenteId?: unknown): Promise<string> {
  const vaga = validar(uuid, vagaId);
  const dependente = dependenteOpcional(dependenteId);
  await limitarCidadao(req, "marcacao");
  return executar(() =>
    comoCidadao(req, async (tx, vinculoId) => {
      const r = await tx.query<{ id: string }>("SELECT app.agendamento_marcar($1, $2, NULL, $3) AS id", [vaga, vinculoId, dependente]);
      const id = r.rows[0]!.id;
      await registrarAuditoria(tx, {
        acao: "agenda.marcar", modulo: "agendamento", objetoTipo: "agendamento", objetoId: id,
        detalhes: { autoatendimento: true, dependente: dependente !== null }, ip: req.ip,
      });
      return id;
    }),
  );
}

export interface ConsultaDoCidadao {
  id: string;
  estado: string;
  inicio: Date;
  fim: Date;
  unidade: string;
  profissional: string;
  especialidade: string;
  /** Como o titular chama o dependente; null quando a consulta é do próprio titular. */
  paciente: string | null;
}

export async function minhasConsultas(req: Requisicao): Promise<ConsultaDoCidadao[]> {
  return comoCidadao(req, async (tx, vinculoId) => {
    const r = await tx.query<ConsultaDoCidadao>(
      `SELECT a.id, a.estado, lower(v.periodo) AS inicio, upper(v.periodo) AS fim, u.nome AS unidade,
              p.nome_exibicao AS profissional, p.especialidade, d.nome_curto AS paciente
       FROM app.agendamento a
       JOIN app.vaga v ON v.id = a.vaga_id
       JOIN app.unidade u ON u.id = v.unidade_id
       JOIN app.profissional p ON p.id = v.profissional_id
       LEFT JOIN app.dependente d ON d.id = a.dependente_id
       WHERE a.cidadao_vinculo_id = $1
       ORDER BY lower(v.periodo) DESC
       LIMIT 50`,
      [vinculoId],
    );
    return r.rows;
  });
}

async function garantirQueEhDoCidadao(tx: Conexao, agendamentoId: string, vinculoId: string): Promise<void> {
  const r = await tx.query("SELECT 1 FROM app.agendamento WHERE id = $1 AND cidadao_vinculo_id = $2", [agendamentoId, vinculoId]);
  // Mesma resposta para "não existe" e "é de outra pessoa": não revela consultas alheias.
  if (r.rowCount !== 1) throw new ErroAgendamento("nao_e_sua");
}

/** O cidadão desmarca e a vaga volta a ficar livre para outra pessoa. */
export async function desmarcarMinha(req: Requisicao, agendamentoId: unknown, motivoTexto: unknown): Promise<void> {
  const id = validar(uuid, agendamentoId);
  const m = validar(motivo, motivoTexto);
  await limitarCidadao(req, "marcacao");
  await executar(() =>
    comoCidadao(req, async (tx, vinculoId) => {
      await garantirQueEhDoCidadao(tx, id, vinculoId);
      await tx.query("SELECT app.agendamento_desmarcar($1, true, $2)", [id, m]);
      await registrarAuditoria(tx, { acao: "agenda.desmarcar", modulo: "agendamento", objetoTipo: "agendamento", objetoId: id, detalhes: { autoatendimento: true }, ip: req.ip });
    }),
  );
}

/** O cidadão confirma que vai (opcional; quem não confirma continua com a consulta). */
export async function confirmarMinha(req: Requisicao, agendamentoId: unknown): Promise<void> {
  const id = validar(uuid, agendamentoId);
  await executar(() =>
    comoCidadao(req, async (tx, vinculoId) => {
      await garantirQueEhDoCidadao(tx, id, vinculoId);
      await confirmar(tx, id);
      await registrarAuditoria(tx, { acao: "agenda.confirmar", modulo: "agendamento", objetoTipo: "agendamento", objetoId: id, detalhes: { autoatendimento: true }, ip: req.ip });
    }),
  );
}

async function confirmar(tx: Conexao, id: string): Promise<void> {
  const r = await tx.query(
    `UPDATE app.agendamento a SET estado = 'confirmada'
     FROM app.vaga v WHERE v.id = a.vaga_id AND a.id = $1 AND a.estado = 'marcada' AND lower(v.periodo) > now()`,
    [id],
  );
  if (r.rowCount !== 1) throw new ErroAgendamento("ja_confirmada");
}

export async function remarcarMinha(req: Requisicao, agendamentoId: unknown, novaVagaId: unknown): Promise<string> {
  const id = validar(uuid, agendamentoId);
  const vaga = validar(uuid, novaVagaId);
  await limitarCidadao(req, "marcacao");
  return executar(() =>
    comoCidadao(req, async (tx, vinculoId) => {
      await garantirQueEhDoCidadao(tx, id, vinculoId);
      const r = await tx.query<{ id: string }>("SELECT app.agendamento_remarcar($1, $2) AS id", [id, vaga]);
      const novo = r.rows[0]!.id;
      await registrarAuditoria(tx, { acao: "agenda.remarcar", modulo: "agendamento", objetoTipo: "agendamento", objetoId: novo, detalhes: { autoatendimento: true }, ip: req.ip });
      return novo;
    }),
  );
}

// ------------------------------------------------------------------ equipe
async function unidadeDaVaga(tx: Conexao, vagaId: string): Promise<string> {
  const r = await tx.query<{ unidade_id: string }>("SELECT unidade_id FROM app.vaga WHERE id = $1", [vagaId]);
  const u = r.rows[0]?.unidade_id;
  if (!u) throw new ErroAgendamento("vaga_inexistente");
  return u;
}

async function unidadeDaConsulta(tx: Conexao, agendamentoId: string): Promise<string> {
  const r = await tx.query<{ unidade_id: string }>(
    "SELECT v.unidade_id FROM app.agendamento a JOIN app.vaga v ON v.id = a.vaga_id WHERE a.id = $1",
    [agendamentoId],
  );
  const u = r.rows[0]?.unidade_id;
  if (!u) throw new ErroAgendamento("consulta_inexistente");
  return u;
}

/**
 * A permissão da equipe vale por unidade. Primeiro descobrimos a unidade do objeto (dentro do
 * município, pelo RLS) e só então conferimos a permissão nela, na mesma transação.
 */
async function comPermissaoNaUnidade<T>(
  req: Requisicao,
  permissao: string,
  descobrirUnidade: (tx: Conexao) => Promise<string>,
  trabalho: (tx: Conexao) => Promise<T>,
): Promise<T> {
  const s = req.sessao;
  if (!s?.tenantId || s.tenantId !== req.tenantDaUrl) {
    return comPermissao({ sessao: s, tenantDaUrl: req.tenantDaUrl, permissao }, trabalho);
  }
  const unidadeId = await comMunicipio({ tenantId: s.tenantId, contaId: s.contaId }, descobrirUnidade);
  return comPermissao({ sessao: s, tenantDaUrl: req.tenantDaUrl, permissao, unidadeId }, trabalho);
}

export async function marcarParaCidadao(req: Requisicao, vagaId: unknown, cidadaoVinculoId: unknown, dependenteId?: unknown): Promise<string> {
  const vaga = validar(uuid, vagaId);
  const cidadao = validar(uuid, cidadaoVinculoId);
  const dependente = dependenteOpcional(dependenteId);
  return executar(() =>
    comPermissaoNaUnidade(req, "agenda.marcar", (tx) => unidadeDaVaga(tx, vaga), async (tx) => {
      const r = await tx.query<{ id: string }>("SELECT app.agendamento_marcar($1, $2, NULL, $3) AS id", [vaga, cidadao, dependente]);
      const id = r.rows[0]!.id;
      await registrarAuditoria(tx, {
        acao: "agenda.marcar", modulo: "agendamento", objetoTipo: "agendamento", objetoId: id, detalhes: { dependente: dependente !== null }, ip: req.ip,
      });
      return id;
    }),
  );
}

export async function desmarcarPelaUnidade(req: Requisicao, agendamentoId: unknown, motivoTexto: unknown): Promise<void> {
  const id = validar(uuid, agendamentoId);
  const m = validar(motivo, motivoTexto);
  await executar(() =>
    comPermissaoNaUnidade(req, "agenda.desmarcar", (tx) => unidadeDaConsulta(tx, id), async (tx) => {
      await tx.query("SELECT app.agendamento_desmarcar($1, false, $2)", [id, m]);
      await registrarAuditoria(tx, { acao: "agenda.desmarcar", modulo: "agendamento", objetoTipo: "agendamento", objetoId: id, ip: req.ip });
    }),
  );
}

export async function remarcarPelaUnidade(req: Requisicao, agendamentoId: unknown, novaVagaId: unknown): Promise<string> {
  const id = validar(uuid, agendamentoId);
  const vaga = validar(uuid, novaVagaId);
  return executar(() =>
    comPermissaoNaUnidade(req, "agenda.remarcar", (tx) => unidadeDaConsulta(tx, id), async (tx) => {
      const r = await tx.query<{ id: string }>("SELECT app.agendamento_remarcar($1, $2) AS id", [id, vaga]);
      const novo = r.rows[0]!.id;
      await registrarAuditoria(tx, { acao: "agenda.remarcar", modulo: "agendamento", objetoTipo: "agendamento", objetoId: novo, ip: req.ip });
      return novo;
    }),
  );
}

/** A recepção registra a confirmação dada por telefone ou no balcão. */
export async function confirmarPelaUnidade(req: Requisicao, agendamentoId: unknown): Promise<void> {
  const id = validar(uuid, agendamentoId);
  await executar(() =>
    comPermissaoNaUnidade(req, "agenda.marcar", (tx) => unidadeDaConsulta(tx, id), async (tx) => {
      await confirmar(tx, id);
      await registrarAuditoria(tx, { acao: "agenda.confirmar", modulo: "recepcao", objetoTipo: "agendamento", objetoId: id, ip: req.ip });
    }),
  );
}

const ESTADOS_RECEPCAO = { presente: "recepcao.checkin", atendida: "recepcao.fechar_agenda", faltou: "recepcao.fechar_agenda" } as const;

/** Check-in, atendida e falta. A máquina de estados do banco recusa saltos inválidos. */
export async function registrarSituacao(req: Requisicao, agendamentoId: unknown, estado: unknown): Promise<void> {
  const id = validar(uuid, agendamentoId);
  const novo = validar(z.enum(["presente", "atendida", "faltou"]), estado);
  await executar(() =>
    comPermissaoNaUnidade(req, ESTADOS_RECEPCAO[novo], (tx) => unidadeDaConsulta(tx, id), async (tx) => {
      // Check-in a partir de 2 horas antes; falta só depois do horário marcado.
      const quando = await tx.query<{ ok: boolean }>(
        `SELECT CASE WHEN $2 = 'faltou' THEN lower(v.periodo) <= now() ELSE lower(v.periodo) <= now() + interval '2 hours' END AS ok
         FROM app.agendamento a JOIN app.vaga v ON v.id = a.vaga_id WHERE a.id = $1`,
        [id, novo],
      );
      if (quando.rows[0]?.ok !== true) throw new ErroAgendamento("fora_do_horario");
      const r = await tx.query("UPDATE app.agendamento SET estado = $2 WHERE id = $1", [id, novo]);
      if (r.rowCount !== 1) throw new ErroAgendamento("consulta_inexistente");
      await registrarAuditoria(tx, { acao: `agenda.${novo}`, modulo: "recepcao", objetoTipo: "agendamento", objetoId: id, ip: req.ip });
    }),
  );
}

export interface ItemAgenda {
  agendamento_id: string | null;
  vaga_id: string;
  inicio: Date;
  fim: Date;
  profissional: string;
  estado_vaga: string;
  estado_consulta: string | null;
  cidadao_vinculo_id: string | null;
  /** Vaga livre reservada para alguém da lista de espera até esta hora. */
  oferecida_ate: Date | null;
}

/** Agenda de um dia numa unidade. Não traz dados pessoais do cidadão; o nome vem por função própria. */
export async function agendaDoDia(req: Requisicao, unidadeId: unknown, dia: unknown): Promise<ItemAgenda[]> {
  const unidade = validar(uuid, unidadeId);
  const data = validar(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), dia);
  return comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "agenda.ver", unidadeId: unidade }, async (tx) => {
    const r = await tx.query<ItemAgenda>(
      `SELECT a.id AS agendamento_id, v.id AS vaga_id, lower(v.periodo) AS inicio, upper(v.periodo) AS fim,
              p.nome_exibicao AS profissional, v.estado AS estado_vaga, a.estado AS estado_consulta,
              a.cidadao_vinculo_id,
              (SELECT o.expira_em FROM app.oferta o WHERE o.vaga_id = v.id AND o.estado = 'ativa' AND o.expira_em > now()) AS oferecida_ate
       FROM app.vaga v
       JOIN app.profissional p ON p.id = v.profissional_id
       JOIN app.tenant t ON t.id = v.tenant_id
       LEFT JOIN app.agendamento a ON a.vaga_id = v.id AND a.estado NOT IN ('cancelada_cidadao', 'cancelada_unidade', 'remarcada')
       WHERE v.unidade_id = $1 AND (lower(v.periodo) AT TIME ZONE t.fuso)::date = $2::date
       ORDER BY lower(v.periodo), p.nome_exibicao`,
      [unidade, data],
    );
    return r.rows;
  });
}

// ------------------------------------------------------------------ gestão de escalas e ausências
export async function cadastrarProfissional(req: Requisicao, dados: unknown): Promise<string> {
  const d = validar(
    z.object({
      vinculoId: uuid,
      nomeExibicao: z.string().trim().min(2).max(120),
      especialidade: z.string().trim().min(2).max(80),
      registro: z.string().trim().toUpperCase().regex(/^[A-Z]{2,6}[- ]?[A-Z]{2}[- ]?[0-9]{1,8}$/).optional(),
    }),
    dados,
  );
  return executar(() =>
    comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "gestao.profissionais", exigeMfa: true }, async (tx) => {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO app.profissional (tenant_id, vinculo_id, pessoa_id, nome_exibicao, especialidade, registro)
         VALUES (app.tenant_atual(), $1, '00000000-0000-0000-0000-000000000000', $2, $3, $4) RETURNING id`,
        [d.vinculoId, d.nomeExibicao, d.especialidade, d.registro ?? null],
      );
      const id = r.rows[0]!.id;
      await registrarAuditoria(tx, { acao: "gestao.profissional_cadastrar", modulo: "gestao", objetoTipo: "profissional", objetoId: id, ip: req.ip });
      return id;
    }),
  );
}

const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** O profissional atende em dias e horários definidos; as vagas são geradas a partir disso. */
export async function criarEscala(req: Requisicao, dados: unknown): Promise<{ escalaId: string; criadas: number; conflitos: number }> {
  const d = validar(
    z
      .object({
        profissionalId: uuid,
        unidadeId: uuid,
        diaSemana: z.number().int().min(0).max(6),
        horaInicio: hora,
        horaFim: hora,
        duracaoMin: z.number().int().min(5).max(240),
        vigenciaInicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        vigenciaFim: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        gerarAte: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .refine((x) => x.horaFim > x.horaInicio),
    dados,
  );
  return executar(() =>
    comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "escala.editar", unidadeId: d.unidadeId }, async (tx) => {
      const e = await tx.query<{ id: string }>(
        `INSERT INTO app.escala (tenant_id, profissional_id, unidade_id, dia_semana, hora_inicio, hora_fim, duracao_min, vigencia_inicio, vigencia_fim)
         VALUES (app.tenant_atual(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [d.profissionalId, d.unidadeId, d.diaSemana, d.horaInicio, d.horaFim, d.duracaoMin, d.vigenciaInicio, d.vigenciaFim ?? null],
      );
      const escalaId = e.rows[0]!.id;
      const g = await tx.query<{ criadas: number; conflitos: number }>("SELECT * FROM app.vagas_gerar($1, $2)", [escalaId, d.gerarAte]);
      const { criadas, conflitos } = g.rows[0]!;
      // Quem está na lista de espera recebe primeiro as vagas novas que combinam com o pedido.
      if (criadas > 0) await tx.query("SELECT app.espera_distribuir(50)");
      await registrarAuditoria(tx, {
        acao: "escala.criar",
        modulo: "agendamento",
        objetoTipo: "escala",
        objetoId: escalaId,
        detalhes: { vagas_criadas: criadas, conflitos },
        ip: req.ip,
      });
      return { escalaId, criadas, conflitos };
    }),
  );
}

/** O profissional não poderá atender: pacientes avisados por e-mail, consultas aguardam remanejamento. */
export async function registrarAusencia(req: Requisicao, dados: unknown): Promise<number> {
  const d = validar(
    z.object({ profissionalId: uuid, unidadeId: uuid, inicio: z.coerce.date(), fim: z.coerce.date(), motivo }).refine((x) => x.fim > x.inicio),
    dados,
  );
  return executar(() =>
    comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "ausencia.registrar", unidadeId: d.unidadeId }, async (tx) => {
      const r = await tx.query<{ n: number }>("SELECT app.ausencia_registrar($1, $2, tstzrange($3, $4, '[)'), $5) AS n", [
        d.profissionalId,
        d.unidadeId,
        d.inicio,
        d.fim,
        d.motivo,
      ]);
      const n = r.rows[0]!.n;
      await registrarAuditoria(tx, { acao: "ausencia.registrar", modulo: "agendamento", objetoTipo: "profissional", objetoId: d.profissionalId, detalhes: { consultas_afetadas: n }, ip: req.ip });
      return n;
    }),
  );
}

// ------------------------------------------------------------------ comprovante
export interface Comprovante {
  dados: DadosComprovante;
}

const SITUACOES_COMPROVANTE: Record<string, string> = {
  marcada: "Agendado",
  confirmada: "Confirmado",
  aguardando_remanejamento: "Aguardando novo horário",
  presente: "Paciente presente",
  atendida: "Concluído",
  faltou: "Não compareceu",
  cancelada_cidadao: "Cancelado pelo paciente",
  cancelada_unidade: "Cancelado pela unidade",
  remarcada: "Remarcado",
};

async function montarComprovante(tx: Conexao, id: string, req: Requisicao): Promise<Comprovante> {
  const r = await tx.query<{
    estado: string; inicio: Date; unidade: string; profissional: string; especialidade: string;
    cidadao_vinculo_id: string; municipio: string; slug: string; fuso: string; cor_primaria: string | null;
  }>(
    `SELECT a.estado, lower(v.periodo) AS inicio, u.nome AS unidade, p.nome_exibicao AS profissional, p.especialidade,
            a.cidadao_vinculo_id, t.nome AS municipio, t.slug, t.fuso, iv.cor_primaria
     FROM app.agendamento a
     JOIN app.vaga v ON v.id = a.vaga_id
     JOIN app.unidade u ON u.id = v.unidade_id
     JOIN app.profissional p ON p.id = v.profissional_id
     JOIN app.tenant t ON t.id = a.tenant_id
     LEFT JOIN app.identidade_visual iv ON iv.tenant_id = a.tenant_id
     WHERE a.id = $1`,
    [id],
  );
  const c = r.rows[0];
  if (!c) throw new ErroAgendamento("consulta_inexistente");
  // Quem é atendido: o titular ou o dependente.
  const nome = await tx.query<{ nome: string }>("SELECT nome FROM app.nomes_de_pacientes(ARRAY[$1]::uuid[])", [id]);

  const logo = await tx.query<{ content_type: "image/png" | "image/jpeg"; dados: Buffer }>(
    `SELECT a.content_type, a.dados FROM app.identidade_visual iv
     JOIN app.arquivo a ON a.tenant_id = iv.tenant_id AND a.chave = iv.logo_chave`,
  );
  const codigo = codigoDoComprovante(id);
  // Primeira emissão grava o hash do código; a segunda via reaproveita (o código é o mesmo).
  const novo = await tx.query(
    `INSERT INTO app.comprovante (tenant_id, agendamento_id, token_hash, emitido_por)
     VALUES (app.tenant_atual(), $1, $2, app.conta_atual()) ON CONFLICT (tenant_id, agendamento_id) DO NOTHING`,
    [id, hashDoCodigo(codigo)],
  );
  await registrarAuditoria(tx, {
    acao: "agenda.comprovante", modulo: "agendamento", objetoTipo: "agendamento", objetoId: id,
    detalhes: { segunda_via: novo.rowCount === 0 }, ip: req.ip,
  });
  return {
    dados: {
      municipio: c.municipio,
      corPrimaria: c.cor_primaria,
      situacao: SITUACOES_COMPROVANTE[c.estado] ?? c.estado,
      inicio: c.inicio,
      fuso: c.fuso,
      unidade: c.unidade,
      profissional: c.profissional,
      especialidade: c.especialidade,
      paciente: nome.rows[0]?.nome ?? "",
      codigo,
      endereco: enderecoDeValidacao(c.slug, codigo),
      emitidoEm: new Date(),
      logo: logo.rows[0] ? { contentType: logo.rows[0].content_type, dados: logo.rows[0].dados } : null,
    },
  };
}

/**
 * Comprovante de uma consulta. O cidadão emite o das próprias consultas; a equipe, o das consultas
 * de unidades em que tem a permissão de ver a agenda (para imprimir na recepção).
 */
export async function emitirComprovante(req: Requisicao, agendamentoId: unknown): Promise<Comprovante> {
  const id = validar(uuid, agendamentoId);
  return executar(async () => {
    try {
      return await comoCidadao(req, async (tx, vinculoId) => {
        await garantirQueEhDoCidadao(tx, id, vinculoId);
        return montarComprovante(tx, id, req);
      });
    } catch (erro) {
      // Não é cidadão aqui, ou a consulta não é dele: tenta como equipe da unidade.
      if (!(erro instanceof ErroAgendamento && (erro.codigo === "nao_e_sua" || erro.codigo === "sem_vinculo_cidadao"))) throw erro;
    }
    try {
      return await comPermissaoNaUnidade(req, "agenda.ver", (tx) => unidadeDaConsulta(tx, id), (tx) => montarComprovante(tx, id, req));
    } catch (erro) {
      // Mesma resposta para "não existe" e "sem permissão": não revela consultas alheias.
      if (erro instanceof AcessoNegado || (erro instanceof ErroAgendamento && erro.codigo === "consulta_inexistente")) {
        throw new ErroAgendamento("nao_e_sua");
      }
      throw erro;
    }
  });
}

export interface ResultadoValidacao {
  situacao: string;
  inicio: Date;
  unidade: string;
  profissional: string;
  especialidade: string;
  iniciais: string;
  municipio: string;
  fuso: string;
  emitidoEm: Date;
}

/** Validação pública, sem sessão. Devolve null para código inválido, de outro município ou inexistente. */
export async function validarComprovante(tenantId: string, codigoDigitado: unknown): Promise<ResultadoValidacao | null> {
  const codigo = normalizarCodigo(codigoDigitado);
  if (!codigo) return null;
  const r = await obterPool().query<{
    estado: string; inicio: Date; unidade: string; profissional: string; especialidade: string;
    iniciais: string | null; municipio: string; fuso: string; emitido_em: Date;
  }>("SELECT * FROM app.comprovante_validar($1, $2)", [tenantId, hashDoCodigo(codigo)]);
  const c = r.rows[0];
  if (!c) return null;
  return {
    situacao: SITUACOES_COMPROVANTE[c.estado] ?? c.estado,
    inicio: c.inicio,
    unidade: c.unidade,
    profissional: c.profissional,
    especialidade: c.especialidade,
    iniciais: c.iniciais ?? "",
    municipio: c.municipio,
    fuso: c.fuso,
    emitidoEm: c.emitido_em,
  };
}
