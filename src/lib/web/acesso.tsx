import { AcessoNegado } from "@/lib/auth/autorizar";

/** Mensagem única para falta de acesso; não revela se o objeto existe. */
export function semAcesso(erro: unknown) {
  if (!(erro instanceof AcessoNegado)) throw erro;
  const texto =
    erro.motivo === "sem_mfa"
      ? "A área da equipe exige verificação em duas etapas. Ative em Conta › Segurança e entre de novo."
      : "Você não tem permissão para esta área. Peça ao gestor do município.";
  return <p className="aviso" role="alert">{texto}</p>;
}
