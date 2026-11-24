import { redirect } from "next/navigation";
import { minhasConsultas } from "@/lib/agendamento/servico";
import { ErroAgendamento, MENSAGENS, type CodigoErro } from "@/lib/agendamento/erros";
import { requisicaoAtual } from "@/lib/web/requisicao";
import { dataHora, ESTADOS } from "@/lib/web/formato";
import { acaoDesmarcar } from "./acoes";

const OK: Record<string, string> = {
  marcada: "Consulta marcada. Você vai receber a confirmação por e-mail.",
  desmarcada: "Consulta desmarcada. A vaga foi liberada para outra pessoa.",
  remarcada: "Consulta remarcada.",
};

export default async function MinhasConsultas({ searchParams }: { searchParams: Promise<{ erro?: string; ok?: string }> }) {
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  const { erro, ok } = await searchParams;

  let consultas;
  try {
    consultas = await minhasConsultas(atual.req);
  } catch (e) {
    if (e instanceof ErroAgendamento) return <p className="aviso">{e.message}</p>;
    throw e;
  }
  const agora = Date.now();
  const futuras = consultas.filter((c) => c.inicio.getTime() > agora && ["marcada", "confirmada", "aguardando_remanejamento"].includes(c.estado));
  const historico = consultas.filter((c) => !futuras.includes(c));

  return (
    <>
      <h1>Minhas consultas</h1>
      {ok && OK[ok] && <p className="ok" role="status">{OK[ok]}</p>}
      {erro && erro in MENSAGENS && <p className="erro" role="alert">{MENSAGENS[erro as CodigoErro]}</p>}
      <p><a className="botao" href="/marcar">Marcar nova consulta</a></p>

      <h2>Próximas</h2>
      {futuras.length === 0 && <p className="suave">Nenhuma consulta marcada.</p>}
      {futuras.map((c) => (
        <article className="cartao" key={c.id} aria-labelledby={`c-${c.id}`}>
          <h3 id={`c-${c.id}`}>{dataHora(c.inicio)}</h3>
          <p>{c.especialidade} com {c.profissional} · {c.unidade}</p>
          <p><span className="etiqueta">{ESTADOS[c.estado] ?? c.estado}</span></p>
          {c.estado === "aguardando_remanejamento" && (
            <p><a href={`/marcar?remarcar=${c.id}`}>Escolher outro horário</a></p>
          )}
          <details>
            <summary>Não vou poder ir</summary>
            <form className="campos" action={acaoDesmarcar}>
              <input type="hidden" name="consulta" value={c.id} />
              <label>
                Motivo
                <select name="motivo" required defaultValue="">
                  <option value="" disabled>Escolha</option>
                  <option>Não poderei comparecer</option>
                  <option>Já fui atendido em outro lugar</option>
                  <option>Problema de transporte</option>
                  <option>Outro motivo</option>
                </select>
              </label>
              <button className="perigo" type="submit">Desmarcar e liberar a vaga</button>
            </form>
          </details>
        </article>
      ))}

      {historico.length > 0 && (
        <>
          <h2>Histórico</h2>
          <table>
            <thead><tr><th>Quando</th><th>Atendimento</th><th>Situação</th></tr></thead>
            <tbody>
              {historico.map((c) => (
                <tr key={c.id}>
                  <td>{dataHora(c.inicio)}</td>
                  <td>{c.especialidade} · {c.unidade}</td>
                  <td>{ESTADOS[c.estado] ?? c.estado}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
