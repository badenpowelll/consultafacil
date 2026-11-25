"use client";

import { useActionState } from "react";
import { acaoGerarAcesso, type EstadoAcesso } from "@/app/equipe/cidadaos/acoes";

/** Botão que gera o link de primeiro acesso e mostra uma vez, com QR, para imprimir. */
export function AcessoAssistido({ vinculo, nome }: { vinculo: string; nome: string }) {
  const [estado, gerar, gerando] = useActionState<EstadoAcesso, FormData>(acaoGerarAcesso, { situacao: "inicial" });
  if (estado.situacao === "gerado") {
    const ate = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Fortaleza" }).format(new Date(estado.validoAte));
    return (
      <div className="cartao folha-acesso">
        <h3>Primeiro acesso de {nome}</h3>
        <p>Aponte a câmera do celular para o código ou digite o endereço. Vale até {ate} e só pode ser usado uma vez.</p>
        <svg className="qr-acesso" viewBox={`-2 -2 ${estado.qr.tamanho + 4} ${estado.qr.tamanho + 4}`} role="img" aria-label="Código QR do link de primeiro acesso">
          <rect x={-2} y={-2} width={estado.qr.tamanho + 4} height={estado.qr.tamanho + 4} fill="#fff" />
          <path d={estado.qr.caminho} fill="#000" />
        </svg>
        <p><code className="quebra">{estado.link}</code></p>
        <p className="suave">Entregue só para a própria pessoa (ou responsável), depois de conferir o documento com foto. Ao sair desta tela o link não aparece de novo.</p>
        <button type="button" className="secundario nao-imprimir" onClick={() => window.print()}>Imprimir</button>
      </div>
    );
  }
  return (
    <form action={gerar}>
      <input type="hidden" name="vinculo" value={vinculo} />
      {estado.situacao === "erro" && <p className="erro" role="alert">{estado.mensagem}</p>}
      <button type="submit" className="secundario" disabled={gerando}>{gerando ? "Gerando…" : "Gerar link de primeiro acesso"}</button>
    </form>
  );
}
