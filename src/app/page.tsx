import { redirect } from "next/navigation";
import { municipioAtual, sessaoAtual } from "@/lib/web/requisicao";

export default async function Inicio() {
  const municipio = await municipioAtual();
  if (!municipio) {
    return (
      <>
        <h1>Consulta Fácil</h1>
        <p>Acesse pelo endereço do seu município, por exemplo <code>seumunicipio.consultafacil.com.br</code>.</p>
      </>
    );
  }
  if (await sessaoAtual()) redirect("/minhas-consultas");
  return (
    <>
      <h1>Marque sua consulta na rede de saúde de {municipio.nome}</h1>
      <p>Escolha o dia e o horário, receba a confirmação por e-mail e desmarque quando não puder ir, liberando a vaga para outra pessoa.</p>
      <div className="linha">
        <a className="botao" href="/entrar">Entrar</a>
        <a className="botao secundario" href="/cadastro">Criar cadastro</a>
      </div>
      <p className="suave">Sem internet ou com dificuldade? Procure a recepção da sua unidade de saúde: a equipe marca para você.</p>
    </>
  );
}
