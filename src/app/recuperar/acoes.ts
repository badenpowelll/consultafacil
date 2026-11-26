"use server";

import { redirect } from "next/navigation";
import { pedirRecuperacao, redefinirSenha, type FinalidadeAcesso } from "@/lib/auth/recuperacao";
import { conferirFormulario } from "@/lib/security/formulario";
import { logInfo } from "@/lib/log";
import { ipDaRequisicao, municipioAtual } from "@/lib/web/requisicao";

export async function acaoPedirRecuperacao(f: FormData): Promise<void> {
  const municipio = await municipioAtual();
  if (!municipio) redirect("/");
  const robo = conferirFormulario(f, 3000);
  if (robo) {
    // Resposta igual à de sucesso: o robô não aprende nada.
    logInfo({ evento: "seguranca.formulario_recusado", rota: "recuperar", motivo: robo });
    redirect("/recuperar?enviado=1");
  }
  const r = await pedirRecuperacao(municipio.id, String(f.get("cpf") ?? "").slice(0, 20), await ipDaRequisicao());
  redirect(r === "limite" ? "/recuperar?erro=limite" : "/recuperar?enviado=1");
}

export interface EstadoDefinicao {
  resultado: "inicial" | "ok" | "link_invalido" | "senha_fraca" | "senhas_diferentes";
}

/** Usada com useActionState: o token chega no corpo do POST, nunca na URL. */
export async function acaoDefinirSenha(_anterior: EstadoDefinicao, f: FormData): Promise<EstadoDefinicao> {
  const municipio = await municipioAtual();
  if (!municipio) return { resultado: "link_invalido" };
  const finalidade: FinalidadeAcesso = f.get("finalidade") === "convite" ? "convite" : "recuperar_senha";
  const senha = String(f.get("senha") ?? "").slice(0, 200);
  if (senha !== String(f.get("confirmacao") ?? "").slice(0, 200)) return { resultado: "senhas_diferentes" };
  const resultado = await redefinirSenha(municipio.id, finalidade, String(f.get("token") ?? "").slice(0, 100), senha, await ipDaRequisicao());
  return { resultado };
}
