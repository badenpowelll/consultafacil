/**
 * Worker de notificações (serviço separado no Railway: `npm run worker`).
 * Roda em laço, com pausa curta quando a fila está vazia, e encerra com segurança no SIGTERM.
 * A cada minuto roda as rotinas (ofertas da lista de espera e lembrete da véspera).
 */
import { encerrarPool } from "@/lib/db/pool";
import { processarLote } from "@/lib/notificacoes/worker";
import { transporteDoAmbiente } from "@/lib/notificacoes/transporte";
import { executarRotinas } from "@/lib/notificacoes/rotina";
import { vigiarSeguranca } from "@/lib/seguranca/vigia";

const INTERVALO_ROTINAS_MS = 60_000;

let parar = false;
process.on("SIGTERM", () => (parar = true));
process.on("SIGINT", () => (parar = true));

async function main(): Promise<void> {
  const transporte = transporteDoAmbiente();
  console.warn("worker de notificações iniciado");
  let ultimaRotina = 0;
  while (!parar) {
    if (Date.now() - ultimaRotina >= INTERVALO_ROTINAS_MS) {
      ultimaRotina = Date.now();
      const r = await executarRotinas().catch(() => {
        console.error("falha nas rotinas; nova tentativa no próximo ciclo");
        return { ofertas: 0, lembretes: 0 };
      });
      if (r.ofertas + r.lembretes > 0) console.warn(`rotinas: ${r.ofertas} ofertas, ${r.lembretes} lembretes`);
      await vigiarSeguranca().catch(() => console.error("falha na vigia de segurança; nova tentativa no próximo ciclo"));
    }
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
