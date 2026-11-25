"use client";

import { useActionState, useEffect, useState } from "react";
import { acaoDefinirSenha, type EstadoDefinicao } from "@/app/recuperar/acoes";

const MENSAGENS: Record<Exclude<EstadoDefinicao["resultado"], "inicial" | "ok">, string> = {
  link_invalido: "Este link não vale mais: ele vence em pouco tempo e só pode ser usado uma vez. Peça um novo.",
  senha_fraca: "Escolha uma senha mais forte: no mínimo 12 caracteres, sem sequências óbvias. Uma frase com palavras funciona bem.",
  senhas_diferentes: "As duas senhas digitadas não são iguais.",
};

/**
 * Formulário de nova senha. O token vem depois do "#" do endereço (não vai ao servidor ao abrir a
 * página, nem aparece em logs ou Referer); aqui ele é lido, tirado da barra de endereço e enviado
 * só no POST do formulário.
 */
export function DefinirSenha({ finalidade }: { finalidade: "recuperar_senha" | "convite" }) {
  const [token, setToken] = useState<string | null>(null);
  const [estado, enviar, enviando] = useActionState<EstadoDefinicao, FormData>(acaoDefinirSenha, { resultado: "inicial" });

  useEffect(() => {
    const t = window.location.hash.slice(1);
    setToken(/^[A-Za-z0-9_-]{43}$/.test(t) ? t : "");
    if (t) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  if (estado.resultado === "ok") {
    return (
      <p className="ok" role="status">
        Senha criada. Por segurança, saímos de todos os aparelhos onde a conta estava aberta. <a href="/entrar">Entrar com a nova senha</a>
      </p>
    );
  }
  if (token === null) return <p className="suave">Carregando…</p>;
  if (token === "") {
    return (
      <p className="erro" role="alert">
        Link incompleto. Abra o link exatamente como recebeu{finalidade === "recuperar_senha" ? " no e-mail" : ""}, ou <a href="/recuperar">peça um novo</a>.
      </p>
    );
  }
  return (
    <>
      {estado.resultado !== "inicial" && <p className="erro" role="alert">{MENSAGENS[estado.resultado]}</p>}
      <form className="campos" action={enviar}>
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="finalidade" value={finalidade} />
        <label>
          Nova senha <span className="ajuda">Mínimo de 12 caracteres. Uma frase com palavras é fácil de lembrar e segura.</span>
          <input name="senha" type="password" autoComplete="new-password" required minLength={12} maxLength={128} />
        </label>
        <label>Repita a nova senha<input name="confirmacao" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /></label>
        <button type="submit" disabled={enviando}>{enviando ? "Salvando…" : "Salvar senha"}</button>
      </form>
    </>
  );
}
