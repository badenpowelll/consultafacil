/**
 * Redação de texto livre antes de ir para log, auditoria ou mensagem de erro.
 *
 * Esta é a última barreira, não a primeira: o código não deve mandar dado pessoal para log.
 * Mas mensagens de erro do driver do banco, de bibliotecas e de exceções inesperadas podem
 * carregar valores ("Key (email)=(fulano@...) already exists"). Tudo o que sai do processo
 * em texto livre passa por aqui.
 */
const SUBSTITUICOES: ReadonlyArray<readonly [RegExp, string]> = [
  // Cadeias de conexão com usuário e senha: postgres://usuario:senha@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, "$1[credencial]@"],
  // Cabeçalhos e parâmetros de autenticação
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [token]"],
  [/((?:senha|password|secret|segredo|token|chave|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi, "$1[removido]"],
  // E-mail
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  // CPF formatado ou só dígitos (11), CNS (15), telefone com DDD (10–13 dígitos com ou sem máscara)
  [/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, "[cpf]"],
  [/\b\d{15}\b/g, "[cns]"],
  [/\b\d{3}\s\d{4}\s\d{4}\s\d{4}\b/g, "[cns]"],
  [/\b\d{11}\b/g, "[cpf]"],
  [/\(?\b\d{2}\)?\s?9?\d{4}-?\d{4}\b/g, "[telefone]"],
  // Tokens opacos (sessão, links): 43 caracteres base64url
  [/\b[A-Za-z0-9_-]{43}\b/g, "[token]"],
];

export function redigir(texto: string): string {
  let saida = texto;
  for (const [padrao, troca] of SUBSTITUICOES) saida = saida.replace(padrao, troca);
  return saida;
}

/** true se o texto parece conter dado pessoal ou segredo. Usado para descartar valores. */
export function pareceSensivel(texto: string): boolean {
  return redigir(texto) !== texto;
}
