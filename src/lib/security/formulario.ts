import { indiceCego, iguaisEmTempoConstante } from "@/lib/security/crypto";

/**
 * Barreira contra robôs nos formulários públicos (entrar, cadastro, recuperar senha), sem
 * CAPTCHA de terceiros (que coletaria dados de quem usa o site):
 *
 *  1. Selo assinado: a página entrega `instante.assinatura` (HMAC com a chave do servidor). Robô
 *     que posta direto no endereço, sem abrir a página, não tem selo válido. O selo vence em 2 h.
 *  2. Tempo mínimo: gente leva alguns segundos para preencher; script envia no mesmo instante.
 *  3. Campo-isca: um campo escondido de quem usa a tela e de leitores de tela. Robô que preenche
 *     tudo o que encontra se denuncia.
 *
 * Agentes de IA que usam um navegador de verdade passam por isso; para eles valem os limites
 * progressivos, a verificação em duas etapas e os alertas de volume. Isto tira o grosso: scripts.
 */
export const CAMPO_SELO = "selo";
export const CAMPO_ISCA = "endereco_alternativo";
const VALIDADE_MS = 2 * 60 * 60 * 1000;

function assinar(instante: string): string {
  return indiceCego(instante, "formulario.selo").subarray(0, 18).toString("base64url");
}

export function emitirSelo(agora = Date.now()): string {
  const instante = String(agora);
  return `${instante}.${assinar(instante)}`;
}

export type MotivoRobo = "sem_selo" | "selo_invalido" | "selo_vencido" | "rapido_demais" | "isca";

/** null quando parece gente; senão, o motivo (só para log e teste: a pessoa vê a resposta genérica). */
export function conferirFormulario(f: FormData, minimoMs: number, agora = Date.now()): MotivoRobo | null {
  if (String(f.get(CAMPO_ISCA) ?? "") !== "") return "isca";
  const selo = String(f.get(CAMPO_SELO) ?? "");
  const m = /^(\d{13})\.([A-Za-z0-9_-]{24})$/.exec(selo);
  if (!m) return selo ? "selo_invalido" : "sem_selo";
  if (!iguaisEmTempoConstante(Buffer.from(m[2]!), Buffer.from(assinar(m[1]!)))) return "selo_invalido";
  const idade = agora - Number(m[1]);
  if (idade > VALIDADE_MS || idade < -60_000) return "selo_vencido";
  if (idade < minimoMs) return "rapido_demais";
  return null;
}
