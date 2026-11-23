import { normalizarCns, normalizarCpf } from "@/lib/validation/documentos";

/**
 * Mascaramento para exibição, relatórios e exportações. A regra é mostrar só o necessário
 * para alguém conferir que está falando da pessoa certa, nunca o suficiente para reutilizar
 * o dado em outro sistema. Valores fora do formato esperado viram máscara total: um campo
 * malformado não pode escapar inteiro por não casar com o padrão.
 */
const TOTAL = "***";

/** 529.982.247-25 → ***.982.247-** (padrão adotado por órgãos públicos para CPF em listas). */
export function mascararCpf(valor: string | null | undefined): string {
  const cpf = normalizarCpf(valor ?? "");
  if (cpf.length !== 11) return TOTAL;
  return `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**`;
}

/** 15 dígitos → só os 4 últimos visíveis. */
export function mascararCns(valor: string | null | undefined): string {
  const cns = normalizarCns(valor ?? "");
  if (cns.length !== 15) return TOTAL;
  return `*** **** **** ${cns.slice(11)}`;
}

/** (84) 99876-5432 → (84) *****-5432 */
export function mascararTelefone(valor: string | null | undefined): string {
  const t = (valor ?? "").replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, "");
  if (t.length !== 10 && t.length !== 11) return TOTAL;
  return `(${t.slice(0, 2)}) *****-${t.slice(-4)}`;
}

/** maria.silva@exemplo.gov.br → m***@e***.gov.br */
export function mascararEmail(valor: string | null | undefined): string {
  const v = (valor ?? "").trim();
  const m = /^([^@\s]+)@([^@\s.]+)((?:\.[^@\s.]+)+)$/.exec(v);
  if (!m) return TOTAL;
  return `${m[1]!.charAt(0)}***@${m[2]!.charAt(0)}***${m[3]}`;
}

/** Maria Aparecida da Silva → Maria A. d. S. (iniciais depois do primeiro nome). */
export function mascararNome(valor: string | null | undefined): string {
  const partes = (valor ?? "").trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return TOTAL;
  const [primeiro, ...resto] = partes;
  return [primeiro, ...resto.map((p) => `${p.charAt(0)}.`)].join(" ");
}
