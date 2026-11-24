import { cookies } from "next/headers";
import { COOKIE_SESSAO, revogarSessao } from "@/lib/auth/sessao";

export async function POST(req: Request) {
  // Mesma origem: formulários de outros sites não encerram a sessão de ninguém.
  const origem = req.headers.get("origin");
  if (origem && new URL(origem).host !== req.headers.get("host")) return new Response(null, { status: 403 });
  const jar = await cookies();
  const token = jar.get(COOKIE_SESSAO)?.value;
  if (token) await revogarSessao(token, "saida");
  jar.delete(COOKIE_SESSAO);
  return new Response(null, { status: 303, headers: { Location: "/" } });
}
