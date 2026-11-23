import { obterPool } from "@/lib/db/pool";

export const dynamic = "force-dynamic";

/** Saúde do serviço. Não expõe versão, dependências nem mensagens de erro. */
export async function GET() {
  try {
    await obterPool().query("SELECT 1");
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
