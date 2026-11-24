import { mascararCns, mascararCpf, mascararEmail, mascararNome, mascararTelefone } from "@/lib/security/mascaramento";
import { redigir } from "@/lib/security/redacao";

/**
 * Geração de CSV para relatórios. O tipo da coluna decide a máscara: quem escreve um
 * relatório não escolhe "mostrar o CPF inteiro", porque essa opção não existe aqui.
 * Documento completo só é revelado individualmente, na tela, com motivo e auditoria.
 */
export type TipoColuna = "texto" | "numero" | "data" | "cpf" | "cns" | "telefone" | "email" | "nome";

export interface ColunaExportacao<L> {
  titulo: string;
  tipo: TipoColuna;
  valor: (linha: L) => string | number | Date | null | undefined;
}

const SEPARADOR = ";";
const BOM = "﻿";

/**
 * Injeção de fórmula (CSV injection): uma célula que começa com = + - @ ou tabulação/retorno
 * vira fórmula no Excel/LibreOffice e pode exfiltrar dados da planilha (ex.: =HYPERLINK).
 * Prefixar com apóstrofo faz a planilha tratar como texto.
 */
export function neutralizarFormula(valor: string): string {
  return /^[=+\-@\t\r]/.test(valor) ? `'${valor}` : valor;
}

function aplicarTipo(tipo: TipoColuna, bruto: string | number | Date | null | undefined): string {
  if (bruto === null || bruto === undefined) return "";
  if (bruto instanceof Date) return bruto.toISOString();
  const v = String(bruto);
  switch (tipo) {
    case "cpf": return mascararCpf(v);
    case "cns": return mascararCns(v);
    case "telefone": return mascararTelefone(v);
    case "email": return mascararEmail(v);
    case "nome": return mascararNome(v);
    case "numero": return typeof bruto === "number" && Number.isFinite(bruto) ? String(bruto) : "";
    case "data": return v;
    case "texto": return redigir(v);
  }
}

function celula(valor: string): string {
  return `"${neutralizarFormula(valor).replace(/"/g, '""').replace(/[\r\n]+/g, " ")}"`;
}

export function gerarCsv<L>(colunas: ReadonlyArray<ColunaExportacao<L>>, linhas: ReadonlyArray<L>, rodape: string): string {
  const cabecalho = colunas.map((c) => celula(c.titulo)).join(SEPARADOR);
  const corpo = linhas.map((l) => colunas.map((c) => celula(aplicarTipo(c.tipo, c.valor(l)))).join(SEPARADOR));
  // Rodapé de rastreio: identifica a exportação na auditoria se o arquivo aparecer onde não devia.
  return BOM + [cabecalho, ...corpo, celula(rodape)].join("\r\n") + "\r\n";
}
