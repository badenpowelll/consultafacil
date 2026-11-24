import { z } from "zod";
import { comPermissao } from "@/lib/auth/autorizar";
import { exportar, type ArquivoExportado } from "@/lib/exportacao/exportar";
import type { Conexao } from "@/lib/db/pool";
import type { Requisicao } from "@/lib/agendamento/servico";
import { ErroGestao } from "@/lib/gestao/perfis";

/**
 * Menu de auditoria do gestor: consulta paginada e exportação da trilha do município.
 * Exige `auditoria.ver` (ou `auditoria.exportar`) com MFA. A trilha é somente inserção no banco,
 * e os detalhes já entram sem dado pessoal (ver src/lib/auditoria.ts).
 */
export const POR_PAGINA = 50;

const filtros = z.object({
  de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  modulo: z.string().regex(/^[a-z_]{2,30}$/).optional(),
  acao: z.string().regex(/^[a-z_.]{2,60}$/).optional(),
  pagina: z.coerce.number().int().min(1).max(1000).default(1),
});
export type FiltrosAuditoria = z.input<typeof filtros>;

export interface LinhaAuditoria {
  id: string;
  criado_em: Date;
  quem: string | null;
  acao: string;
  modulo: string;
  objeto_tipo: string | null;
  objeto_id: string | null;
  detalhes: Record<string, unknown>;
  ip: string | null;
}

function validarFiltros(valor: unknown): z.output<typeof filtros> {
  const r = filtros.safeParse(valor);
  if (!r.success) throw new ErroGestao("dados_invalidos");
  return r.data;
}



async function buscar(tx: Conexao, f: z.output<typeof filtros>, limite: number, deslocamento: number): Promise<LinhaAuditoria[]> {
  const r = await tx.query<Omit<LinhaAuditoria, "quem"> & { conta_id: string | null }>(
    `SELECT a.id::text, a.criado_em, a.conta_id, a.acao, a.modulo, a.objeto_tipo, a.objeto_id, a.detalhes, host(a.ip) AS ip
     FROM app.auditoria a JOIN app.tenant t ON t.id = a.tenant_id
     -- Datas do filtro no fuso do município, inclusivas.
     WHERE ($1::date IS NULL OR a.criado_em >= ($1::date AT TIME ZONE t.fuso))
       AND ($2::date IS NULL OR a.criado_em < (($2::date + 1) AT TIME ZONE t.fuso))
       AND ($3::text IS NULL OR a.modulo = $3)
       AND ($4::text IS NULL OR a.acao LIKE $4 || '%')
     ORDER BY a.criado_em DESC, a.id DESC
     LIMIT $5 OFFSET $6`,
    [f.de ?? null, f.ate ?? null, f.modulo ?? null, f.acao ?? null, limite, deslocamento],
  );
  const contas = [...new Set(r.rows.map((l) => l.conta_id).filter((c): c is string => !!c))];
  const nomes = new Map<string, string>();
  if (contas.length) {
    const n = await tx.query<{ conta_id: string; nome: string }>("SELECT * FROM app.nomes_de_contas($1::uuid[])", [contas]);
    for (const l of n.rows) nomes.set(l.conta_id, l.nome);
  }
  return r.rows.map(({ conta_id, ...l }) => ({ ...l, quem: conta_id ? nomes.get(conta_id) ?? "Conta sem vínculo atual" : null }));
}

export interface PaginaAuditoria {
  linhas: LinhaAuditoria[];
  modulos: string[];
  temMais: boolean;
  pagina: number;
}

export async function consultarAuditoria(req: Requisicao, valor: unknown): Promise<PaginaAuditoria> {
  const f = validarFiltros(valor);
  return comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "auditoria.ver", exigeMfa: true }, async (tx) => {
    const linhas = await buscar(tx, f, POR_PAGINA + 1, (f.pagina - 1) * POR_PAGINA);
    const modulos = await tx.query<{ modulo: string }>("SELECT DISTINCT modulo FROM app.auditoria ORDER BY modulo LIMIT 50");
    return { linhas: linhas.slice(0, POR_PAGINA), modulos: modulos.rows.map((m) => m.modulo), temMais: linhas.length > POR_PAGINA, pagina: f.pagina };
  });
}

export async function exportarAuditoria(req: Requisicao, valor: unknown): Promise<ArquivoExportado> {
  const f = validarFiltros(valor);
  return exportar(
    { sessao: req.sessao, tenantDaUrl: req.tenantDaUrl },
    {
      relatorio: "auditoria",
      permissao: "auditoria.exportar",
      colunas: [
        { titulo: "Quando", tipo: "data", valor: (l: LinhaAuditoria) => l.criado_em },
        { titulo: "Quem", tipo: "nome", valor: (l: LinhaAuditoria) => l.quem ?? "" },
        { titulo: "Ação", tipo: "texto", valor: (l: LinhaAuditoria) => l.acao },
        { titulo: "Módulo", tipo: "texto", valor: (l: LinhaAuditoria) => l.modulo },
        { titulo: "Objeto", tipo: "texto", valor: (l: LinhaAuditoria) => [l.objeto_tipo, l.objeto_id].filter(Boolean).join(" ") },
        { titulo: "Detalhes", tipo: "texto", valor: (l: LinhaAuditoria) => JSON.stringify(l.detalhes) },
      ],
      consulta: (tx, limite) => buscar(tx, f, limite, 0),
    },
  );
}
