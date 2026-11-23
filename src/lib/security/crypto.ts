import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Criptografia de campo (AES-256-GCM) com chaves versionadas e índice cego (HMAC-SHA-256).
 *
 * Formato do texto cifrado: [versão da chave: 1 byte][IV: 12 bytes][tag: 16 bytes][dados].
 * O "contexto" (ex.: "pessoa.cpf") entra como dado autenticado: um valor cifrado para um campo
 * não pode ser colado em outro campo sem falhar na decifragem.
 *
 * Rotação: adicione a nova chave em CF_CHAVES_DADOS, mude CF_CHAVE_DADOS_ATIVA e recifre
 * os registros antigos em lote. Chaves antigas continuam legíveis enquanto estiverem listadas.
 */

const TAMANHO_CHAVE = 32;
const TAMANHO_IV = 12;
const TAMANHO_TAG = 16;

function lerChaves(): Map<number, Buffer> {
  const mapa = new Map<number, Buffer>();
  for (const item of env().CF_CHAVES_DADOS.split(",")) {
    const [versaoTexto, base64] = item.trim().split(":");
    const versao = Number(versaoTexto);
    if (!Number.isInteger(versao) || versao < 1 || versao > 255 || !base64) {
      throw new Error("CF_CHAVES_DADOS mal formatada");
    }
    const chave = Buffer.from(base64, "base64");
    if (chave.length !== TAMANHO_CHAVE) throw new Error(`Chave de dados v${versao} precisa ter 32 bytes`);
    mapa.set(versao, chave);
  }
  return mapa;
}

function chaveIndice(): Buffer {
  const chave = Buffer.from(env().CF_CHAVE_INDICE, "base64");
  if (chave.length < 32) throw new Error("CF_CHAVE_INDICE precisa ter ao menos 32 bytes");
  return chave;
}

export function cifrar(texto: string, contexto: string): Buffer {
  const versao = env().CF_CHAVE_DADOS_ATIVA;
  const chave = lerChaves().get(versao);
  if (!chave) throw new Error(`Chave ativa v${versao} não encontrada`);
  const iv = randomBytes(TAMANHO_IV);
  const cifra = createCipheriv("aes-256-gcm", chave, iv);
  cifra.setAAD(Buffer.from(contexto, "utf8"));
  const dados = Buffer.concat([cifra.update(texto, "utf8"), cifra.final()]);
  return Buffer.concat([Buffer.from([versao]), iv, cifra.getAuthTag(), dados]);
}

export function decifrar(cifrado: Buffer, contexto: string): string {
  if (cifrado.length < 1 + TAMANHO_IV + TAMANHO_TAG) throw new Error("Texto cifrado inválido");
  const versao = cifrado[0]!;
  const chave = lerChaves().get(versao);
  if (!chave) throw new Error(`Chave v${versao} indisponível`);
  const iv = cifrado.subarray(1, 1 + TAMANHO_IV);
  const tag = cifrado.subarray(1 + TAMANHO_IV, 1 + TAMANHO_IV + TAMANHO_TAG);
  const dados = cifrado.subarray(1 + TAMANHO_IV + TAMANHO_TAG);
  const decifra = createDecipheriv("aes-256-gcm", chave, iv);
  decifra.setAAD(Buffer.from(contexto, "utf8"));
  decifra.setAuthTag(tag);
  return Buffer.concat([decifra.update(dados), decifra.final()]).toString("utf8");
}

/** Versão da chave usada num valor cifrado (para rotação em lote). */
export function versaoDaChave(cifrado: Buffer): number {
  return cifrado[0] ?? 0;
}

/**
 * Índice cego: permite buscar por CPF/CNS sem guardar o valor. Diferente de um hash simples,
 * não pode ser revertido por força bruta sem a chave secreta.
 */
export function indiceCego(valorNormalizado: string, contexto: string): Buffer {
  return createHmac("sha256", chaveIndice()).update(`${contexto}:${valorNormalizado}`, "utf8").digest();
}

export function iguaisEmTempoConstante(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
