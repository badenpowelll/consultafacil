import { redirect } from "next/navigation";
import {
  aceitarOferta, entrarNaEspera, minhaEspera, opcoesDaEspera, recusarOferta, sairDaEspera, PRIORIDADES, TURNOS, type Turno,
} from "@/lib/agendamento/espera";
import { ErroAgendamento, MENSAGENS, type CodigoErro } from "@/lib/agendamento/erros";
import { meusDependentes } from "@/lib/cidadao/familia";
import { requisicaoAtual } from "@/lib/web/requisicao";
import { dataHora, hora } from "@/lib/web/formato";

async function req() {
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  return atual.req;
}

async function executar(trabalho: () => Promise<unknown>, ok: string, destino = "/lista-de-espera"): Promise<never> {
  try {
    await trabalho();
  } catch (e) {
    if (e instanceof ErroAgendamento) redirect(`/lista-de-espera?erro=${e.codigo}`);
    throw e;
  }
  redirect(`${destino}?ok=${ok}`);
}

async function acaoEntrar(f: FormData): Promise<void> {
  "use server";
  const r = await req();
  await executar(() => entrarNaEspera(r, { especialidade: f.get("especialidade"), unidadeId: f.get("unidade"), turno: f.get("turno"), para: f.get("para") }), "entrou");
}

async function acaoSair(f: FormData): Promise<void> {
  "use server";
  const r = await req();
  await executar(() => sairDaEspera(r, f.get("pedido")), "saiu");
}

async function acaoAceitar(f: FormData): Promise<void> {
  "use server";
  const r = await req();
  await executar(() => aceitarOferta(r, f.get("oferta")), "marcada", "/minhas-consultas");
}

async function acaoRecusar(f: FormData): Promise<void> {
  "use server";
  const r = await req();
  await executar(() => recusarOferta(r, f.get("oferta")), "recusou");
}

const OK: Record<string, string> = {
  entrou: "Pronto, você está na lista. Quando abrir uma vaga, ela fica guardada para você e avisamos por e-mail.",
  saiu: "Você saiu da lista de espera.",
  recusou: "Vaga recusada. Você continua na lista para as próximas.",
};

const ESTADOS_PEDIDO: Record<string, string> = { aguardando: "Na fila", atendida: "Consulta marcada", cancelada: "Saiu da lista" };

interface Busca { erro?: string; ok?: string; especialidade?: string; para?: string }

/** Lista de espera do cidadão: vagas oferecidas (com prazo), pedidos e como entrar. */
export default async function ListaDeEspera({ searchParams }: { searchParams: Promise<Busca> }) {
  const r = await req();
  const busca = await searchParams;
  let dados;
  try {
    dados = await minhaEspera(r);
  } catch (e) {
    if (e instanceof ErroAgendamento) return <p className="aviso">{e.message}</p>;
    throw e;
  }
  const { especialidades, unidades } = await opcoesDaEspera(r);
  const dependentes = (await meusDependentes(r).catch(() => [])).filter((d) => d.estado === "ativo");
  const sugestao = especialidades.find((e) => e.toLowerCase() === busca.especialidade?.trim().toLowerCase());
  const vigentes = dados.pedidos.filter((p) => p.estado === "aguardando");

  return (
    <>
      <h1>Lista de espera</h1>
      {busca.ok && OK[busca.ok] && <p className="ok" role="status">{OK[busca.ok]}</p>}
      {busca.erro && busca.erro in MENSAGENS && <p className="erro" role="alert">{MENSAGENS[busca.erro as CodigoErro]}</p>}

      {dados.ofertas.length > 0 && (
        <section aria-labelledby="ofertas">
          <h2 id="ofertas">Vaga guardada para você</h2>
          {dados.ofertas.map((o) => (
            <article className="cartao destaque-borda" key={o.id} aria-labelledby={`o-${o.id}`}>
              <h3 id={`o-${o.id}`}>{dataHora(o.inicio)}{o.paciente && <> · <span className="etiqueta">{o.paciente}</span></>}</h3>
              <p>{o.especialidade} com {o.profissional} · {o.unidade}</p>
              <p><strong>Responda até {dataHora(o.expira_em)}.</strong> Depois disso, a vaga vai para a próxima pessoa da fila.</p>
              <div className="linha">
                <form action={acaoAceitar}>
                  <input type="hidden" name="oferta" value={o.id} />
                  <button type="submit">Quero esta vaga</button>
                </form>
                <form action={acaoRecusar}>
                  <input type="hidden" name="oferta" value={o.id} />
                  <button type="submit" className="secundario">Não posso neste horário</button>
                </form>
              </div>
            </article>
          ))}
        </section>
      )}

      <h2>Meus pedidos</h2>
      {dados.pedidos.length === 0 && <p className="suave">Você não está em nenhuma lista de espera.</p>}
      {dados.pedidos.length > 0 && (
        <table>
          <thead><tr><th>Especialidade</th><th>Quem</th><th>Onde e quando</th><th>Situação</th><th></th></tr></thead>
          <tbody>
            {dados.pedidos.map((p) => (
              <tr key={p.id}>
                <td>{p.especialidade}</td>
                <td>{p.paciente ?? "Você"}</td>
                <td>{p.unidade ?? "Qualquer unidade"} · {TURNOS[p.turno]}</td>
                <td>
                  {ESTADOS_PEDIDO[p.estado] ?? p.estado}
                  {p.estado === "aguardando" && <span className="suave"> desde {hora(p.criado_em)} de {new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Fortaleza" }).format(p.criado_em)}</span>}
                  {p.prioridade && <> · <span className="etiqueta">Prioridade: {PRIORIDADES[p.prioridade]}</span></>}
                </td>
                <td>
                  {p.estado === "aguardando" && (
                    <form action={acaoSair}>
                      <input type="hidden" name="pedido" value={p.id} />
                      <button type="submit" className="secundario">Sair da lista</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Entrar na lista</h2>
      {especialidades.length === 0 ? (
        <p className="suave">Ainda não há especialidades abertas neste município.</p>
      ) : (
        <form className="campos" action={acaoEntrar}>
          <label>Especialidade
            <select name="especialidade" required defaultValue={sugestao ?? ""}>
              <option value="" disabled>Escolha</option>
              {especialidades.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          </label>
          {dependentes.length > 0 && (
            <label>Para quem
              <select name="para" defaultValue={dependentes.some((d) => d.id === busca.para) ? busca.para : "eu"}>
                <option value="eu">Para mim</option>
                {dependentes.map((d) => <option key={d.id} value={d.id}>{d.nome_curto}</option>)}
              </select>
            </label>
          )}
          <label>Unidade
            <select name="unidade" defaultValue="">
              <option value="">Qualquer unidade</option>
              {unidades.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
            </select>
          </label>
          <fieldset>
            <legend>Turno</legend>
            {(Object.keys(TURNOS) as Turno[]).map((t) => (
              <label key={t} className="opcao"><input type="radio" name="turno" value={t} defaultChecked={t === "qualquer"} /> {TURNOS[t]}</label>
            ))}
          </fieldset>
          <p className="suave">
            Quando abrir uma vaga que combina, ela fica guardada só para você por 2 horas (contadas das 7h às 20h).
            Pessoa idosa, gestante ou com deficiência: peça na recepção para marcar a prioridade.
            {vigentes.length > 0 && ` Você está em ${vigentes.length} de 3 listas.`}
          </p>
          <button type="submit">Entrar na lista de espera</button>
        </form>
      )}
    </>
  );
}
