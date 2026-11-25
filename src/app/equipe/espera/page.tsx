import Link from "next/link";
import { redirect } from "next/navigation";
import { definirPrioridade, filaDeEspera, nomesNaEspera, opcoesDaEspera, PRIORIDADES, removerDaEspera, TURNOS } from "@/lib/agendamento/espera";
import { ErroAgendamento, MENSAGENS, type CodigoErro } from "@/lib/agendamento/erros";
import { AcessoNegado } from "@/lib/auth/autorizar";
import { requisicaoAtual } from "@/lib/web/requisicao";
import { semAcesso } from "@/lib/web/acesso";
import { dataHora } from "@/lib/web/formato";

async function executar(f: FormData, trabalho: (req: NonNullable<Awaited<ReturnType<typeof requisicaoAtual>>>["req"]) => Promise<unknown>): Promise<never> {
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  const filtro = String(f.get("filtro") ?? "");
  const base = `/equipe/espera?${new URLSearchParams(filtro ? { especialidade: filtro } : {}).toString()}`;
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

async function acaoPrioridade(f: FormData): Promise<void> {
  "use server";
  await executar(f, (req) => definirPrioridade(req, f.get("pedido"), f.get("prioridade")));
}

async function acaoRemover(f: FormData): Promise<void> {
  "use server";
  await executar(f, (req) => removerDaEspera(req, f.get("pedido")));
}

/** Fila de espera do município, na ordem em que as vagas são oferecidas. */
export default async function Espera({ searchParams }: { searchParams: Promise<{ especialidade?: string; erro?: string; ok?: string }> }) {
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  const busca = await searchParams;
  let fila;
  try {
    fila = await filaDeEspera(atual.req, busca.especialidade);
  } catch (e) {
    return semAcesso(e);
  }
  const nomes = await nomesNaEspera(atual.req, fila.map((f) => f.id));
  const { especialidades } = await opcoesDaEspera(atual.req);
  const filtro = especialidades.find((e) => e.toLowerCase() === busca.especialidade?.toLowerCase()) ?? "";
  const erro = busca.erro === "sem_permissao" ? "Você não tem permissão para mudar a lista de espera." : busca.erro && busca.erro in MENSAGENS ? MENSAGENS[busca.erro as CodigoErro] : null;

  // Posição dentro de cada especialidade.
  const posicao = new Map<string, number>();
  const contagem = new Map<string, number>();
  for (const f of fila) {
    const k = f.especialidade.toLowerCase();
    contagem.set(k, (contagem.get(k) ?? 0) + 1);
    posicao.set(f.id, contagem.get(k)!);
  }

  return (
    <>
      <h1>Lista de espera</h1>
      <p className="suave">
        Quando uma vaga abre, o sistema oferece ao primeiro da fila que combina (prioridade primeiro, depois ordem de entrada).
        A vaga fica guardada para a pessoa por 2 horas, contadas das 7h às 20h. Para incluir alguém, abra a <Link href="/equipe/cidadaos">ficha do cidadão</Link>.
      </p>
      {erro && <p className="erro" role="alert">{erro}</p>}
      {busca.ok && <p className="ok" role="status">Feito.</p>}
      <form className="linha" method="get">
        <label>Especialidade
          <select name="especialidade" defaultValue={filtro}>
            <option value="">Todas</option>
            {especialidades.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
        </label>
        <button type="submit" className="secundario">Filtrar</button>
      </form>
      {fila.length === 0 && <p className="suave">Ninguém na lista de espera.</p>}
      {fila.length > 0 && (
        <table>
          <thead><tr><th>Posição</th><th>Especialidade</th><th>Pessoa</th><th>Onde e quando</th><th>Desde</th><th>Situação</th><th>Ações</th></tr></thead>
          <tbody>
            {fila.map((f) => (
              <tr key={f.id}>
                <td>{posicao.get(f.id)}º</td>
                <td>{f.especialidade}</td>
                <td><Link href={`/equipe/cidadaos/${f.cidadao_vinculo_id}`}>{nomes.get(f.id) ?? "—"}</Link></td>
                <td>{f.unidade ?? "Qualquer unidade"} · {TURNOS[f.turno]}</td>
                <td>{dataHora(f.criado_em)}</td>
                <td>
                  {f.oferta_ate && f.oferta_inicio ? <>Vaga de {dataHora(f.oferta_inicio)} oferecida até {dataHora(f.oferta_ate)}</> : "Aguardando vaga"}
                  {f.prioridade && <> · <span className="etiqueta">{PRIORIDADES[f.prioridade]}</span></>}
                </td>
                <td>
                  <details>
                    <summary>Alterar</summary>
                    <form className="campos" action={acaoPrioridade}>
                      <input type="hidden" name="pedido" value={f.id} />
                      <input type="hidden" name="filtro" value={filtro} />
                      <label>Prioridade
                        <select name="prioridade" defaultValue={f.prioridade ?? ""}>
                          <option value="">Sem prioridade</option>
                          {Object.entries(PRIORIDADES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                      </label>
                      <button type="submit" className="secundario">Salvar prioridade</button>
                    </form>
                    <form action={acaoRemover}>
                      <input type="hidden" name="pedido" value={f.id} />
                      <input type="hidden" name="filtro" value={filtro} />
                      <button type="submit" className="perigo">Tirar da lista</button>
                    </form>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
