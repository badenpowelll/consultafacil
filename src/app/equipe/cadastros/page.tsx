import { redirect } from "next/navigation";
import { cadastrosPendentes, decidirCadastro } from "@/lib/cidadao/cadastro";
import { requisicaoAtual } from "@/lib/web/requisicao";
import { semAcesso } from "@/lib/web/acesso";

async function acaoDecidir(f: FormData): Promise<void> {
  "use server";
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  await decidirCadastro(atual.req, f.get("vinculo"), f.get("decisao") === "aprovar");
  redirect("/equipe/cadastros");
}

export default async function Cadastros() {
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  let pendentes;
  try {
    pendentes = await cadastrosPendentes(atual.req);
  } catch (e) {
    return semAcesso(e);
  }
  return (
    <>
      <h1>Cadastros pendentes</h1>
      <p className="suave">Aprove depois de conferir documento com foto e comprovante de residência no município.</p>
      {pendentes.length === 0 && <p>Nenhum cadastro aguardando.</p>}
      {pendentes.map((p) => (
        <div className="cartao linha" key={p.vinculo_id}>
          <span className="cresce">{p.nome}</span>
          <form action={acaoDecidir}>
            <input type="hidden" name="vinculo" value={p.vinculo_id} />
            <button name="decisao" value="aprovar" type="submit">Aprovar</button>
          </form>
          <form action={acaoDecidir}>
            <input type="hidden" name="vinculo" value={p.vinculo_id} />
            <button name="decisao" value="recusar" type="submit" className="perigo">Recusar</button>
          </form>
        </div>
      ))}
    </>
  );
}
