import Link from "next/link";
import { createHash } from "node:crypto";
import { validarComprovante } from "@/lib/agendamento/servico";
import { comConta } from "@/lib/db/contexto";
import { ipDaRequisicao, municipioAtual } from "@/lib/web/requisicao";

function dataHora(d: Date, fuso: string): string {
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: fuso }).format(d);
}

/**
 * Validação pública do comprovante (QR code). Mostra só o necessário para quem recebe o papel
 * conferir: situação, data, unidade, profissional e as iniciais do paciente.
 */
export default async function ValidarCodigo({ params }: { params: Promise<{ codigo: string }> }) {
  const municipio = await municipioAtual();
  if (!municipio) return <p className="aviso">Município não encontrado.</p>;

  // Limite por IP contra varredura de códigos (os códigos têm 128 bits, mas não custa).
  const chave = `validar:ip:${createHash("sha256").update(await ipDaRequisicao()).digest("base64url").slice(0, 32)}`;
  const permitido = await comConta(null, async (tx) =>
    (await tx.query<{ ok: boolean }>("SELECT app.limite_consumir($1, 60, 3600) AS ok", [chave])).rows[0]?.ok === true,
  );
  if (!permitido) return <p className="erro" role="alert">Muitas consultas a partir desta conexão. Tente mais tarde.</p>;

  const { codigo } = await params;
  const r = await validarComprovante(municipio.id, decodeURIComponent(codigo));
  if (!r) {
    return (
      <>
        <h1>Comprovante não encontrado</h1>
        <p className="erro" role="alert">Este código não corresponde a nenhum comprovante emitido por {municipio.nome}.</p>
        <p><Link href="/validar">Digitar o código</Link></p>
      </>
    );
  }
  return (
    <>
      <h1>Comprovante válido</h1>
      <p className="ok" role="status">Emitido pelo sistema de agendamento de {r.municipio}.</p>
      <dl className="cartao">
        <dt>Situação atual</dt><dd>{r.situacao}</dd>
        <dt>Data e hora</dt><dd>{dataHora(r.inicio, r.fuso)}</dd>
        <dt>Unidade</dt><dd>{r.unidade}</dd>
        <dt>Profissional</dt><dd>{r.profissional} ({r.especialidade})</dd>
        <dt>Paciente</dt><dd>{r.iniciais}</dd>
      </dl>
      <p className="suave">A situação mostrada é a de agora, não a da data de emissão. Por privacidade, o nome do paciente aparece só pelas iniciais.</p>
    </>
  );
}
