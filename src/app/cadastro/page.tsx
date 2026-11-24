import { acaoCadastrar } from "./acoes";

const CAMPOS: Record<string, string> = {
  nome: "nome completo",
  cpf: "CPF",
  nascimento: "data de nascimento",
  email: "e-mail",
  senha: "senha (mínimo de 12 caracteres, evite sequências óbvias)",
};

export default async function Cadastro({ searchParams }: { searchParams: Promise<{ erro?: string; enviado?: string }> }) {
  const { erro, enviado } = await searchParams;
  if (enviado) {
    return (
      <>
        <h1>Pedido de cadastro recebido</h1>
        <p className="ok" role="status">
          Se este CPF ainda não tinha cadastro, ele foi criado e aguarda aprovação da unidade de saúde. Leve um documento com foto e comprovante de
          residência na próxima ida à unidade, ou aguarde a conferência.
        </p>
        <p>Se você já tinha cadastro, use <a href="/entrar">Entrar</a> ou procure a recepção para recuperar o acesso.</p>
      </>
    );
  }
  const problemas = erro === "limite" ? null : erro?.split(",").map((c) => CAMPOS[c]).filter(Boolean);
  return (
    <>
      <h1>Criar cadastro</h1>
      {erro === "limite" && <p className="erro" role="alert">Muitos cadastros a partir desta conexão. Tente mais tarde.</p>}
      {problemas && problemas.length > 0 && <p className="erro" role="alert">Confira: {problemas.join(", ")}.</p>}
      <form className="campos" action={acaoCadastrar}>
        <label>Nome completo<input name="nome" autoComplete="name" required maxLength={160} /></label>
        <label>CPF<input name="cpf" inputMode="numeric" required maxLength={14} /></label>
        <label>Data de nascimento<input name="nascimento" type="date" autoComplete="bday" required /></label>
        <label>
          E-mail <span className="ajuda">Para avisos de consulta marcada, desmarcada ou de ausência do profissional.</span>
          <input name="email" type="email" autoComplete="email" required maxLength={200} />
        </label>
        <label>
          Senha <span className="ajuda">Mínimo de 12 caracteres. Uma frase com palavras é fácil de lembrar e segura.</span>
          <input name="senha" type="password" autoComplete="new-password" required minLength={12} maxLength={128} />
        </label>
        <button type="submit">Enviar cadastro</button>
      </form>
    </>
  );
}
