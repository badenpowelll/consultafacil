import { describe, expect, it } from "vitest";
import { CAMPO_ISCA, CAMPO_SELO, conferirFormulario, emitirSelo } from "@/lib/security/formulario";

function formulario(campos: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(campos)) f.set(k, v);
  return f;
}

describe("selo anti-robô dos formulários públicos", () => {
  const agora = 1_800_000_000_000;

  it("aceita o selo emitido pela página, depois do tempo mínimo", () => {
    const f = formulario({ [CAMPO_SELO]: emitirSelo(agora - 5000), [CAMPO_ISCA]: "" });
    expect(conferirFormulario(f, 3000, agora)).toBeNull();
  });

  it("recusa envio sem selo, selo forjado ou adulterado", () => {
    expect(conferirFormulario(formulario({}), 0, agora)).toBe("sem_selo");
    expect(conferirFormulario(formulario({ [CAMPO_SELO]: `${agora - 5000}.${"A".repeat(24)}` }), 0, agora)).toBe("selo_invalido");
    const legitimo = emitirSelo(agora - 5000);
    const [, assinatura] = legitimo.split(".");
    // Trocar o instante (para "envelhecer" um selo) invalida a assinatura.
    expect(conferirFormulario(formulario({ [CAMPO_SELO]: `${agora - 9000}.${assinatura}` }), 0, agora)).toBe("selo_invalido");
    expect(conferirFormulario(formulario({ [CAMPO_SELO]: "lixo" }), 0, agora)).toBe("selo_invalido");
  });

  it("recusa selo vencido, do futuro, envio rápido demais e campo-isca preenchido", () => {
    expect(conferirFormulario(formulario({ [CAMPO_SELO]: emitirSelo(agora - 3 * 60 * 60 * 1000) }), 0, agora)).toBe("selo_vencido");
    expect(conferirFormulario(formulario({ [CAMPO_SELO]: emitirSelo(agora + 5 * 60 * 1000) }), 0, agora)).toBe("selo_vencido");
    expect(conferirFormulario(formulario({ [CAMPO_SELO]: emitirSelo(agora - 500) }), 3000, agora)).toBe("rapido_demais");
    expect(conferirFormulario(formulario({ [CAMPO_SELO]: emitirSelo(agora - 5000), [CAMPO_ISCA]: "Rua 1" }), 0, agora)).toBe("isca");
  });
});
