import type { ReactNode } from "react";
import { sessaoAtual } from "@/lib/web/requisicao";

/**
 * Toda a área da equipe exige verificação em duas etapas na sessão. Senha vazada, adivinhada
 * ou testada em massa por robô não basta para ver ou mudar dados de cidadãos. As funções de
 * dados conferem de novo (comPermissao); aqui é só para mostrar o caminho certo.
 */
export default async function LayoutEquipe({ children }: { children: ReactNode }) {
  const s = await sessaoAtual();
  if (s && !s.mfaVerificado) {
    return (
      <>
        <h1>Ative a verificação em duas etapas</h1>
        <p className="aviso" role="alert">
          A área da equipe só abre com a verificação em duas etapas, para proteger os dados dos cidadãos
          mesmo que alguém descubra a sua senha.
        </p>
        <p>Já ativou? Saia e entre de novo informando o código do aplicativo.</p>
        <a className="botao" href="/conta/seguranca">Ativar agora</a>
      </>
    );
  }
  return children;
}
