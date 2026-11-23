const MENSAGENS: Record<string, string> = {
  credenciais: "CPF, senha ou código não conferem.",
  limite: "Muitas tentativas. Aguarde 15 minutos e tente de novo.",
  mfa_necessario: "Sua conta usa verificação em duas etapas. Informe também o código do aplicativo.",
  sem_vinculo: "Seu cadastro neste município ainda aguarda aprovação da unidade de saúde.",
};

export default async function Entrar({ searchParams }: { searchParams: Promise<{ erro?: string }> }) {
  const { erro } = await searchParams;
  const mensagem = erro ? MENSAGENS[erro] : undefined;
  return (
    <>
      <h1>Entrar</h1>
      {mensagem && <p className="erro" role="alert">{mensagem}</p>}
      <form className="campos" action="/entrar/enviar" method="post">
        <label>
          CPF
          <input name="cpf" inputMode="numeric" autoComplete="username" required maxLength={14} />
        </label>
        <label>
          Senha
          <input name="senha" type="password" autoComplete="current-password" required maxLength={128} />
        </label>
        <label>
          Código de verificação <span className="ajuda">Só para quem ativou a verificação em duas etapas (equipe e gestão).</span>
          <input name="codigo" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} />
        </label>
        <button type="submit">Entrar</button>
      </form>
      <p>Ainda não tem cadastro? <a href="/cadastro">Criar cadastro</a>.</p>
      <p className="suave">Esqueceu a senha? Procure a recepção da sua unidade com um documento com foto.</p>
    </>
  );
}
