import { createHash } from "node:crypto";
import { comConta } from "@/lib/db/contexto";
import { decifrar, indiceCego } from "@/lib/security/crypto";
import { conferirSenha, hashParaContaInexistente } from "@/lib/security/password";
import { verificarTotp } from "@/lib/security/totp";
import { cpfValido, normalizarCpf } from "@/lib/validation/documentos";
import { criarSessao } from "@/lib/auth/sessao";

/**
 * Login com respostas uniformes. Robôs (inclusive agentes de IA que automatizam
 * credential stuffing) recebem sempre a mesma mensagem e o mesmo custo de tempo,
 * esteja o CPF cadastrado ou não, e esbarram em limites por IP e por CPF.
 */
export const LIMITES = {
  porIp: { tentativas: 20, janelaSegundos: 15 * 60 },
  porCpf: { tentativas: 5, janelaSegundos: 15 * 60 },
} as const;

export type ResultadoLogin =
  | { ok: true; token: string; contaId: string }
  | { ok: false; motivo: "credenciais" | "limite" | "mfa_necessario" };

export interface TentativaLogin {
  cpf: string;
  senha: string;
  codigoMfa?: string;
  ip: string;
}

/** Chave do limite sem dado pessoal em claro: o CPF entra já como índice cego. */
function chave(tipo: string, valor: string): string {
  return `login:${tipo}:${createHash("sha256").update(valor).digest("base64url").slice(0, 32)}`;
}

async function consumir(chaveLimite: string, limite: number, janela: number): Promise<boolean> {
  return comConta(null, async (tx) => {
    const r = await tx.query<{ ok: boolean }>("SELECT app.limite_consumir($1, $2, $3) AS ok", [chaveLimite, limite, janela]);
    return r.rows[0]?.ok === true;
  });
}

export async function entrar(t: TentativaLogin): Promise<ResultadoLogin> {
  const cpf = normalizarCpf(t.cpf);
  const indice = cpfValido(cpf) ? indiceCego(cpf, "pessoa.cpf") : null;
  const chaveIp = chave("ip", t.ip);
  const chaveCpf = chave("cpf", indice ? indice.toString("base64") : `invalido:${cpf}`);

  const dentroIp = await consumir(chaveIp, LIMITES.porIp.tentativas, LIMITES.porIp.janelaSegundos);
  const dentroCpf = await consumir(chaveCpf, LIMITES.porCpf.tentativas, LIMITES.porCpf.janelaSegundos);
  if (!dentroIp || !dentroCpf) return { ok: false, motivo: "limite" };

  const conta = indice
    ? (
        await comConta(null, (tx) =>
          tx.query<{ conta_id: string; senha_hash: string; mfa_ativo: boolean; mfa_segredo_cifrado: Buffer | null; bloqueada: boolean }>(
            "SELECT * FROM app.auth_buscar_conta($1)",
            [indice],
          ),
        )
      ).rows[0]
    : undefined;

  // Sempre roda o Argon2id, mesmo sem conta, para o tempo de resposta não revelar cadastro.
  const hashAlvo = conta?.senha_hash ?? (await hashParaContaInexistente());
  const senhaOk = await conferirSenha(hashAlvo, t.senha);
  if (!conta || !senhaOk || conta.bloqueada) return { ok: false, motivo: "credenciais" };

  if (conta.mfa_ativo) {
    if (!t.codigoMfa) return { ok: false, motivo: "mfa_necessario" };
    if (!conta.mfa_segredo_cifrado) return { ok: false, motivo: "credenciais" };
    const segredo = decifrar(conta.mfa_segredo_cifrado, `conta.mfa:${conta.conta_id}`);
    const passo = verificarTotp(segredo, t.codigoMfa);
    if (passo === null) return { ok: false, motivo: "credenciais" };
    // Anti-reuso: o mesmo código (passo) não vale duas vezes, nem capturado por um intermediário.
    const consumido = await comConta(conta.conta_id, async (tx) => {
      const r = await tx.query<{ ok: boolean }>("SELECT app.conta_mfa_consumir_passo($1, $2) AS ok", [conta.conta_id, passo]);
      return r.rows[0]?.ok === true;
    });
    if (!consumido) return { ok: false, motivo: "credenciais" };
  }

  await comConta(null, (tx) => tx.query("SELECT app.limite_limpar($1)", [chaveCpf]));
  const token = await criarSessao(conta.conta_id, conta.mfa_ativo);
  return { ok: true, token, contaId: conta.conta_id };
}
