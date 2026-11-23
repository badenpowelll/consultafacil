import type { z } from "zod";
import { AcessoNegado } from "@/lib/auth/autorizar";
import { logErro } from "@/lib/log";

/**
 * Respostas de API com projeção explícita (OWASP API3: exposição excessiva de dados).
 *
 * Toda resposta com dados passa por um esquema zod que lista os campos permitidos; o que não
 * está no esquema é descartado, nunca repassado "por padrão". Depois da projeção, uma segunda
 * verificação procura nomes de campo que nunca podem sair da API (hash de senha, texto cifrado,
 * índice cego, segredo de MFA, hash de token). Se aparecer, a resposta inteira é bloqueada:
 * é sinal de que um esquema foi escrito errado, e falhar fechado é melhor do que vazar.
 */
const CAMPOS_PROIBIDOS = /(^|_)(senha|password|hash|cifrado|indice|segredo|secret|token)(_|$)|mfa_|cpf$|^cpf|cns$|^cns/i;

const MASCARADO = /_mascarad[oa]$/i;

export const CABECALHOS_PRIVADOS = {
  "Cache-Control": "no-store, private, max-age=0",
  Pragma: "no-cache",
  Vary: "Cookie",
} as const;

export class CampoProibidoNaResposta extends Error {
  constructor(public readonly caminho: string) {
    super(`Campo proibido na resposta: ${caminho}`);
    this.name = "CampoProibidoNaResposta";
  }
}

/** Procura, em qualquer profundidade, um nome de campo proibido. Devolve o caminho ou null. */
export function encontrarCampoProibido(valor: unknown, caminho = "$"): string | null {
  if (Array.isArray(valor)) {
    for (let i = 0; i < valor.length; i++) {
      const r = encontrarCampoProibido(valor[i], `${caminho}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (valor !== null && typeof valor === "object") {
    if (Buffer.isBuffer(valor) || valor instanceof Uint8Array) return `${caminho}(binário)`;
    for (const [chave, filho] of Object.entries(valor)) {
      // Campo já mascarado (ex.: cpf_mascarado) é a forma permitida de exibir documento.
      if (!MASCARADO.test(chave) && CAMPOS_PROIBIDOS.test(chave)) return `${caminho}.${chave}`;
      const r = encontrarCampoProibido(filho, `${caminho}.${chave}`);
      if (r) return r;
    }
  }
  return null;
}

/** Projeta `dados` pelo esquema (campos extras são descartados) e confere campos proibidos. */
export function projetar<E extends z.ZodType>(esquema: E, dados: unknown): z.infer<E> {
  const projetado = esquema.parse(dados);
  const proibido = encontrarCampoProibido(projetado);
  if (proibido) throw new CampoProibidoNaResposta(proibido);
  return projetado;
}

export function respostaSegura<E extends z.ZodType>(esquema: E, dados: unknown, status = 200): Response {
  return Response.json(projetar(esquema, dados), { status, headers: CABECALHOS_PRIVADOS });
}

/**
 * Erro para o cliente: mensagem fixa por tipo, sem detalhe interno. O id de correlação
 * permite ao suporte achar o registro (já redigido) no log.
 */
export function respostaDeErro(erro: unknown, rota: string): Response {
  if (erro instanceof AcessoNegado) {
    // Mesmo status e corpo para "não existe" e "não pode ver": não revela existência.
    const status = erro.motivo === "sem_sessao" ? 401 : 404;
    return Response.json({ erro: status === 401 ? "nao_autenticado" : "nao_encontrado" }, { status, headers: CABECALHOS_PRIVADOS });
  }
  const correlacao = logErro({ evento: "api.erro", rota }, erro);
  return Response.json({ erro: "falha_interna", correlacao }, { status: 500, headers: CABECALHOS_PRIVADOS });
}
