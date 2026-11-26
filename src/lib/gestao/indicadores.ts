import { z } from "zod";
import type { Conexao } from "@/lib/db/pool";
import { AcessoNegado, comPermissao } from "@/lib/auth/autorizar";
import { unidadesComPermissao, type Opcao } from "@/lib/agendamento/consultas";
import { exportar, type ArquivoExportado } from "@/lib/exportacao/exportar";
import type { Requisicao } from "@/lib/agendamento/servico";

/**
 * Indicadores do município para o gestor: ocupação, faltas, vagas ociosas, cancelamentos,
 * tempo de espera e demanda da lista de espera. Só números agregados: nenhum dado pessoal sai
 * daqui. Cada pessoa vê só as unidades em que tem `gestao.painel` (o gestor vê todas).
 */
export class FiltroInvalido extends Error {
  constructor() {
    super("Período inválido: use datas e no máximo 366 dias.");
    this.name = "FiltroInvalido";
  }
}

const data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const esquemaFiltro = z
  .object({
    de: data,
    ate: data,
    unidadeId: z.union([z.literal(""), z.string().uuid()]).nullish().transform((v) => v || null),
  })
  .refine((f) => f.ate >= f.de && (Date.parse(f.ate) - Date.parse(f.de)) / 86_400_000 <= 366);

export type Filtro = z.output<typeof esquemaFiltro>;

export function validarFiltro(valor: unknown): Filtro {
  const r = esquemaFiltro.safeParse(valor);
  if (!r.success) throw new FiltroInvalido();
  return r.data;
}

export interface LinhaIndicador {
  unidade: string;
  especialidade: string;
  vagas: number;
  ocupadas: number;
  ociosas: number;
  atendidas: number;
  faltas: number;
  canceladas_cidadao: number;
  canceladas_unidade: number;
  /** Mediana, em dias, entre marcar e a data da consulta. */
  espera_mediana_dias: number | null;
}

export interface Totais {
  vagas: number;
  ocupadas: number;
  ociosas: number;
  atendidas: number;
  faltas: number;
  canceladas_cidadao: number;
  canceladas_unidade: number;
  ocupacao: number | null;
  absenteismo: number | null;
  espera_mediana_dias: number | null;
}

export interface DemandaEspera {
  especialidade: string;
  aguardando: number;
  com_prioridade: number;
  dias_na_fila_mediana: number | null;
  atendidos_pela_fila: number;
}

export interface Painel {
  filtro: Filtro;
  unidades: Opcao[];
  totais: Totais;
  linhas: LinhaIndicador[];
  demanda: DemandaEspera[];
}

/** Unidades que a pessoa pode ver; com uma unidade escolhida, só ela (se permitida). */
async function escopo(req: Requisicao, permissao: string, unidadeId: string | null): Promise<{ todas: Opcao[]; ids: string[] }> {
  const todas = await unidadesComPermissao(req, permissao);
  if (todas.length === 0) throw new AcessoNegado("sem_permissao");
  if (!unidadeId) return { todas, ids: todas.map((u) => u.id) };
  if (!todas.some((u) => u.id === unidadeId)) throw new AcessoNegado("sem_permissao");
  return { todas, ids: [unidadeId] };
}

// Período em datas locais do município, de "de" até "ate" (inclusive): $2 e $3 em todas as consultas.

async function linhasPorUnidade(tx: Conexao, ids: string[], f: Filtro): Promise<LinhaIndicador[]> {
  const r = await tx.query<LinhaIndicador>(
    `WITH base AS (
       SELECT v.id, u.nome AS unidade, p.especialidade, v.estado AS estado_vaga, lower(v.periodo) AS inicio,
              a.estado AS estado_consulta, a.criado_em AS marcada_em
       FROM app.vaga v
       JOIN app.tenant t ON t.id = v.tenant_id
       JOIN app.unidade u ON u.id = v.unidade_id
       JOIN app.profissional p ON p.id = v.profissional_id
       LEFT JOIN LATERAL (
         SELECT a.estado, a.criado_em FROM app.agendamento a
         WHERE a.vaga_id = v.id AND a.estado NOT IN ('cancelada_cidadao', 'cancelada_unidade', 'remarcada')
         ORDER BY a.criado_em DESC LIMIT 1
       ) a ON true
       WHERE v.unidade_id = ANY($1::uuid[]) AND (lower(v.periodo) AT TIME ZONE t.fuso)::date BETWEEN $2::date AND $3::date
     ), canceladas AS (
       SELECT u.nome AS unidade, p.especialidade,
              count(*) FILTER (WHERE a.estado = 'cancelada_cidadao')::int AS canceladas_cidadao,
              count(*) FILTER (WHERE a.estado = 'cancelada_unidade')::int AS canceladas_unidade
       FROM app.agendamento a
       JOIN app.vaga v ON v.id = a.vaga_id
       JOIN app.tenant t ON t.id = v.tenant_id
       JOIN app.unidade u ON u.id = v.unidade_id
       JOIN app.profissional p ON p.id = v.profissional_id
       WHERE v.unidade_id = ANY($1::uuid[]) AND (lower(v.periodo) AT TIME ZONE t.fuso)::date BETWEEN $2::date AND $3::date
         AND a.estado IN ('cancelada_cidadao', 'cancelada_unidade')
       GROUP BY 1, 2
     ), agregado AS (
       SELECT unidade, especialidade,
              count(*) FILTER (WHERE estado_vaga <> 'bloqueada')::int AS vagas,
              count(*) FILTER (WHERE estado_consulta IS NOT NULL)::int AS ocupadas,
              count(*) FILTER (WHERE estado_consulta IS NULL AND estado_vaga = 'livre' AND inicio < now())::int AS ociosas,
              count(*) FILTER (WHERE estado_consulta IN ('atendida', 'presente'))::int AS atendidas,
              count(*) FILTER (WHERE estado_consulta = 'faltou')::int AS faltas,
              round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM inicio - marcada_em) / 86400.0)
                     FILTER (WHERE marcada_em IS NOT NULL))::numeric, 1)::float AS espera_mediana_dias
       FROM base GROUP BY 1, 2
     )
     SELECT g.*, coalesce(c.canceladas_cidadao, 0) AS canceladas_cidadao, coalesce(c.canceladas_unidade, 0) AS canceladas_unidade
     FROM agregado g LEFT JOIN canceladas c USING (unidade, especialidade)
     ORDER BY g.unidade, g.especialidade`,
    [ids, f.de, f.ate],
  );
  return r.rows;
}

async function mediana(tx: Conexao, ids: string[], f: Filtro): Promise<number | null> {
  const r = await tx.query<{ m: number | null }>(
    `SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM lower(v.periodo) - a.criado_em) / 86400.0))::numeric, 1)::float AS m
     FROM app.agendamento a JOIN app.vaga v ON v.id = a.vaga_id JOIN app.tenant t ON t.id = v.tenant_id
     WHERE v.unidade_id = ANY($1::uuid[]) AND (lower(v.periodo) AT TIME ZONE t.fuso)::date BETWEEN $2::date AND $3::date AND a.estado NOT IN ('cancelada_cidadao', 'cancelada_unidade', 'remarcada')`,
    [ids, f.de, f.ate],
  );
  return r.rows[0]?.m ?? null;
}

/**
 * Demanda reprimida: quem está na lista de espera agora, por especialidade. Pedidos para
 * "qualquer unidade" contam para todo gestor que vê alguma unidade (a fila é do município).
 */
async function demanda(tx: Conexao, ids: string[], f: Filtro): Promise<DemandaEspera[]> {
  const r = await tx.query<DemandaEspera>(
    `SELECT min(e.especialidade) AS especialidade,
            count(*) FILTER (WHERE e.estado = 'aguardando' AND e.valida_ate >= current_date)::int AS aguardando,
            count(*) FILTER (WHERE e.estado = 'aguardando' AND e.valida_ate >= current_date AND e.prioridade IS NOT NULL)::int AS com_prioridade,
            round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM now() - e.criado_em) / 86400.0)
                   FILTER (WHERE e.estado = 'aguardando' AND e.valida_ate >= current_date))::numeric, 1)::float AS dias_na_fila_mediana,
            count(*) FILTER (WHERE e.estado = 'atendida' AND e.encerrada_em::date BETWEEN $2::date AND $3::date)::int AS atendidos_pela_fila
     FROM app.espera e
     WHERE e.unidade_id IS NULL OR e.unidade_id = ANY($1::uuid[])
     GROUP BY lower(e.especialidade)
     HAVING count(*) FILTER (WHERE e.estado = 'aguardando' AND e.valida_ate >= current_date) > 0
         OR count(*) FILTER (WHERE e.estado = 'atendida' AND e.encerrada_em::date BETWEEN $2::date AND $3::date) > 0
     ORDER BY 2 DESC, 1`,
    [ids, f.de, f.ate],
  );
  return r.rows;
}

function proporcao(parte: number, todo: number): number | null {
  return todo > 0 ? Math.round((parte / todo) * 1000) / 10 : null;
}

function somar(linhas: LinhaIndicador[], espera: number | null): Totais {
  const s = (k: keyof LinhaIndicador) => linhas.reduce((t, l) => t + (Number(l[k]) || 0), 0);
  const vagas = s("vagas");
  const ocupadas = s("ocupadas");
  const atendidas = s("atendidas");
  const faltas = s("faltas");
  return {
    vagas, ocupadas, ociosas: s("ociosas"), atendidas, faltas,
    canceladas_cidadao: s("canceladas_cidadao"), canceladas_unidade: s("canceladas_unidade"),
    ocupacao: proporcao(ocupadas, vagas),
    // Faltas sobre quem tinha consulta já resolvida (atendido ou faltou).
    absenteismo: proporcao(faltas, faltas + atendidas),
    espera_mediana_dias: espera,
  };
}

export async function painelDoMunicipio(req: Requisicao, valor: unknown): Promise<Painel> {
  const filtro = validarFiltro(valor);
  const { todas, ids } = await escopo(req, "gestao.painel", filtro.unidadeId);
  return comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "gestao.painel", qualquerUnidade: true }, async (tx) => {
    const linhas = await linhasPorUnidade(tx, ids, filtro);
    return {
      filtro,
      unidades: todas,
      linhas,
      totais: somar(linhas, await mediana(tx, ids, filtro)),
      demanda: await demanda(tx, ids, filtro),
    };
  });
}

// ------------------------------------------------------------------ exportação
/** Indicadores por unidade e especialidade: só números, sem dado pessoal. */
export async function exportarIndicadores(req: Requisicao, valor: unknown): Promise<ArquivoExportado> {
  const filtro = validarFiltro(valor);
  const { ids } = await escopo(req, "gestao.exportar", filtro.unidadeId);
  return exportar(
    { sessao: req.sessao, tenantDaUrl: req.tenantDaUrl },
    {
      relatorio: "indicadores",
      colunas: [
        { titulo: "Unidade", tipo: "texto", valor: (l: LinhaIndicador) => l.unidade },
        { titulo: "Especialidade", tipo: "texto", valor: (l: LinhaIndicador) => l.especialidade },
        { titulo: "Vagas", tipo: "numero", valor: (l: LinhaIndicador) => l.vagas },
        { titulo: "Ocupadas", tipo: "numero", valor: (l: LinhaIndicador) => l.ocupadas },
        { titulo: "Ociosas", tipo: "numero", valor: (l: LinhaIndicador) => l.ociosas },
        { titulo: "Atendidas", tipo: "numero", valor: (l: LinhaIndicador) => l.atendidas },
        { titulo: "Faltas", tipo: "numero", valor: (l: LinhaIndicador) => l.faltas },
        { titulo: "Canceladas pelo cidadão", tipo: "numero", valor: (l: LinhaIndicador) => l.canceladas_cidadao },
        { titulo: "Canceladas pela unidade", tipo: "numero", valor: (l: LinhaIndicador) => l.canceladas_unidade },
        { titulo: "Espera mediana (dias)", tipo: "numero", valor: (l: LinhaIndicador) => l.espera_mediana_dias },
      ],
      consulta: async (tx, limite) => (await linhasPorUnidade(tx, ids, filtro)).slice(0, limite),
    },
  );
}

interface LinhaConsulta {
  inicio: Date;
  unidade: string;
  profissional: string;
  especialidade: string;
  estado: string;
  marcada_em: Date;
  canal: string;
  dependente: boolean;
}

/**
 * Consultas do período, uma por linha, sem nome nem documento do paciente: para conferência
 * e análise externa. Quem precisa de um paciente específico abre a ficha na tela (auditado).
 */
export async function exportarConsultas(req: Requisicao, valor: unknown): Promise<ArquivoExportado> {
  const filtro = validarFiltro(valor);
  const { ids } = await escopo(req, "gestao.exportar", filtro.unidadeId);
  return exportar(
    { sessao: req.sessao, tenantDaUrl: req.tenantDaUrl },
    {
      relatorio: "consultas",
      colunas: [
        { titulo: "Data e hora", tipo: "data", valor: (l: LinhaConsulta) => l.inicio },
        { titulo: "Unidade", tipo: "texto", valor: (l: LinhaConsulta) => l.unidade },
        { titulo: "Profissional", tipo: "texto", valor: (l: LinhaConsulta) => l.profissional },
        { titulo: "Especialidade", tipo: "texto", valor: (l: LinhaConsulta) => l.especialidade },
        { titulo: "Situação", tipo: "texto", valor: (l: LinhaConsulta) => l.estado },
        { titulo: "Marcada em", tipo: "data", valor: (l: LinhaConsulta) => l.marcada_em },
        { titulo: "Marcada por", tipo: "texto", valor: (l: LinhaConsulta) => l.canal },
        { titulo: "Dependente", tipo: "texto", valor: (l: LinhaConsulta) => (l.dependente ? "sim" : "não") },
      ],
      consulta: async (tx, limite) =>
        (await tx.query<LinhaConsulta>(
          `SELECT lower(v.periodo) AS inicio, u.nome AS unidade, p.nome_exibicao AS profissional, p.especialidade, a.estado,
                  a.criado_em AS marcada_em,
                  CASE WHEN a.marcada_por IS NULL THEN 'sistema'
                       WHEN a.marcada_por = (SELECT c.conta_id FROM app.vinculo c WHERE c.id = a.cidadao_vinculo_id) THEN 'cidadão'
                       ELSE 'equipe' END AS canal,
                  a.dependente_id IS NOT NULL AS dependente
           FROM app.agendamento a
           JOIN app.vaga v ON v.id = a.vaga_id
           JOIN app.tenant t ON t.id = v.tenant_id
           JOIN app.unidade u ON u.id = v.unidade_id
           JOIN app.profissional p ON p.id = v.profissional_id
           WHERE v.unidade_id = ANY($1::uuid[]) AND (lower(v.periodo) AT TIME ZONE t.fuso)::date BETWEEN $2::date AND $3::date
           ORDER BY lower(v.periodo), u.nome
           LIMIT $4`,
          [ids, filtro.de, filtro.ate, limite],
        )).rows,
    },
  );
}
