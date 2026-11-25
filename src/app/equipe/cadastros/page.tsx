import { redirect } from "next/navigation";
import { cadastrosPendentes, decidirCadastro } from "@/lib/cidadao/cadastro";
import { decidirDependente, dependentesParaConferir, ErroFamilia, PARENTESCOS } from "@/lib/cidadao/familia";
import { requisicaoAtual } from "@/lib/web/requisicao";
import { semAcesso } from "@/lib/web/acesso";

async function acaoDecidir(f: FormData): Promise<void> {
  "use server";
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  await decidirCadastro(atual.req, f.get("vinculo"), f.get("decisao") === "aprovar");
  redirect("/equipe/cadastros");
}

async function acaoDecidirDependente(f: FormData): Promise<void> {
  "use server";
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  try {
    await decidirDependente(atual.req, f.get("dependente"), f.get("decisao") === "aprovar");
  } catch (e) {
    if (!(e instanceof ErroFamilia)) throw e;
  }
  redirect("/equipe/cadastros");
}

function idade(d: Date | null): string {
  if (!d) return "idade não informada";
  const anos = Math.floor((Date.now() - d.getTime()) / (365.25 * 86_400_000));
  return `${anos} ${anos === 1 ? "ano" : "anos"}`;
}

export default async function Cadastros() {
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  let pendentes, dependentes;
  try {
    pendentes = await cadastrosPendentes(atual.req);
    dependentes = await dependentesParaConferir(atual.req);
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

      <h2>Dependentes pedidos pelo site</h2>
      <p className="suave">Confira a certidão de nascimento, o termo de guarda ou a curatela apresentados pelo titular.</p>
      {dependentes.length === 0 && <p>Nenhum dependente aguardando.</p>}
      {dependentes.map((d) => (
        <div className="cartao linha" key={d.id}>
          <span className="cresce">
            <strong>{d.nome}</strong> ({idade(d.nascimento)}) · {PARENTESCOS[d.parentesco]} de <a href={`/equipe/cidadaos/${d.titular_vinculo_id}`}>{d.titular}</a>
            {d.tem_conta && <><br /><span className="aviso">Esta pessoa tem conta própria: confira com cuidado se é mesmo dependente.</span></>}
          </span>
          <form action={acaoDecidirDependente}>
            <input type="hidden" name="dependente" value={d.id} />
            <button name="decisao" value="aprovar" type="submit">Aprovar</button>
          </form>
          <form action={acaoDecidirDependente}>
            <input type="hidden" name="dependente" value={d.id} />
            <button name="decisao" value="recusar" type="submit" className="perigo">Recusar</button>
          </form>
        </div>
      ))}
    </>
  );
}
