import { redirect } from "next/navigation";
import { buscarCidadaos, cadastrarAssistido, type CidadaoEncontrado } from "@/lib/cidadao/recepcao";
import { AcessoNegado } from "@/lib/auth/autorizar";
import { requisicaoAtual } from "@/lib/web/requisicao";
import { semAcesso } from "@/lib/web/acesso";

const CAMPOS: Record<string, string> = {
  nome: "nome completo",
  cpf: "CPF",
  nascimento: "data de nascimento",
  email: "e-mail",
  aceite: "confirmação de que os termos foram lidos e aceitos",
};

async function acaoCadastrar(f: FormData): Promise<void> {
  "use server";
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  let destino: string;
  try {
    const r = await cadastrarAssistido(atual.req, {
      nome: f.get("nome"), cpf: f.get("cpf"), nascimento: f.get("nascimento"), email: String(f.get("email") ?? ""), aceite: f.get("aceite") === "sim",
    });
    if (r.ok) destino = `/equipe/cidadaos/${r.vinculoId}?ok=${r.situacao}`;
    else if ("bloqueado" in r) destino = "/equipe/cidadaos?erro=bloqueado";
    else destino = `/equipe/cidadaos?erro=${r.campos.join(",")}`;
  } catch (e) {
    if (e instanceof AcessoNegado) destino = "/equipe/cidadaos?erro=sem_permissao";
    else throw e;
  }
  redirect(destino);
}

const ESTADO: Record<string, string> = { convidado: "aguarda aprovação", ativo: "ativo", suspenso: "suspenso", revogado: "recusado" };

function data(d: Date | null): string {
  return d ? new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC" }).format(d) : "—";
}

/** Recepção: achar o cidadão (por CPF ou nome) ou cadastrar no balcão. */
export default async function Cidadaos({ searchParams }: { searchParams: Promise<{ q?: string; erro?: string }> }) {
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  const { q, erro } = await searchParams;
  let achados: CidadaoEncontrado[] = [];
  try {
    achados = q ? await buscarCidadaos(atual.req, q) : [];
  } catch (e) {
    return semAcesso(e);
  }
  const problemas = erro?.split(",").map((c) => CAMPOS[c]).filter(Boolean) ?? [];
  return (
    <>
      <h1>Cidadãos</h1>
      <p className="suave">Busque pelo CPF completo ou por parte do nome. Cada busca fica registrada na auditoria.</p>
      {erro === "sem_permissao" && <p className="erro" role="alert">Você não tem permissão para atendimento assistido.</p>}
      {erro === "bloqueado" && <p className="erro" role="alert">Este cadastro está bloqueado ou foi recusado neste município. Fale com a gestão.</p>}
      {problemas.length > 0 && <p className="erro" role="alert">Confira: {problemas.join(", ")}.</p>}
      <form className="linha" method="get" role="search" aria-label="Buscar cidadão">
        <label className="cresce">CPF ou nome<input name="q" defaultValue={q} required minLength={3} maxLength={160} /></label>
        <button type="submit">Buscar</button>
      </form>
      {q && achados.length === 0 && <p className="suave">Ninguém encontrado. Confira o CPF ou cadastre abaixo.</p>}
      {achados.length > 0 && (
        <table>
          <thead><tr><th>Nome</th><th>Nascimento</th><th>Situação</th><th>Dependentes</th><th><span className="sr">Ação</span></th></tr></thead>
          <tbody>
            {achados.map((c) => (
              <tr key={c.vinculo_id}>
                <td>{c.nome}</td>
                <td>{data(c.nascimento)}</td>
                <td>{ESTADO[c.estado] ?? c.estado}</td>
                <td>{c.dependentes}</td>
                <td><a href={`/equipe/cidadaos/${c.vinculo_id}`}>Abrir ficha</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form className="campos cartao" action={acaoCadastrar}>
        <h2>Cadastro no balcão</h2>
        <p className="suave">Para quem não tem e-mail ou celular. Confira documento com foto e comprovante de residência no município: o cadastro já sai aprovado.</p>
        <label>Nome completo<input name="nome" required minLength={5} maxLength={160} /></label>
        <label>CPF<input name="cpf" inputMode="numeric" required maxLength={14} /></label>
        <label>Data de nascimento<input name="nascimento" type="date" required /></label>
        <label>E-mail (opcional) <span className="ajuda">Para avisos. Deixe em branco se a pessoa não tem.</span><input name="email" type="email" maxLength={200} /></label>
        <label className="marcar">
          <input type="checkbox" name="aceite" value="sim" required /> Li os <a href="/termos" target="_blank" rel="noopener">termos de uso e privacidade</a> para o cidadão, e ele concordou.
        </label>
        <button type="submit">Cadastrar</button>
      </form>
    </>
  );
}
