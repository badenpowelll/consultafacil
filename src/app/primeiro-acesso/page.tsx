import { DefinirSenha } from "@/components/DefinirSenha";

/** Link entregue pela recepção (impresso ou na tela) para quem foi cadastrado na unidade. */
export default function PrimeiroAcesso() {
  return (
    <>
      <h1>Primeiro acesso</h1>
      <p>Crie sua senha. Depois, entre com seu CPF e essa senha.</p>
      <DefinirSenha finalidade="convite" />
    </>
  );
}
