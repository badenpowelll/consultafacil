import type { Mensagem } from "@/lib/notificacoes/modelos";

/** Como o e-mail sai. O provedor é escolhido por variável de ambiente; nada de SMTP direto. */
export interface Transporte {
  /** `chave`: identifica o envio; repetir a mesma chave não manda a mensagem duas vezes. */
  enviar(destino: string, mensagem: Mensagem, chave?: string): Promise<void>;
}

/** Desenvolvimento e testes: guarda em memória, sem mandar nada para fora. */
export class TransporteMemoria implements Transporte {
  readonly enviados: { destino: string; mensagem: Mensagem; chave?: string }[] = [];
  async enviar(destino: string, mensagem: Mensagem, chave?: string): Promise<void> {
    // Mesmo comportamento do provedor: a repetição da mesma chave não gera segundo envio.
    if (chave && this.enviados.some((e) => e.chave === chave)) return;
    this.enviados.push({ destino, mensagem, chave });
  }
}

/** Provedor transacional por API HTTPS (Resend). A chave fica só nas variáveis do Railway. */
export class TransporteResend implements Transporte {
  constructor(
    private readonly chave: string,
    private readonly remetente: string,
  ) {}

  async enviar(destino: string, mensagem: Mensagem, chave?: string): Promise<void> {
    const resposta = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.chave}`,
        "Content-Type": "application/json",
        // O provedor guarda a chave por 24 horas e não reenvia a mesma mensagem.
        ...(chave ? { "Idempotency-Key": chave } : {}),
      },
      body: JSON.stringify({ from: this.remetente, to: [destino], subject: mensagem.assunto, text: mensagem.texto, html: mensagem.html }),
      signal: AbortSignal.timeout(10_000),
    });
    // Nunca registra o corpo da resposta: pode ecoar o endereço.
    if (!resposta.ok) throw new Error(`provedor de e-mail respondeu ${resposta.status}`);
  }
}

export function transporteDoAmbiente(): Transporte {
  const tipo = process.env.CF_EMAIL_TRANSPORTE ?? "memoria";
  if (tipo === "resend") {
    const chave = process.env.RESEND_API_KEY;
    const remetente = process.env.CF_EMAIL_REMETENTE;
    if (!chave || !remetente) throw new Error("RESEND_API_KEY e CF_EMAIL_REMETENTE são obrigatórias");
    return new TransporteResend(chave, remetente);
  }
  if (process.env.NODE_ENV === "production") throw new Error("Em produção, defina CF_EMAIL_TRANSPORTE=resend");
  return new TransporteMemoria();
}
