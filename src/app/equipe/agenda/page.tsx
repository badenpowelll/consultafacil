import { redirect } from "next/navigation";
import { agendaDoDia, type ItemAgenda } from "@/lib/agendamento/servico";
import { nomesDosPacientes, unidadesComPermissao } from "@/lib/agendamento/consultas";
import { MENSAGENS, type CodigoErro } from "@/lib/agendamento/erros";
import { AcessoNegado, comPermissao } from "@/lib/auth/autorizar";
import { requisicaoAtual } from "@/lib/web/requisicao";
import { hojeLocal, hora, ESTADOS } from "@/lib/web/formato";
import { semAcesso } from "@/lib/web/acesso";
import { fichaDoCidadao } from "@/lib/cidadao/recepcao";
import { dependentesDoCidadao } from "@/lib/cidadao/familia";
import { acaoDesmarcarUnidade, acaoMarcarParaCidadao, acaoSituacao } from "./acoes";

interface Busca { unidade?: string; dia?: string; erro?: string; ok?: string; para?: string; dep?: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Agenda({ searchParams }: { searchParams: Promise<Busca> }) {
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  const { req } = atual;
  const busca = await searchParams;
  const unidades = await unidadesComPermissao(req, "agenda.ver");
  if (unidades.length === 0) return semAcesso(new AcessoNegado("sem_permissao"));

  const unidade = unidades.find((u) => u.id === busca.unidade) ?? unidades[0]!;
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(busca.dia ?? "") ? busca.dia! : hojeLocal();

  let itens: ItemAgenda[];
  try {
    itens = await agendaDoDia(req, unidade.id, dia);
  } catch (e) {
    return semAcesso(e);
  }
  const nomes = await nomesDosPacientes(req, unidade.id, itens.flatMap((i) => (i.agendamento_id ? [i.agendamento_id] : [])));
  // Vindo da ficha do cidadão na recepção: marca direto para ele (ou o dependente escolhido).
  const para = UUID.test(busca.para ?? "") ? busca.para! : null;
  const dep = para && UUID.test(busca.dep ?? "") ? busca.dep! : null;
  let paraNome: string | null = null;
  if (para) {
    const ficha = await fichaDoCidadao(req, para).catch(() => null);
    const deps = dep && ficha ? await dependentesDoCidadao(req, para).catch(() => []) : [];
    const d = deps.find((x) => x.id === dep && x.estado === "ativo");
    paraNome = ficha ? (d ? `${d.nome} (dependente de ${ficha.nome})` : ficha.nome) : null;
  }
  const podeMarcar = await comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "agenda.marcar", unidadeId: unidade.id }, async (tx) =>
    (await tx.query<{ vinculo_id: string; nome: string; estado: string }>("SELECT * FROM app.membros_do_municipio('cidadao')")).rows.filter((c) => c.estado === "ativo"),
  ).catch(() => null);

  const erro = busca.erro === "sem_permissao" ? "Você não tem permissão para essa ação nesta unidade." : busca.erro && busca.erro in MENSAGENS ? MENSAGENS[busca.erro as CodigoErro] : null;

  return (
    <>
      <h1>Agenda do dia</h1>
      {erro && <p className="erro" role="alert">{erro}</p>}
      {busca.ok && <p className="ok" role="status">Feito.</p>}
      {paraNome && (
        <p className="aviso" role="status">
          Marcando para <strong>{paraNome}</strong>. Escolha um horário livre e use “Marcar”. <a href={`/equipe/cidadaos/${para}`}>Voltar à ficha</a>
        </p>
      )}
      <form className="linha" method="get">
        {paraNome && <input type="hidden" name="para" value={para!} />}
        {paraNome && dep && <input type="hidden" name="dep" value={dep} />}
        <label>Unidade
          <select name="unidade" defaultValue={unidade.id}>
            {unidades.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
          </select>
        </label>
        <label>Dia<input type="date" name="dia" defaultValue={dia} /></label>
        <button type="submit" className="secundario">Ver</button>
      </form>

      {itens.length === 0 && <p className="suave">Nenhum horário nesta unidade neste dia.</p>}
      {itens.length > 0 && (
        <table>
          <thead><tr><th>Hora</th><th>Profissional</th><th>Paciente</th><th>Situação</th><th>Ações</th></tr></thead>
          <tbody>
            {itens.map((i) => (
              <tr key={i.vaga_id}>
                <td>{hora(i.inicio)}</td>
                <td>{i.profissional}</td>
                <td>{i.agendamento_id ? nomes.get(i.agendamento_id) ?? "—" : <span className="suave">{i.estado_vaga === "bloqueada" ? "Bloqueada" : i.oferecida_ate ? `Oferecida à lista de espera até ${hora(i.oferecida_ate)}` : "Livre"}</span>}</td>
                <td>
                  {i.estado_consulta ? ESTADOS[i.estado_consulta] ?? i.estado_consulta : ""}
                  {i.agendamento_id && <> · <a href={`/comprovante/${i.agendamento_id}`} target="_blank" rel="noopener">Comprovante</a></>}
                </td>
                <td>
                  {i.agendamento_id && ["marcada", "confirmada", "presente"].includes(i.estado_consulta ?? "") && i.inicio.getTime() <= Date.now() + 2 * 3_600_000 && (
                    <div className="linha">
                      {i.estado_consulta !== "presente" && <Situacao consulta={i.agendamento_id} estado="presente" rotulo="Chegou" unidade={unidade.id} dia={dia} />}
                      {i.estado_consulta === "presente" && <Situacao consulta={i.agendamento_id} estado="atendida" rotulo="Atendida" unidade={unidade.id} dia={dia} />}
                      {i.inicio.getTime() <= Date.now() && <Situacao consulta={i.agendamento_id} estado="faltou" rotulo="Faltou" unidade={unidade.id} dia={dia} />}
                    </div>
                  )}
                  {i.agendamento_id && ["marcada", "confirmada", "aguardando_remanejamento"].includes(i.estado_consulta ?? "") && (
                    <details>
                      <summary>Desmarcar</summary>
                      <form className="campos" action={acaoDesmarcarUnidade}>
                        <input type="hidden" name="consulta" value={i.agendamento_id} />
                        <input type="hidden" name="unidade" value={unidade.id} />
                        <input type="hidden" name="dia" value={dia} />
                        <label>Motivo (o paciente será avisado)<input name="motivo" required minLength={3} maxLength={300} /></label>
                        <button className="perigo" type="submit">Desmarcar</button>
                      </form>
                    </details>
                  )}
                  {!i.agendamento_id && i.estado_vaga === "livre" && !i.oferecida_ate && podeMarcar && i.inicio.getTime() > Date.now() && (
                    <details>
                      <summary>{paraNome ? "Marcar" : "Marcar para cidadão"}</summary>
                      <form className="campos" action={acaoMarcarParaCidadao}>
                        <input type="hidden" name="vaga" value={i.vaga_id} />
                        <input type="hidden" name="unidade" value={unidade.id} />
                        <input type="hidden" name="dia" value={dia} />
                        {paraNome ? (
                          <>
                            <input type="hidden" name="cidadao" value={para!} />
                            {dep && <input type="hidden" name="dependente" value={dep} />}
                            <p className="suave">Para {paraNome}</p>
                          </>
                        ) : (
                          <label>Cidadão
                            <select name="cidadao" required defaultValue="">
                              <option value="" disabled>Escolha</option>
                              {podeMarcar.map((c) => <option key={c.vinculo_id} value={c.vinculo_id}>{c.nome}</option>)}
                            </select>
                          </label>
                        )}
                        <button type="submit">Marcar</button>
                      </form>
                    </details>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Situacao({ consulta, estado, rotulo, unidade, dia }: { consulta: string; estado: string; rotulo: string; unidade: string; dia: string }) {
  return (
    <form action={acaoSituacao}>
      <input type="hidden" name="consulta" value={consulta} />
      <input type="hidden" name="estado" value={estado} />
      <input type="hidden" name="unidade" value={unidade} />
      <input type="hidden" name="dia" value={dia} />
      <button type="submit" className={estado === "faltou" ? "perigo" : "secundario"}>{rotulo}</button>
    </form>
  );
}
