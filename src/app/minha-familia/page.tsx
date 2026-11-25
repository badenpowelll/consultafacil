import { redirect } from "next/navigation";
import { encerrarDependente, ErroFamilia, MENSAGENS_FAMILIA, meusDependentes, PARENTESCOS, pedirDependente, type CodigoFamilia } from "@/lib/cidadao/familia";
import { requisicaoAtual } from "@/lib/web/requisicao";

async function req() {
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  return atual.req;
}

async function acaoPedir(f: FormData): Promise<void> {
  "use server";
  try {
    await pedirDependente(await req(), {
      nome: f.get("nome"), cpf: f.get("cpf"), nascimento: f.get("nascimento"), nomeCurto: f.get("nome_curto"), parentesco: f.get("parentesco"),
    });
  } catch (e) {
    if (e instanceof ErroFamilia) redirect(`/minha-familia?erro=${e.codigo}`);
    throw e;
  }
  redirect("/minha-familia?ok=pedido");
}

async function acaoEncerrar(f: FormData): Promise<void> {
  "use server";
  try {
    await encerrarDependente(await req(), f.get("dependente"));
  } catch (e) {
    if (e instanceof ErroFamilia) redirect(`/minha-familia?erro=${e.codigo}`);
    throw e;
  }
  redirect("/minha-familia?ok=retirado");
}

const OK: Record<string, string> = {
  pedido: "Pedido enviado. Leve a certidão de nascimento ou o termo de guarda ou curatela na unidade de saúde para a conferência.",
  retirado: "Dependente retirado. As consultas já marcadas para ele continuam valendo até serem desmarcadas.",
};

/** Dependentes do titular: crianças e pessoas sob cuidado que ele agenda. */
export default async function MinhaFamilia({ searchParams }: { searchParams: Promise<{ erro?: string; ok?: string }> }) {
  const { erro, ok } = await searchParams;
  let lista;
  try {
    lista = await meusDependentes(await req());
  } catch (e) {
    if (e instanceof ErroFamilia) return <p className="aviso">{e.message}</p>;
    throw e;
  }
  return (
    <>
      <h1>Minha família</h1>
      <p className="suave">Inclua quem está sob sua responsabilidade (filhos, pessoa sob guarda ou curatela) para marcar consultas para eles.</p>
      {ok && OK[ok] && <p className="ok" role="status">{OK[ok]}</p>}
      {erro && erro in MENSAGENS_FAMILIA && <p className="erro" role="alert">{MENSAGENS_FAMILIA[erro as CodigoFamilia]}</p>}

      {lista.length === 0 && <p className="suave">Nenhum dependente ainda.</p>}
      {lista.map((d) => (
        <div className="cartao linha" key={d.id}>
          <span className="cresce">
            <strong>{d.nome_curto}</strong> · {PARENTESCOS[d.parentesco]}{" "}
            {d.estado === "pendente" ? <span className="etiqueta">aguardando conferência na unidade</span> : <span className="etiqueta">aprovado</span>}
          </span>
          {d.estado === "ativo" && <a href={`/marcar?para=${d.id}`}>Marcar consulta</a>}
          <form action={acaoEncerrar}>
            <input type="hidden" name="dependente" value={d.id} />
            <button className="secundario" type="submit">{d.estado === "pendente" ? "Desistir do pedido" : "Retirar"}</button>
          </form>
        </div>
      ))}

      <form className="campos cartao" action={acaoPedir}>
        <h2>Incluir dependente</h2>
        <label>Nome completo<input name="nome" required minLength={5} maxLength={160} /></label>
        <label>
          Como você chama essa pessoa <span className="ajuda">Aparece nos avisos por e-mail. Ex.: Ana, vó Maria.</span>
          <input name="nome_curto" required minLength={2} maxLength={40} />
        </label>
        <label>CPF<input name="cpf" inputMode="numeric" required maxLength={14} /></label>
        <label>Data de nascimento<input name="nascimento" type="date" required /></label>
        <label>
          Relação com você
          <select name="parentesco" required defaultValue="">
            <option value="" disabled>Escolha</option>
            {Object.entries(PARENTESCOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <button type="submit">Enviar pedido</button>
      </form>
    </>
  );
}
