import { redirect } from "next/navigation";
import { comConta } from "@/lib/db/contexto";
import { cifrar, decifrar } from "@/lib/security/crypto";
import { gerarSegredoTotp, uriProvisionamento, verificarTotp } from "@/lib/security/totp";
import { marcarMfaVerificado } from "@/lib/auth/sessao";
import { sessaoAtual, tokenDaSessao } from "@/lib/web/requisicao";

/**
 * Verificação em duas etapas (TOTP). Obrigatória para gestão e funções administrativas.
 * O segredo fica cifrado e só vira "ativo" depois que a pessoa prova que o aplicativo gera o código certo.
 */
async function dadosMfa(contaId: string) {
  return comConta(contaId, async (tx) =>
    (await tx.query<{ mfa_ativo: boolean; mfa_segredo_cifrado: Buffer | null }>("SELECT * FROM app.conta_mfa_dados($1)", [contaId])).rows[0],
  );
}

async function acaoIniciar(): Promise<void> {
  "use server";
  const s = await sessaoAtual();
  if (!s) redirect("/entrar");
  const atual = await dadosMfa(s.contaId);
  if (atual?.mfa_ativo) redirect("/conta/seguranca");
  const segredo = gerarSegredoTotp();
  await comConta(s.contaId, (tx) =>
    tx.query("SELECT app.conta_definir_mfa($1, $2, false)", [s.contaId, cifrar(segredo, `conta.mfa:${s.contaId}`)]),
  );
  redirect("/conta/seguranca?etapa=confirmar");
}

async function acaoConfirmar(f: FormData): Promise<void> {
  "use server";
  const s = await sessaoAtual();
  const token = await tokenDaSessao();
  if (!s || !token) redirect("/entrar");
  const dados = await dadosMfa(s.contaId);
  if (!dados?.mfa_segredo_cifrado || dados.mfa_ativo) redirect("/conta/seguranca");
  const passo = verificarTotp(decifrar(dados.mfa_segredo_cifrado, `conta.mfa:${s.contaId}`), String(f.get("codigo") ?? ""));
  if (passo === null) redirect("/conta/seguranca?etapa=confirmar&erro=1");
  await comConta(s.contaId, async (tx) => {
    await tx.query("SELECT app.conta_mfa_consumir_passo($1, $2)", [s.contaId, passo]);
    await tx.query("SELECT app.conta_definir_mfa($1, $2, true)", [s.contaId, dados.mfa_segredo_cifrado]);
  });
  await marcarMfaVerificado(token);
  redirect("/conta/seguranca?ok=1");
}

export default async function Seguranca({ searchParams }: { searchParams: Promise<{ etapa?: string; erro?: string; ok?: string }> }) {
  const s = await sessaoAtual();
  if (!s) redirect("/entrar");
  const b = await searchParams;
  const dados = await dadosMfa(s.contaId);

  if (dados?.mfa_ativo) {
    return (
      <>
        <h1>Segurança da conta</h1>
        {b.ok && <p className="ok" role="status">Verificação em duas etapas ativada.</p>}
        <p>A verificação em duas etapas está <strong>ativa</strong>. Ao entrar, informe o código de 6 dígitos do aplicativo.</p>
        <p className="suave">Perdeu o celular? Peça ao gestor do município para redefinir o acesso.</p>
      </>
    );
  }

  if (b.etapa === "confirmar" && dados?.mfa_segredo_cifrado) {
    const segredo = decifrar(dados.mfa_segredo_cifrado, `conta.mfa:${s.contaId}`);
    return (
      <>
        <h1>Ativar verificação em duas etapas</h1>
        {b.erro && <p className="erro" role="alert">Código incorreto. Confira o horário do celular e tente de novo.</p>}
        <ol>
          <li>Instale um aplicativo autenticador (Google Authenticator, Microsoft Authenticator, Aegis ou similar).</li>
          <li>Adicione uma conta digitando esta chave: <code className="quebra">{segredo.replace(/(.{4})/g, "$1 ").trim()}</code></li>
          <li>Digite abaixo o código de 6 dígitos que aparecer.</li>
        </ol>
        <details><summary>Endereço de configuração (para aplicativos que aceitam colar)</summary><code className="quebra">{uriProvisionamento(segredo, "Consulta Fácil")}</code></details>
        <form className="campos" action={acaoConfirmar}>
          <label>Código do aplicativo<input name="codigo" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required /></label>
          <button type="submit">Confirmar e ativar</button>
        </form>
      </>
    );
  }

  return (
    <>
      <h1>Segurança da conta</h1>
      <p>A verificação em duas etapas protege sua conta mesmo que alguém descubra sua senha. Ela é obrigatória para quem administra o município.</p>
      <form action={acaoIniciar}><button type="submit">Ativar verificação em duas etapas</button></form>
    </>
  );
}
