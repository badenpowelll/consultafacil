import { randomUUID } from "node:crypto";
import type { Conexao } from "@/lib/db/pool";
import { registrarAuditoria } from "@/lib/auditoria";
import { comPermissao, type Pedido } from "@/lib/auth/autorizar";
import { exigirLimite } from "@/lib/security/limites";
import { gerarCsv, type ColunaExportacao } from "@/lib/exportacao/csv";

/**
 * Único caminho para exportar dados do sistema. Camadas, em ordem:
 *  1. limite de exportações por conta (tira o incentivo de baixar a base aos pedaços);
 *  2. permissão `gestao.exportar` (ou outra mais restrita) com MFA verificado na sessão;
 *  3. RLS: a consulta roda dentro do município da sessão;
 *  4. teto de linhas: acima dele a exportação é recusada, não cortada em silêncio;
 *  5. colunas tipadas com máscara obrigatória (ver csv.ts) e neutralização de fórmulas;
 *  6. auditoria com id da exportação, quantidade e colunas; o mesmo id vai no rodapé do arquivo.
 */
export const LIMITE_LINHAS = 5_000;

export class ExportacaoGrandeDemais extends Error {
  constructor() {
    super(`A exportação passa de ${LIMITE_LINHAS} linhas; aplique filtros`);
    this.name = "ExportacaoGrandeDemais";
  }
}

export interface DefinicaoExportacao<L> {
  /** Nome curto do relatório, sem espaço: entra no nome do arquivo e na auditoria. */
  relatorio: string;
  colunas: ReadonlyArray<ColunaExportacao<L>>;
  /** Recebe o teto (LIMITE_LINHAS + 1) para usar em LIMIT. */
  consulta: (tx: Conexao, limite: number) => Promise<L[]>;
  /** Permissão exigida. Padrão: gestao.exportar. */
  permissao?: "gestao.exportar" | "auditoria.exportar";
}

export interface ArquivoExportado {
  id: string;
  nomeArquivo: string;
  conteudo: string;
  linhas: number;
}

export async function exportar<L>(
  pedido: Omit<Pedido, "permissao" | "exigeMfa">,
  def: DefinicaoExportacao<L>,
): Promise<ArquivoExportado> {
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(def.relatorio)) throw new Error("Nome de relatório inválido");
  if (pedido.sessao) await exigirLimite("exportacao", pedido.sessao.contaId);

  return comPermissao({ ...pedido, permissao: def.permissao ?? "gestao.exportar", exigeMfa: true }, async (tx) => {
    const linhas = await def.consulta(tx, LIMITE_LINHAS + 1);
    if (linhas.length > LIMITE_LINHAS) throw new ExportacaoGrandeDemais();

    const id = randomUUID();
    const agora = new Date();
    await registrarAuditoria(tx, {
      acao: "exportacao.gerar",
      modulo: "gestao",
      objetoTipo: def.relatorio,
      objetoId: id,
      detalhes: { linhas: linhas.length, colunas: def.colunas.map((c) => `${c.titulo}:${c.tipo}`).join(",").slice(0, 200) },
    });
    const rodape = `Exportação ${id} · ${agora.toISOString()} · uso restrito, contém dados pessoais (LGPD). Não compartilhe.`;
    return {
      id,
      nomeArquivo: `${def.relatorio}-${agora.toISOString().slice(0, 10)}-${id.slice(0, 8)}.csv`,
      conteudo: gerarCsv(def.colunas, linhas, rodape),
      linhas: linhas.length,
    };
  });
}

/** Cabeçalhos para entregar o arquivo: sempre download, nunca cache. */
export function cabecalhosDownload(nomeArquivo: string): Record<string, string> {
  const seguro = nomeArquivo.replace(/[^A-Za-z0-9._-]/g, "_");
  return {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${seguro}"`,
    "Cache-Control": "no-store, private, max-age=0",
    "X-Content-Type-Options": "nosniff",
  };
}
