import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { fichaDoCidadao } from "@/lib/cidadao/recepcao";
import { dependentesDoCidadao, ErroFamilia, incluirDependenteAssistido, MENSAGENS_FAMILIA, PARENTESCOS, type CodigoFamilia } from "@/lib/cidadao/familia";
import { AcessoNegado } from "@/lib/auth/autorizar";
import { requisicaoAtual } from "@/lib/web/requisicao";
import { semAcesso } from "@/lib/web/acesso";
import { AcessoAssistido } from "@/components/AcessoAssistido";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function acaoIncluir(f: FormData): Promise<void> {
  "use server";
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  const titular = String(f.get("titular") ?? "");
  if (!UUID.test(titular)) redirect("/equipe/cidadaos");
  let destino = `/equipe/cidadaos/${titular}?ok=dependente`;
  try {
    await incluirDependenteAssistido(atual.req, titular, {
      nome: f.get("nome"), cpf: f.get("cpf"), nascimento: f.get("nascimento"), nomeCurto: f.get("nome_curto"), parentesco: f.get("parentesco"),
    });
  } catch (e) {
    if (e instanceof ErroFamilia) destino = `/equipe/cidadaos/${titular}?erro=${e.codigo}`;
    else if (e instanceof AcessoNegado) destino = `/equipe/cidadaos/${titular}?erro=sem_permissao`;
    else throw e;
  }
  redirect(destino);
}

const OK: Record<string, string> = {
  novo: "Cadastro criado e aprovado. Se a pessoa quiser usar o site, gere o link de primeiro acesso.",
  aprovado: "A pessoa já tinha pedido cadastro pelo site: agora está aprovado.",
  ja_cadastrado: "Esta pessoa já tinha cadastro ativo. Nada foi alterado.",
  dependente: "Dependente incluído e aprovado.",
};

function idade(d: Date | null): string {
  if (!d) return "";
  const anos = Math.floor((Date.now() - d.getTime()) / (365.25 * 86_400_000));
  return `${anos} ${anos === 1 ? "ano" : "anos"}`;
}

/** Ficha do cidadão na recepção: dependentes, agendar por ele e link de primeiro acesso. */
export default async function Ficha({ params, searchParams }: { params: Promise<{ vinculo: string }>; searchParams: Promise<{ ok?: string; erro?: string }> }) {
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  const { vinculo } = await params;
  const { ok, erro } = await searchParams;
  if (!UUID.test(vinculo)) notFound();
  let ficha, dependentes;
  try {
    ficha = await fichaDoCidadao(atual.req, vinculo);
    dependentes = ficha ? await dependentesDoCidadao(atual.req, vinculo) : [];
  } catch (e) {
    return semAcesso(e);
  }
  if (!ficha) notFound();
  const ativo = ficha.estado === "ativo";
  return (
    <>
      <p><Link href="/equipe/cidadaos">← Cidadãos</Link></p>
      <h1>{ficha.nome}</h1>
      {ok && OK[ok] && <p className="ok" role="status">{OK[ok]}</p>}
      {erro === "sem_permissao" && <p className="erro" role="alert">Você não tem permissão para atendimento assistido.</p>}
      {erro && erro in MENSAGENS_FAMILIA && <p className="erro" role="alert">{MENSAGENS_FAMILIA[erro as CodigoFamilia]}</p>}
      {!ativo && <p className="aviso">Este cadastro não está ativo ({ficha.estado}). Aprove em Cadastros pendentes antes de agendar.</p>}

      {ativo && (
        <section className="cartao">
          <h2>Agendar</h2>
          <p className="linha">
            <a className="botao" href={`/equipe/agenda?para=${vinculo}`}>Para {ficha.nome.split(" ")[0]}</a>
            {dependentes.filter((d) => d.estado === "ativo").map((d) => (
              <a key={d.id} className="botao secundario" href={`/equipe/agenda?para=${vinculo}&dep=${d.id}`}>Para {d.nome_curto}</a>
            ))}
          </p>
        </section>
      )}

      <h2>Dependentes</h2>
      {dependentes.length === 0 && <p className="suave">Nenhum dependente.</p>}
      {dependentes.length > 0 && (
        <table>
          <thead><tr><th>Nome</th><th>Relação</th><th>Idade</th><th>Situação</th></tr></thead>
          <tbody>
            {dependentes.map((d) => (
              <tr key={d.id}>
                <td>{d.nome} <span className="suave">({d.nome_curto})</span></td>
                <td>{PARENTESCOS[d.parentesco]}</td>
                <td>{idade(d.nascimento)}</td>
                <td>{d.estado === "ativo" ? "aprovado" : "aguarda conferência"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {ativo && (
        <form className="campos cartao" action={acaoIncluir}>
          <h3>Incluir dependente</h3>
          <p className="suave">Confira a certidão de nascimento ou o termo de guarda ou curatela: o dependente já sai aprovado.</p>
          <input type="hidden" name="titular" value={vinculo} />
          <label>Nome completo<input name="nome" required minLength={5} maxLength={160} /></label>
          <label>Como o titular chama<input name="nome_curto" required minLength={2} maxLength={40} /></label>
          <label>CPF<input name="cpf" inputMode="numeric" required maxLength={14} /></label>
          <label>Data de nascimento<input name="nascimento" type="date" required /></label>
          <label>
            Relação
            <select name="parentesco" required defaultValue="">
              <option value="" disabled>Escolha</option>
              {Object.entries(PARENTESCOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <button type="submit">Incluir</button>
        </form>
      )}

      {ativo && (
        <section className="cartao">
          <h2>Acesso pelo site</h2>
          <p className="suave">Para quem foi cadastrado no balcão ou esqueceu a senha e não tem e-mail. O link vale 3 dias e só uma vez; a senha antiga deixa de valer quando a nova for criada.</p>
          <AcessoAssistido vinculo={vinculo} nome={ficha.nome.split(" ")[0] ?? ""} />
        </section>
      )}
    </>
  );
}
