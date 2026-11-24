import { redirect } from "next/navigation";
import { vagasParaCidadao, type VagaLivre } from "@/lib/agendamento/servico";
import { ErroAgendamento, MENSAGENS, type CodigoErro } from "@/lib/agendamento/erros";
import { requisicaoAtual } from "@/lib/web/requisicao";
import { dataHora, hojeLocal } from "@/lib/web/formato";
import { acaoMarcar } from "./acoes";

interface Busca {
  especialidade?: string;
  de?: string;
  erro?: string;
  remarcar?: string;
}

export default async function Marcar({ searchParams }: { searchParams: Promise<Busca> }) {
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  const busca = await searchParams;
  const de = /^\d{4}-\d{2}-\d{2}$/.test(busca.de ?? "") ? busca.de! : hojeLocal();
  const ate = new Date(new Date(`${de}T00:00:00-03:00`).getTime() + 14 * 86_400_000);
  const especialidade = busca.especialidade?.trim() || undefined;
  const remarcar = /^[0-9a-f-]{36}$/i.test(busca.remarcar ?? "") ? busca.remarcar : undefined;

  let vagas: VagaLivre[] = [];
  let aviso: string | null = null;
  try {
    vagas = await vagasParaCidadao(atual.req, { de: `${de}T00:00:00-03:00`, ate, especialidade });
  } catch (e) {
    if (!(e instanceof ErroAgendamento)) throw e;
    aviso = e.message;
  }

  return (
    <>
      <h1>{remarcar ? "Escolher novo horário" : "Marcar consulta"}</h1>
      {busca.erro && busca.erro in MENSAGENS && <p className="erro" role="alert">{MENSAGENS[busca.erro as CodigoErro]}</p>}
      {aviso && <p className="aviso">{aviso}</p>}
      <form className="linha" method="get" role="search" aria-label="Buscar horários">
        {remarcar && <input type="hidden" name="remarcar" value={remarcar} />}
        <label>Especialidade<input name="especialidade" defaultValue={especialidade} placeholder="Ex.: Clínica geral" maxLength={80} /></label>
        <label>A partir de<input name="de" type="date" defaultValue={de} min={hojeLocal()} /></label>
        <button type="submit" className="secundario">Buscar</button>
      </form>
      <h2>Horários livres nos próximos 14 dias</h2>
      {vagas.length === 0 && !aviso && <p className="suave">Nenhum horário livre com esses filtros. Tente outra data ou especialidade.</p>}
      <div className="grade">
        {vagas.map((v) => (
          <form key={v.id} className="cartao" action={acaoMarcar}>
            <input type="hidden" name="vaga" value={v.id} />
            {remarcar && <input type="hidden" name="remarcar" value={remarcar} />}
            <p className="destaque">{dataHora(v.inicio)}</p>
            <p>{v.especialidade} com {v.profissional}</p>
            <p className="suave">{v.unidade}</p>
            <button type="submit">{remarcar ? "Trocar para este horário" : "Marcar este horário"}</button>
          </form>
        ))}
      </div>
    </>
  );
}
