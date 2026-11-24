import { redirect } from "next/navigation";
import { definirCorPrimaria, identidadeAtual } from "@/lib/gestao/identidade";
import { ErroGestao, MENSAGENS_GESTAO } from "@/lib/gestao/perfis";
import { requisicaoAtual } from "@/lib/web/requisicao";
import { semAcesso } from "@/lib/web/acesso";

async function acaoCor(f: FormData): Promise<void> {
  "use server";
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  try {
    await definirCorPrimaria(atual.req, f.get("cor"));
  } catch (e) {
    if (e instanceof ErroGestao) redirect(`/equipe/identidade?erro=${e.codigo}`);
    throw e;
  }
  redirect("/equipe/identidade?ok=cor");
}

const OK: Record<string, string> = {
  logomarca: "Logomarca atualizada. Ela já aparece no topo do site e nos próximos comprovantes.",
  cor: "Cor atualizada. Ela aparece nos próximos comprovantes.",
};

/** Logomarca e cor do município. Exige gestao.identidade_visual com MFA. */
export default async function Identidade({ searchParams }: { searchParams: Promise<{ erro?: string; ok?: string }> }) {
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  const { erro, ok } = await searchParams;
  let id;
  try {
    id = await identidadeAtual(atual.req);
  } catch (e) {
    return semAcesso(e);
  }
  return (
    <>
      <h1>Logomarca e cor do município</h1>
      {ok && OK[ok] && <p className="ok" role="status">{OK[ok]}</p>}
      {erro && erro in MENSAGENS_GESTAO && <p className="erro" role="alert">{MENSAGENS_GESTAO[erro as keyof typeof MENSAGENS_GESTAO]}</p>}

      <section className="cartao">
        <h2>Logomarca</h2>
        {id.temLogo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="previa-logo" src={`/marca?v=${id.versao}`} alt={`Logomarca atual de ${atual.municipio.nome}`} />
        ) : (
          <p className="suave">Ainda sem logomarca. Enquanto isso, o comprovante usa a marca do Consulta Fácil.</p>
        )}
        <form className="campos" action="/equipe/identidade/logomarca" method="post" encType="multipart/form-data">
          <label>
            Arquivo PNG ou JPEG, até 1 MB
            <input type="file" name="logomarca" accept="image/png,image/jpeg" required />
          </label>
          <p className="suave">Os dados escondidos da imagem (autor, local da foto, aparelho) são apagados antes de salvar.</p>
          <button type="submit">Enviar logomarca</button>
        </form>
      </section>

      <section className="cartao">
        <h2>Cor principal</h2>
        <form className="campos linha" action={acaoCor}>
          <label>Cor <input type="color" name="cor" defaultValue={id.corPrimaria ?? "#217d4d"} /></label>
          <button type="submit">Salvar cor</button>
        </form>
      </section>
    </>
  );
}
