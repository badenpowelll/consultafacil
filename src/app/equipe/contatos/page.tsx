import { redirect } from "next/navigation";
import { aceitarOfertaPelaUnidade, contatosPendentes, nomesNaEspera } from "@/lib/agendamento/espera";
import { confirmarPelaUnidade } from "@/lib/agendamento/servico";
import { nomesDosPacientes, unidadesComPermissao } from "@/lib/agendamento/consultas";
import { ErroAgendamento, MENSAGENS, type CodigoErro } from "@/lib/agendamento/erros";
import { AcessoNegado } from "@/lib/auth/autorizar";
import { requisicaoAtual } from "@/lib/web/requisicao";
import { semAcesso } from "@/lib/web/acesso";
import { dataHora } from "@/lib/web/formato";

async function executar(f: FormData, trabalho: (req: NonNullable<Awaited<ReturnType<typeof requisicaoAtual>>>["req"]) => Promise<unknown>): Promise<never> {
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  const base = `/equipe/contatos?unidade=${encodeURIComponent(String(f.get("unidade") ?? ""))}`;
  let destino = `${base}&ok=1`;
  try {
    await trabalho(atual.req);
  } catch (e) {
    if (e instanceof ErroAgendamento) destino = `${base}&erro=${e.codigo}`;
    else if (e instanceof AcessoNegado) destino = `${base}&erro=sem_permissao`;
    else throw e;
  }
  redirect(destino);
}

async function acaoConfirmar(f: FormData): Promise<void> {
  "use server";
  await executar(f, (req) => confirmarPelaUnidade(req, f.get("consulta")));
}

async function acaoAceitar(f: FormData): Promise<void> {
  "use server";
  await executar(f, (req) => aceitarOfertaPelaUnidade(req, f.get("oferta")));
}

const AVISO: Record<string, string> = { sem_contato: "Sem e-mail cadastrado", falhou: "E-mail não entregue" };

/**
 * Quem a recepção precisa procurar por telefone ou no balcão. Ninguém perde a consulta por não
 * responder: esta lista existe para a unidade ir atrás.
 */
export default async function Contatos({ searchParams }: { searchParams: Promise<{ unidade?: string; erro?: string; ok?: string }> }) {
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  const { req } = atual;
  const busca = await searchParams;
  const unidades = await unidadesComPermissao(req, "agenda.ver");
  if (unidades.length === 0) return semAcesso(new AcessoNegado("sem_permissao"));
  const unidade = unidades.find((u) => u.id === busca.unidade) ?? unidades[0]!;
  let dados;
  try {
    dados = await contatosPendentes(req, unidade.id);
  } catch (e) {
    return semAcesso(e);
  }
  const nomes = await nomesDosPacientes(req, unidade.id, dados.consultas.map((c) => c.agendamento_id));
  const nomesOferta = await nomesNaEspera(req, dados.ofertas.map((o) => o.espera_id));
  const semConfirmar = dados.consultas.filter((c) => c.motivo === "sem_confirmacao");
  const remanejar = dados.consultas.filter((c) => c.motivo === "aguardando_remanejamento");
  const erro = busca.erro === "sem_permissao" ? "Você não tem permissão para essa ação nesta unidade." : busca.erro && busca.erro in MENSAGENS ? MENSAGENS[busca.erro as CodigoErro] : null;

  return (
    <>
      <h1>Contatos pendentes</h1>
      <p className="suave">Quem precisa de uma ligação ou de um aviso no balcão. Nenhuma consulta é desmarcada por falta de resposta.</p>
      {erro && <p className="erro" role="alert">{erro}</p>}
      {busca.ok && <p className="ok" role="status">Feito.</p>}
      <form className="linha" method="get">
        <label>Unidade
          <select name="unidade" defaultValue={unidade.id}>
            {unidades.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
          </select>
        </label>
        <button type="submit" className="secundario">Ver</button>
      </form>

      <h2>Vaga da lista de espera que acontece em menos de 24 horas</h2>
      {dados.ofertas.length === 0 && <p className="suave">Nenhuma.</p>}
      {dados.ofertas.length > 0 && (
        <table>
          <thead><tr><th>Consulta</th><th>Pessoa</th><th>Atendimento</th><th>Responder até</th><th>Ação</th></tr></thead>
          <tbody>
            {dados.ofertas.map((o) => (
              <tr key={o.oferta_id}>
                <td>{dataHora(o.inicio)}</td>
                <td>{nomesOferta.get(o.espera_id) ?? "—"}</td>
                <td>{o.especialidade} com {o.profissional}</td>
                <td>{dataHora(o.expira_em)}</td>
                <td>
                  <form action={acaoAceitar}>
                    <input type="hidden" name="oferta" value={o.oferta_id} />
                    <input type="hidden" name="unidade" value={unidade.id} />
                    <button type="submit">A pessoa aceitou</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Profissional ausente: escolher novo horário</h2>
      {remanejar.length === 0 && <p className="suave">Nenhuma.</p>}
      {remanejar.length > 0 && (
        <table>
          <thead><tr><th>Consulta</th><th>Paciente</th><th>Atendimento</th><th>Aviso</th></tr></thead>
          <tbody>
            {remanejar.map((c) => (
              <tr key={c.agendamento_id}>
                <td>{dataHora(c.inicio)}</td>
                <td>{nomes.get(c.agendamento_id) ?? "—"}</td>
                <td>{c.especialidade} com {c.profissional}</td>
                <td>{c.aviso ? <strong>{AVISO[c.aviso]}</strong> : "Avisado por e-mail"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Próximas 48 horas sem confirmação</h2>
      {semConfirmar.length === 0 && <p className="suave">Todos confirmaram.</p>}
      {semConfirmar.length > 0 && (
        <table>
          <thead><tr><th>Consulta</th><th>Paciente</th><th>Atendimento</th><th>Aviso</th><th>Ação</th></tr></thead>
          <tbody>
            {semConfirmar.map((c) => (
              <tr key={c.agendamento_id}>
                <td>{dataHora(c.inicio)}</td>
                <td>{nomes.get(c.agendamento_id) ?? "—"}</td>
                <td>{c.especialidade} com {c.profissional}</td>
                <td>{c.aviso ? <strong>{AVISO[c.aviso]}</strong> : "Avisado por e-mail"}</td>
                <td>
                  <form action={acaoConfirmar}>
                    <input type="hidden" name="consulta" value={c.agendamento_id} />
                    <input type="hidden" name="unidade" value={unidade.id} />
                    <button type="submit" className="secundario">Confirmou</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
