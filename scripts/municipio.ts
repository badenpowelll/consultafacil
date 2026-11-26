/**
 * Operação do ciclo de vida do município (Super Admin). Roda como processo separado, com
 * DATABASE_URL_ADMIN, como as migrações: o app web nunca recebe essa credencial.
 *
 *   CF_OPERADOR=apelido npm run municipio -- situacao <slug>
 *   CF_OPERADOR=apelido npm run municipio -- suspender <slug> "motivo"
 *   CF_OPERADOR=apelido npm run municipio -- reativar <slug> "motivo"
 *   CF_OPERADOR=apelido npm run municipio -- ativar <slug> "motivo"          (sai de provisionando)
 *   CF_OPERADOR=apelido npm run municipio -- encerrar <slug> "motivo"        (entra em encerrando)
 *   CF_OPERADOR=apelido npm run municipio -- exportar <slug> <pasta-nova>
 *   CF_OPERADOR=apelido npm run municipio -- concluir-encerramento <slug> "motivo"
 *   CF_OPERADOR=apelido npm run municipio -- bloquear-conta <conta_id> "motivo"     (contenção de incidente)
 *   CF_OPERADOR=apelido npm run municipio -- desbloquear-conta <conta_id> "motivo"
 *
 * Procedimento completo em docs/operacao/ciclo-do-municipio.md.
 */
import { Client } from "pg";
import { alterarEstado, bloquearConta, exportarMunicipio, OperacaoRecusada, situacaoDoMunicipio, type EstadoMunicipio } from "@/lib/operacao/municipio";

const PARA: Record<string, EstadoMunicipio> = {
  suspender: "suspenso",
  reativar: "ativo",
  ativar: "ativo",
  encerrar: "encerrando",
  "concluir-encerramento": "encerrado",
};

function parar(mensagem: string): never {
  console.error(mensagem);
  process.exit(1);
}

async function main(): Promise<void> {
  const [comando, slug, extra] = process.argv.slice(2);
  const url = process.env.DATABASE_URL_ADMIN;
  const operador = process.env.CF_OPERADOR ?? "";
  if (!url) parar("DATABASE_URL_ADMIN não definida");
  if (!comando || !slug) parar("Uso: npm run municipio -- <situacao|suspender|reativar|ativar|encerrar|exportar|concluir-encerramento|bloquear-conta|desbloquear-conta> <slug|conta_id> [motivo|pasta]");

  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    if (comando === "situacao") {
      const s = await situacaoDoMunicipio(db, slug);
      console.warn(JSON.stringify(s, null, 2));
    } else if (comando === "exportar") {
      if (!extra) parar("Informe a pasta de destino (ela não pode existir)");
      const r = await exportarMunicipio(db, slug, extra, operador);
      console.warn(`Exportação ${r.id} gravada em ${r.pasta}: ${r.arquivos.length} arquivos. Confira com: cd ${r.pasta} && sha256sum -c manifesto.sha256`);
    } else if (comando === "bloquear-conta" || comando === "desbloquear-conta") {
      const r = await bloquearConta(db, { contaId: slug, bloquear: comando === "bloquear-conta", operador, motivo: extra ?? "" });
      console.warn(`Conta ${comando === "bloquear-conta" ? "bloqueada" : "desbloqueada"} em ${r.municipios} município(s). Sessões revogadas: ${r.sessoesRevogadas}.`);
    } else if (PARA[comando]) {
      const r = await alterarEstado(db, { slug, para: PARA[comando], operador, motivo: extra ?? "" });
      console.warn(`Município ${slug}: ${r.de} → ${r.para}. Sessões revogadas: ${r.sessoesRevogadas}.`);
    } else {
      parar("Comando desconhecido");
    }
  } catch (e) {
    if (e instanceof OperacaoRecusada) parar(e.message);
    throw e;
  } finally {
    await db.end();
  }
}

main().catch(() => parar("Falha na operação; nada foi alterado além do que a mensagem anterior indicar. Veja docs/operacao/ciclo-do-municipio.md"));
