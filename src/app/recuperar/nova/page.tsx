import { DefinirSenha } from "@/components/DefinirSenha";

export default function NovaSenha() {
  return (
    <>
      <h1>Criar nova senha</h1>
      <DefinirSenha finalidade="recuperar_senha" />
    </>
  );
}
