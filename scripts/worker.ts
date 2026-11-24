/**
 * Worker de notificações (serviço separado no Railway: `npm run worker`).
 * Roda em laço, com pausa curta quando a fila está vazia, e encerra com segurança no SIGTERM.
 */
import { encerrarPool } from "@/lib/db/pool";
import { processarLote } from "@/lib/notificacoes/worker";
import { transporteDoAmbiente } from "@/lib/notificacoes/transporte";

let parar = false;
process.on("SIGTERM", () => (parar = true));
process.on("SIGINT", () => (parar = true));

async function main(): Promise<void> {
  const transporte = transporteDoAmbiente();
  console.warn("worker de notificações iniciado");
  while (!parar) {
    const r = await processarLote(transporte).catch(() => {
      console.error("falha ao processar lote; nova tentativa em instantes");
      return { enviadas: 0, falhas: 0, semContato: 0 };
    });
    if (r.enviadas + r.falhas + r.semContato > 0) console.warn(`lote: ${r.enviadas} enviadas, ${r.falhas} falhas, ${r.semContato} sem contato`);
    else await new Promise((ok) => setTimeout(ok, 5_000));
  }
  await encerrarPool();
}

main().catch(() => {
  console.error("worker encerrado por erro de configuração");
  process.exit(1);
});
