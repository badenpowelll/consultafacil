import { redirect } from "next/navigation";
import { FiltroInvalido, painelDoMunicipio, type Painel } from "@/lib/gestao/indicadores";
import { requisicaoAtual } from "@/lib/web/requisicao";
import { semAcesso } from "@/lib/web/acesso";
import { hojeLocal } from "@/lib/web/formato";

interface Busca { de?: string; ate?: string; unidade?: string }

function menosDias(dia: string, n: number): string {
  return new Date(Date.parse(`${dia}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
}

const pct = (v: number | null) => (v === null ? "—" : `${v.toLocaleString("pt-BR")}%`);
const dias = (v: number | null) => (v === null ? "—" : `${v.toLocaleString("pt-BR")} ${v === 1 ? "dia" : "dias"}`);

/** Painel do gestor: números do período, por unidade e especialidade. Sem dado pessoal. */
export default async function PainelGestor({ searchParams }: { searchParams: Promise<Busca> }) {
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  const busca = await searchParams;
  const hoje = hojeLocal();
  const de = busca.de ?? menosDias(hoje, 30);
  const ate = busca.ate ?? hoje;
  let painel: Painel;
  try {
    painel = await painelDoMunicipio(atual.req, { de, ate, unidadeId: busca.unidade });
  } catch (e) {
    if (e instanceof FiltroInvalido) return <><h1>Painel</h1><p className="erro" role="alert">{e.message}</p><p><a href="/equipe/painel">Voltar ao período padrão</a></p></>;
    return semAcesso(e);
  }
  const { totais, filtro } = painel;
  const consulta = new URLSearchParams({ de: filtro.de, ate: filtro.ate, ...(filtro.unidadeId ? { unidade: filtro.unidadeId } : {}) });

  return (
    <>
      <h1>Painel do município</h1>
      <form className="linha" method="get">
        <label>De<input type="date" name="de" defaultValue={filtro.de} /></label>
        <label>Até<input type="date" name="ate" defaultValue={filtro.ate} /></label>
        <label>Unidade
          <select name="unidade" defaultValue={filtro.unidadeId ?? ""}>
            <option value="">Todas as que posso ver</option>
            {painel.unidades.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
          </select>
        </label>
        <button type="submit" className="secundario">Atualizar</button>
      </form>

      <div className="grade indicadores" role="list">
        <Numero titulo="Ocupação" valor={pct(totais.ocupacao)} detalhe={`${totais.ocupadas} de ${totais.vagas} vagas`} />
        <Numero titulo="Faltas" valor={pct(totais.absenteismo)} detalhe={`${totais.faltas} faltas, ${totais.atendidas} atendidos`} />
        <Numero titulo="Vagas ociosas" valor={String(totais.ociosas)} detalhe="Horários que passaram sem ninguém marcado" />
        <Numero titulo="Tempo de espera" valor={dias(totais.espera_mediana_dias)} detalhe="Mediana entre marcar e a consulta" />
        <Numero titulo="Cancelamentos" valor={String(totais.canceladas_cidadao + totais.canceladas_unidade)} detalhe={`${totais.canceladas_cidadao} pelo cidadão, ${totais.canceladas_unidade} pela unidade`} />
      </div>

      <h2>Por unidade e especialidade</h2>
      {painel.linhas.length === 0 && <p className="suave">Nenhuma vaga no período.</p>}
      {painel.linhas.length > 0 && (
        <div className="rolagem">
          <table>
            <thead>
              <tr><th>Unidade</th><th>Especialidade</th><th>Vagas</th><th>Ocupação</th><th>Ociosas</th><th>Atendidos</th><th>Faltas</th><th>Cancel. cidadão</th><th>Cancel. unidade</th><th>Espera (mediana)</th></tr>
            </thead>
            <tbody>
              {painel.linhas.map((l) => (
                <tr key={`${l.unidade}|${l.especialidade}`}>
                  <td>{l.unidade}</td>
                  <td>{l.especialidade}</td>
                  <td>{l.vagas}</td>
                  <td>{pct(l.vagas > 0 ? Math.round((l.ocupadas / l.vagas) * 1000) / 10 : null)}</td>
                  <td>{l.ociosas}</td>
                  <td>{l.atendidas}</td>
                  <td>{l.faltas}</td>
                  <td>{l.canceladas_cidadao}</td>
                  <td>{l.canceladas_unidade}</td>
                  <td>{dias(l.espera_mediana_dias)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Demanda na lista de espera</h2>
      {painel.demanda.length === 0 && <p className="suave">Ninguém na lista de espera.</p>}
      {painel.demanda.length > 0 && (
        <table>
          <thead><tr><th>Especialidade</th><th>Aguardando agora</th><th>Com prioridade</th><th>Tempo na fila (mediana)</th><th>Atendidos pela fila no período</th></tr></thead>
          <tbody>
            {painel.demanda.map((d) => (
              <tr key={d.especialidade}>
                <td>{d.especialidade}</td>
                <td>{d.aguardando}</td>
                <td>{d.com_prioridade}</td>
                <td>{dias(d.dias_na_fila_mediana)}</td>
                <td>{d.atendidos_pela_fila}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Exportar em CSV</h2>
      <p className="suave">Exige a permissão de exportar relatórios e a verificação em duas etapas. Cada arquivo fica registrado na auditoria e não traz nome nem documento de paciente.</p>
      <p className="linha">
        <a className="botao secundario" href={`/equipe/painel/exportar?tipo=indicadores&${consulta}`}>Indicadores do período</a>
        <a className="botao secundario" href={`/equipe/painel/exportar?tipo=consultas&${consulta}`}>Consultas do período</a>
      </p>
    </>
  );
}

function Numero({ titulo, valor, detalhe }: { titulo: string; valor: string; detalhe: string }) {
  return (
    <div className="cartao" role="listitem">
      <p className="suave">{titulo}</p>
      <p className="numero-grande">{valor}</p>
      <p className="suave">{detalhe}</p>
    </div>
  );
}
