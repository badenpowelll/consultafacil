import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ClientBase } from "pg";
import { filtrarDetalhes } from "@/lib/auditoria";
import { neutralizarFormula } from "@/lib/exportacao/csv";
import { decifrar } from "@/lib/security/crypto";

/**
 * Ciclo de vida do município, para a equipe de operação (Super Admin). Roda fora do app, por
 * scripts/municipio.ts, com a conexão administrativa: o processo web nunca tem essa credencial.
 *
 *   provisionando → ativo → suspenso ⇄ ativo
 *   ativo | suspenso → encerrando → encerrado (só depois da exportação completa)
 *
 * Suspender, encerrar e concluir revogam as sessões do município. Com o município fora de 'ativo',
 * o endereço mostra um aviso, links e comprovantes deixam de abrir, rotinas e e-mails param
 * (ficam guardados) e os dados continuam intactos. Toda mudança vai para a auditoria.
 */
export type EstadoMunicipio = "provisionando" | "ativo" | "suspenso" | "encerrando" | "encerrado";

const TRANSICOES: Record<EstadoMunicipio, EstadoMunicipio[]> = {
  provisionando: ["ativo"],
  ativo: ["suspenso", "encerrando"],
  suspenso: ["ativo", "encerrando"],
  encerrando: ["encerrado"],
  encerrado: [],
};

export class OperacaoRecusada extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "OperacaoRecusada";
  }
}

const OPERADOR = /^[a-z][a-z0-9._-]{1,39}$/;

function conferirOperador(operador: string): void {
  if (!OPERADOR.test(operador)) throw new OperacaoRecusada("Identificação do operador inválida (use um apelido curto, sem e-mail)");
}

interface Municipio { id: string; nome: string; estado: EstadoMunicipio }

async function buscar(db: ClientBase, slug: string, bloquear = false): Promise<Municipio> {
  const r = await db.query<Municipio>(
    bloquear ? "SELECT id, nome, estado FROM app.tenant WHERE slug = $1 FOR UPDATE" : "SELECT id, nome, estado FROM app.tenant WHERE slug = $1",
    [slug],
  );
  if (!r.rows[0]) throw new OperacaoRecusada("Município não encontrado");
  return r.rows[0];
}

async function auditar(db: ClientBase, tenantId: string, acao: string, detalhes: Record<string, string | number | boolean | null>): Promise<void> {
  await db.query(
    "INSERT INTO app.auditoria (tenant_id, conta_id, acao, modulo, objeto_tipo, objeto_id, detalhes) VALUES ($1, NULL, $2, 'operacao', 'municipio', $3, $4)",
    [tenantId, acao, tenantId, JSON.stringify(filtrarDetalhes(detalhes))],
  );
}

export interface Situacao {
  nome: string;
  estado: EstadoMunicipio;
  sessoesAtivas: number;
  notificacoesPendentes: number;
  consultasFuturas: number;
  exportadoEm: Date | null;
}

export async function situacaoDoMunicipio(db: ClientBase, slug: string): Promise<Situacao> {
  const m = await buscar(db, slug);
  const r = await db.query<{ sessoes: number; pendentes: number; futuras: number; exportado: Date | null }>(
    `SELECT
       (SELECT count(*)::int FROM app.sessao WHERE tenant_id = $1 AND revogada_em IS NULL AND expira_absoluta > now()) AS sessoes,
       (SELECT count(*)::int FROM app.notificacao WHERE tenant_id = $1 AND estado = 'pendente') AS pendentes,
       (SELECT count(*)::int FROM app.agendamento a JOIN app.vaga v ON v.tenant_id = a.tenant_id AND v.id = a.vaga_id
         WHERE a.tenant_id = $1 AND a.estado IN ('marcada', 'confirmada', 'aguardando_remanejamento') AND lower(v.periodo) > now()) AS futuras,
       (SELECT max(criado_em) FROM app.auditoria WHERE tenant_id = $1 AND acao = 'municipio.exportar_completo') AS exportado`,
    [m.id],
  );
  const l = r.rows[0]!;
  return { nome: m.nome, estado: m.estado, sessoesAtivas: l.sessoes, notificacoesPendentes: l.pendentes, consultasFuturas: l.futuras, exportadoEm: l.exportado };
}

export interface MudancaDeEstado {
  slug: string;
  para: EstadoMunicipio;
  operador: string;
  motivo: string;
}

export async function alterarEstado(db: ClientBase, m: MudancaDeEstado): Promise<{ de: EstadoMunicipio; para: EstadoMunicipio; sessoesRevogadas: number }> {
  conferirOperador(m.operador);
  const motivo = m.motivo.trim();
  if (motivo.length < 5 || motivo.length > 200) throw new OperacaoRecusada("Informe o motivo (5 a 200 caracteres)");

  await db.query("BEGIN");
  try {
    const atual = await buscar(db, m.slug, true);
    if (!TRANSICOES[atual.estado].includes(m.para)) {
      throw new OperacaoRecusada(`Mudança não permitida: ${atual.estado} → ${m.para}`);
    }
    if (m.para === "encerrado") {
      const e = await db.query("SELECT 1 FROM app.auditoria WHERE tenant_id = $1 AND acao = 'municipio.exportar_completo' LIMIT 1", [atual.id]);
      if (e.rowCount === 0) throw new OperacaoRecusada("Faça a exportação completa e entregue à prefeitura antes de concluir o encerramento");
    }
    await db.query("UPDATE app.tenant SET estado = $2, alterado_em = now() WHERE id = $1", [atual.id, m.para]);
    let sessoesRevogadas = 0;
    if (m.para !== "ativo") {
      const r = await db.query<{ n: number }>("SELECT app.sessao_revogar_municipio($1, $2) AS n", [atual.id, `municipio_${m.para}`]);
      sessoesRevogadas = r.rows[0]!.n;
    }
    await auditar(db, atual.id, "municipio.alterar_estado", { de: atual.estado, para: m.para, operador: m.operador, motivo, sessoes_revogadas: sessoesRevogadas });
    await db.query("COMMIT");
    return { de: atual.estado, para: m.para, sessoesRevogadas };
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
}

// ---------------------------------------------------------------- contenção de incidente

/**
 * Bloqueia (ou desbloqueia) uma conta em todos os municípios e revoga as sessões dela. Usado na
 * contenção de incidente: credencial vazada, acesso fora do padrão. O id da conta vem da
 * auditoria (conta_id), então o operador não precisa ver CPF nem nome.
 */
export async function bloquearConta(db: ClientBase, m: { contaId: string; bloquear: boolean; operador: string; motivo: string }): Promise<{ sessoesRevogadas: number; municipios: number }> {
  conferirOperador(m.operador);
  const motivo = m.motivo.trim();
  if (motivo.length < 5 || motivo.length > 200) throw new OperacaoRecusada("Informe o motivo (5 a 200 caracteres)");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(m.contaId)) throw new OperacaoRecusada("Id de conta inválido");
  await db.query("BEGIN");
  try {
    const c = await db.query("UPDATE app.conta SET bloqueada = $2 WHERE id = $1 RETURNING id", [m.contaId, m.bloquear]);
    if (c.rowCount === 0) throw new OperacaoRecusada("Conta não encontrada");
    let sessoesRevogadas = 0;
    if (m.bloquear) {
      const r = await db.query<{ n: number }>("SELECT app.sessao_revogar_conta($1, 'conta_bloqueada') AS n", [m.contaId]);
      sessoesRevogadas = r.rows[0]!.n;
    }
    const t = await db.query<{ tenant_id: string }>("SELECT DISTINCT tenant_id FROM app.vinculo WHERE conta_id = $1", [m.contaId]);
    for (const { tenant_id } of t.rows) {
      await db.query(
        "INSERT INTO app.auditoria (tenant_id, conta_id, acao, modulo, objeto_tipo, objeto_id, detalhes) VALUES ($1, NULL, $2, 'operacao', 'conta', $3, $4)",
        [tenant_id, m.bloquear ? "conta.bloquear" : "conta.desbloquear", m.contaId,
          JSON.stringify(filtrarDetalhes({ operador: m.operador, motivo, sessoes_revogadas: sessoesRevogadas }))],
      );
    }
    await db.query("COMMIT");
    return { sessoesRevogadas, municipios: t.rowCount ?? 0 };
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
}

// ---------------------------------------------------------------- exportação completa

/**
 * Tabelas do município entregues na exportação completa. Ficam de fora só controles internos
 * (sessões, links, fila de e-mails, hashes de comprovante, reservas de horário), que não são
 * informação da prefeitura e não servem fora do sistema.
 */
const TABELAS: Record<string, string> = {
  unidades: "SELECT * FROM app.unidade WHERE tenant_id = $1 ORDER BY criado_em, id",
  profissionais: "SELECT * FROM app.profissional WHERE tenant_id = $1 ORDER BY criado_em, id",
  escalas: "SELECT * FROM app.escala WHERE tenant_id = $1 ORDER BY criado_em, id",
  vagas: "SELECT * FROM app.vaga WHERE tenant_id = $1 ORDER BY lower(periodo), id",
  agendamentos: "SELECT * FROM app.agendamento WHERE tenant_id = $1 ORDER BY criado_em, id",
  agendamentos_historico: "SELECT * FROM app.agendamento_evento WHERE tenant_id = $1 ORDER BY id",
  lista_de_espera: "SELECT * FROM app.espera WHERE tenant_id = $1 ORDER BY criado_em, id",
  ofertas_de_vaga: "SELECT * FROM app.oferta WHERE tenant_id = $1 ORDER BY criado_em, id",
  dependentes: "SELECT * FROM app.dependente WHERE tenant_id = $1 ORDER BY criado_em, id",
  vinculos: "SELECT v.*, c.pessoa_id FROM app.vinculo v JOIN app.conta c ON c.id = v.conta_id WHERE v.tenant_id = $1 ORDER BY v.criado_em, v.id",
  perfis: "SELECT * FROM app.perfil_acesso WHERE tenant_id = $1 ORDER BY criado_em, id",
  perfis_permissoes: "SELECT * FROM app.perfil_permissao WHERE tenant_id = $1 ORDER BY perfil_id, permissao",
  perfis_atribuidos: "SELECT * FROM app.vinculo_perfil WHERE tenant_id = $1 ORDER BY vinculo_id, id",
  aceites_de_termos: "SELECT * FROM app.aceite_termos WHERE tenant_id = $1 ORDER BY criado_em, id",
  modulos: "SELECT * FROM app.modulo_tenant WHERE tenant_id = $1 ORDER BY modulo",
  identidade_visual: "SELECT * FROM app.identidade_visual WHERE tenant_id = $1",
  auditoria: "SELECT * FROM app.auditoria WHERE tenant_id = $1 ORDER BY id",
};

/** Pessoas que aparecem em algum registro do município (contas, dependentes, pacientes, profissionais). */
const PESSOAS = `
  WITH ids AS (
    SELECT c.pessoa_id AS id FROM app.vinculo v JOIN app.conta c ON c.id = v.conta_id WHERE v.tenant_id = $1
    UNION SELECT pessoa_id FROM app.dependente WHERE tenant_id = $1
    UNION SELECT pessoa_id FROM app.agendamento WHERE tenant_id = $1
    UNION SELECT pessoa_id FROM app.espera WHERE tenant_id = $1
    UNION SELECT pessoa_id FROM app.profissional WHERE tenant_id = $1 AND pessoa_id IS NOT NULL
  )
  SELECT p.id, p.nome, p.nascimento, p.cpf_cifrado, p.cns_cifrado, p.email_cifrado, p.criado_em
  FROM app.pessoa p JOIN ids ON ids.id = p.id ORDER BY p.criado_em, p.id`;

function textoDaCelula(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function celula(v: unknown): string {
  return `"${neutralizarFormula(textoDaCelula(v)).replace(/"/g, '""').replace(/[\r\n]+/g, " ")}"`;
}

/** CSV em UTF-8 com BOM, separado por ponto e vírgula; colunas binárias (cifradas, hashes) ficam de fora. */
export function csvDeLinhas(linhas: ReadonlyArray<Record<string, unknown>>, colunas?: string[]): string {
  const nomes = colunas ?? Object.keys(linhas[0] ?? {}).filter((c) => !linhas.some((l) => Buffer.isBuffer(l[c])));
  const corpo = linhas.map((l) => nomes.map((c) => celula(l[c])).join(";"));
  return "﻿" + [nomes.map(celula).join(";"), ...corpo].join("\r\n") + "\r\n";
}

function abrir(cifrado: unknown, contexto: string): string | null {
  if (!Buffer.isBuffer(cifrado)) return null;
  try {
    return decifrar(cifrado, contexto);
  } catch {
    return "(não foi possível decifrar)";
  }
}

export interface ExportacaoCompleta {
  id: string;
  pasta: string;
  arquivos: { nome: string; linhas: number; sha256: string }[];
}

/**
 * Exportação completa em formato aberto (CSV + arquivos de imagem), para entregar à prefeitura
 * no encerramento ou a pedido dela. Contém dados pessoais em claro: a pasta é criada só para o
 * dono (0700), não pode existir antes, e o manifesto com SHA-256 permite conferir a entrega.
 */
export async function exportarMunicipio(db: ClientBase, slug: string, destino: string, operador: string): Promise<ExportacaoCompleta> {
  conferirOperador(operador);
  const m = await buscar(db, slug);
  const id = randomUUID();
  const pasta = path.resolve(destino);
  await mkdir(pasta, { recursive: false, mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
    throw new OperacaoRecusada(e.code === "EEXIST" ? "A pasta de destino já existe; escolha uma nova" : "Não foi possível criar a pasta de destino");
  });
  await mkdir(path.join(pasta, "arquivos"), { mode: 0o700 });

  const arquivos: ExportacaoCompleta["arquivos"] = [];
  const gravar = async (nome: string, conteudo: string | Buffer, linhas: number) => {
    await writeFile(path.join(pasta, nome), conteudo, { mode: 0o600, flag: "wx" });
    arquivos.push({ nome, linhas, sha256: createHash("sha256").update(conteudo).digest("hex") });
  };

  // Leitura consistente: tudo no mesmo instante, mesmo com o município ainda em uso.
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    for (const [nome, sql] of Object.entries(TABELAS)) {
      const r = await db.query<Record<string, unknown>>(sql, [m.id]);
      const colunas = r.fields.map((f) => f.name).filter((c) => !r.rows.some((l) => Buffer.isBuffer(l[c])));
      await gravar(`${nome}.csv`, csvDeLinhas(r.rows, colunas), r.rowCount ?? 0);
    }
    const p = await db.query<Record<string, unknown>>(PESSOAS, [m.id]);
    const pessoas = p.rows.map((l) => ({
      id: l.id, nome: l.nome, nascimento: l.nascimento instanceof Date ? l.nascimento.toISOString().slice(0, 10) : l.nascimento,
      cpf: abrir(l.cpf_cifrado, "pessoa.cpf"), cns: abrir(l.cns_cifrado, "pessoa.cns"), email: abrir(l.email_cifrado, "pessoa.email"),
      criado_em: l.criado_em,
    }));
    await gravar("pessoas.csv", csvDeLinhas(pessoas, ["id", "nome", "nascimento", "cpf", "cns", "email", "criado_em"]), pessoas.length);

    const imgs = await db.query<{ chave: string; content_type: string; dados: Buffer }>(
      "SELECT chave, content_type, dados FROM app.arquivo WHERE tenant_id = $1 ORDER BY chave", [m.id],
    );
    for (const a of imgs.rows) {
      const ext = a.content_type === "image/png" ? "png" : a.content_type === "image/jpeg" ? "jpg" : "bin";
      await gravar(`arquivos/${a.chave.replace(/[^A-Za-z0-9_-]/g, "_")}.${ext}`, a.dados, 1);
    }
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }

  const agora = new Date().toISOString();
  await writeFile(path.join(pasta, "LEIA-ME.txt"), [
    `Exportação completa do município ${m.nome}`,
    `Identificador: ${id}`,
    `Gerada em: ${agora} (UTC)`,
    "",
    "Formato: CSV em UTF-8, separado por ponto e vírgula, primeira linha com o nome das colunas.",
    "Datas e horas em ISO 8601 (UTC). Períodos de vaga no formato de intervalo do PostgreSQL: [início,fim).",
    "As tabelas se ligam pelos identificadores (colunas id e *_id). pessoas.csv reúne quem aparece nos registros.",
    "manifesto.sha256 traz o SHA-256 de cada arquivo para conferir a entrega (sha256sum -c manifesto.sha256).",
    "",
    "ATENÇÃO: contém dados pessoais e dados de saúde (LGPD, art. 11). Guarde em local protegido, entregue",
    "por meio seguro, registre o recebimento e apague as cópias intermediárias depois da entrega.",
    "",
  ].join("\r\n"), { mode: 0o600, flag: "wx" });
  await writeFile(path.join(pasta, "manifesto.sha256"), arquivos.map((a) => `${a.sha256}  ${a.nome}`).join("\n") + "\n", { mode: 0o600, flag: "wx" });

  const manifesto = createHash("sha256").update(arquivos.map((a) => `${a.sha256}  ${a.nome}`).join("\n")).digest("hex");
  await auditar(db, m.id, "municipio.exportar_completo", {
    exportacao: id, operador, arquivos: arquivos.length, linhas: arquivos.reduce((s, a) => s + a.linhas, 0), manifesto,
  });
  return { id, pasta, arquivos };
}
