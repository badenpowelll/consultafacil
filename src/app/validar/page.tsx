import { redirect } from "next/navigation";
import { normalizarCodigo } from "@/lib/agendamento/comprovante";

/** Formulário para digitar o código impresso no comprovante. */
export default async function Validar({ searchParams }: { searchParams: Promise<{ codigo?: string }> }) {
  const { codigo } = await searchParams;
  const canonico = normalizarCodigo(codigo);
  if (canonico) redirect(`/validar/${canonico}`);
  return (
    <>
      <h1>Validar comprovante de agendamento</h1>
      {codigo !== undefined && <p className="erro" role="alert">Código inválido. Confira os caracteres impressos no comprovante.</p>}
      <form className="campos" method="get" action="/validar">
        <label>
          Código de validação
          <input name="codigo" required maxLength={80} autoComplete="off" spellCheck={false} placeholder="AGD-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX" />
        </label>
        <button type="submit">Validar</button>
      </form>
    </>
  );
}
