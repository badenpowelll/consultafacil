import { acaoPedirRecuperacao } from "./acoes";

/** Pedir link de nova senha por e-mail. A resposta é a mesma para qualquer CPF. */
export default async function Recuperar({ searchParams }: { searchParams: Promise<{ erro?: string; enviado?: string }> }) {
  const { erro, enviado } = await searchParams;
  if (enviado) {
    return (
      <>
        <h1>Confira seu e-mail</h1>
        <p className="ok" role="status">
          Se houver cadastro com e-mail para este CPF neste município, enviamos um link para criar uma nova senha. Ele vale por 30 minutos e só
          pode ser usado uma vez.
        </p>
        <p>Não chegou? Veja a caixa de spam. Se você não tem e-mail cadastrado, procure a recepção da sua unidade com um documento com foto.</p>
        <p><a href="/entrar">Voltar para Entrar</a></p>
      </>
    );
  }
  return (
    <>
      <h1>Criar nova senha</h1>
      {erro === "limite" && <p className="erro" role="alert">Muitos pedidos seguidos. Aguarde uma hora e tente de novo.</p>}
      <p>Informe seu CPF. Enviaremos um link para o e-mail do seu cadastro.</p>
      <form className="campos" action={acaoPedirRecuperacao}>
        <label>CPF<input name="cpf" inputMode="numeric" autoComplete="username" required maxLength={14} /></label>
        <button type="submit">Enviar link</button>
      </form>
      <p className="suave">Nunca pedimos sua senha por e-mail, telefone ou mensagem.</p>
    </>
  );
}
