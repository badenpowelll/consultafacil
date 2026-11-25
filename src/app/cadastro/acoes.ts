"use server";

import { redirect } from "next/navigation";
import { cadastrarCidadao } from "@/lib/cidadao/cadastro";
import { comConta } from "@/lib/db/contexto";
import { ipDaRequisicao, municipioAtual } from "@/lib/web/requisicao";
import { createHash } from "node:crypto";

export async function acaoCadastrar(formulario: FormData): Promise<void> {
  const municipio = await municipioAtual();
  if (!municipio) redirect("/");
  // Limite por IP: cadastro em massa por robôs.
  const chave = `cadastro:ip:${createHash("sha256").update(await ipDaRequisicao()).digest("base64url").slice(0, 32)}`;
  const permitido = await comConta(null, async (tx) =>
    (await tx.query<{ ok: boolean }>("SELECT app.limite_consumir($1, 5, 3600) AS ok", [chave])).rows[0]?.ok === true,
  );
  if (!permitido) redirect("/cadastro?erro=limite");

  const r = await cadastrarCidadao(municipio.id, {
    nome: formulario.get("nome"),
    cpf: formulario.get("cpf"),
    nascimento: formulario.get("nascimento"),
    email: formulario.get("email"),
    senha: formulario.get("senha"),
    aceite: formulario.get("aceite") === "sim",
  });
  if (!r.ok) redirect(`/cadastro?erro=${r.campos.join(",")}`);
  redirect("/cadastro?enviado=1");
}
