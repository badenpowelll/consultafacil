import { createHmac, randomBytes } from "node:crypto";

/**
 * TOTP (RFC 6238): HMAC-SHA-1, passos de 30 s, 6 dígitos, tolerância de ±1 passo.
 * O passo aceito é devolvido para que o chamador o registre e impeça reutilização do código.
 */
const PASSO_SEGUNDOS = 30;
const DIGITOS = 6;
const ALFABETO = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function gerarSegredoTotp(): string {
  const bytes = randomBytes(20);
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let saida = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) saida += ALFABETO[parseInt(bits.slice(i, i + 5), 2)];
  return saida;
}

function base32ParaBuffer(segredo: string): Buffer {
  const limpo = segredo.replace(/=+$/, "").toUpperCase();
  let bits = "";
  for (const c of limpo) {
    const v = ALFABETO.indexOf(c);
    if (v < 0) throw new Error("Segredo TOTP inválido");
    bits += v.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function codigoTotp(segredo: string, passo: number): string {
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(passo));
  const hmac = createHmac("sha1", base32ParaBuffer(segredo)).update(contador).digest();
  const deslocamento = hmac[hmac.length - 1]! & 0x0f;
  const binario =
    ((hmac[deslocamento]! & 0x7f) << 24) |
    (hmac[deslocamento + 1]! << 16) |
    (hmac[deslocamento + 2]! << 8) |
    hmac[deslocamento + 3]!;
  return String(binario % 10 ** DIGITOS).padStart(DIGITOS, "0");
}

export function passoAtual(agoraMs: number = Date.now()): number {
  return Math.floor(agoraMs / 1000 / PASSO_SEGUNDOS);
}

/** Devolve o passo que corresponde ao código, ou null. Comparação sem atalhos de tempo. */
export function verificarTotp(segredo: string, codigo: string, agoraMs: number = Date.now()): number | null {
  if (!/^\d{6}$/.test(codigo)) return null;
  const atual = passoAtual(agoraMs);
  let encontrado: number | null = null;
  for (const passo of [atual - 1, atual, atual + 1]) {
    const esperado = codigoTotp(segredo, passo);
    let diferenca = 0;
    for (let i = 0; i < DIGITOS; i++) diferenca |= esperado.charCodeAt(i) ^ codigo.charCodeAt(i);
    if (diferenca === 0 && encontrado === null) encontrado = passo;
  }
  return encontrado;
}

export function uriProvisionamento(segredo: string, rotulo: string, emissor = "Consulta Fácil"): string {
  const r = encodeURIComponent(`${emissor}:${rotulo}`);
  return `otpauth://totp/${r}?secret=${segredo}&issuer=${encodeURIComponent(emissor)}&algorithm=SHA1&digits=6&period=30`;
}
