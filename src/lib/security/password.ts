import { hash, verify } from "@node-rs/argon2";

// Algorithm.Argon2id da biblioteca (enum const não pode ser importado com isolatedModules).
const ARGON2ID = 2;

/**
 * Senhas com Argon2id nos parâmetros mínimos recomendados pela OWASP (19 MiB, 2 iterações).
 */
const PARAMETROS = { algorithm: ARGON2ID, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

const MINIMO = 12;
const MAXIMO = 128;

// Lista curta de senhas óbvias. A verificação contra vazamentos conhecidos (k-anonimato)
// entra num incremento seguinte.
const PROIBIDAS = new Set([
  "123456789012", "senha1234567", "consultafacil", "prefeitura123", "qwertyuiop12", "abcdefghijkl",
]);

export type ProblemaSenha = "curta" | "longa" | "comum" | "repetitiva";

export function avaliarSenha(senha: string): ProblemaSenha | null {
  if (senha.length < MINIMO) return "curta";
  if (senha.length > MAXIMO) return "longa";
  if (PROIBIDAS.has(senha.toLowerCase())) return "comum";
  if (/^(.)\1+$/.test(senha)) return "repetitiva";
  return null;
}

export async function gerarHashSenha(senha: string): Promise<string> {
  const problema = avaliarSenha(senha);
  if (problema) throw new Error(`Senha recusada: ${problema}`);
  return hash(senha, PARAMETROS);
}

export async function conferirSenha(hashArmazenado: string, senha: string): Promise<boolean> {
  if (senha.length > MAXIMO) return false;
  try {
    return await verify(hashArmazenado, senha);
  } catch {
    return false;
  }
}

/**
 * Hash fixo usado quando a conta não existe, para que o tempo de resposta do login
 * não revele se o CPF está cadastrado.
 */
let hashFicticio: Promise<string> | undefined;
export function hashParaContaInexistente(): Promise<string> {
  hashFicticio ??= hash("conta-inexistente-valor-fixo", PARAMETROS);
  return hashFicticio;
}
