import { CAMPO_ISCA, CAMPO_SELO, emitirSelo } from "@/lib/security/formulario";

/** Selo assinado + campo-isca (ver src/lib/security/formulario.ts). Vai dentro de cada formulário público. */
export function CamposAntiRobo() {
  return (
    <>
      <input type="hidden" name={CAMPO_SELO} value={emitirSelo()} />
      <div className="isca" aria-hidden="true">
        <label>Não preencha este campo
          <input name={CAMPO_ISCA} tabIndex={-1} autoComplete="off" defaultValue="" />
        </label>
      </div>
    </>
  );
}
