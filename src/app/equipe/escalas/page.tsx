import { redirect } from "next/navigation";
import { equipeSemCadastroProfissional, profissionaisAtivos, unidadesComPermissao, type Opcao } from "@/lib/agendamento/consultas";
import { MENSAGENS, type CodigoErro } from "@/lib/agendamento/erros";
import { requisicaoAtual } from "@/lib/web/requisicao";
import { hojeLocal } from "@/lib/web/formato";
import { acaoAusencia, acaoEscala, acaoProfissional } from "./acoes";

const DIAS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
const ERROS_ACESSO: Record<string, string> = {
  sem_mfa: "Cadastrar profissionais exige verificação em duas etapas. Ative em Conta › Segurança e entre de novo.",
  sem_permissao: "Você não tem permissão para essa ação nesta unidade.",
};

interface Busca { erro?: string; ok?: string; criadas?: string; conflitos?: string; afetadas?: string }

export default async function Escalas({ searchParams }: { searchParams: Promise<Busca> }) {
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  const { req } = atual;
  const b = await searchParams;
  const [unidadesEscala, unidadesAusencia] = await Promise.all([unidadesComPermissao(req, "escala.editar"), unidadesComPermissao(req, "ausencia.registrar")]);
  const profissionais = await profissionaisAtivos(req).catch(() => [] as (Opcao & { especialidade: string })[]);
  const equipe = await equipeSemCadastroProfissional(req).catch(() => null);
  const hoje = hojeLocal();
  const erro = b.erro ? ERROS_ACESSO[b.erro] ?? (b.erro in MENSAGENS ? MENSAGENS[b.erro as CodigoErro] : null) : null;

  return (
    <>
      <h1>Escalas e ausências</h1>
      {erro && <p className="erro" role="alert">{erro}</p>}
      {b.ok === "profissional" && <p className="ok" role="status">Profissional cadastrado.</p>}
      {b.ok === "escala" && (
        <p className="ok" role="status">
          {Number(b.criadas)} vagas abertas.{Number(b.conflitos) > 0 && ` ${Number(b.conflitos)} horários não foram abertos porque o profissional já tem compromisso nesse horário (em outra unidade ou município).`}
        </p>
      )}
      {b.ok === "ausencia" && <p className="ok" role="status">Ausência registrada. {Number(b.afetadas)} pacientes serão avisados por e-mail e aparecem como “aguardando novo horário”.</p>}

      {equipe && (
        <section aria-labelledby="t-prof">
          <h2 id="t-prof">Cadastrar profissional</h2>
          {equipe.length === 0 ? <p className="suave">Todos os membros da equipe já têm cadastro profissional.</p> : (
            <form className="campos" action={acaoProfissional}>
              <label>Pessoa da equipe
                <select name="vinculo" required defaultValue="">
                  <option value="" disabled>Escolha</option>
                  {equipe.map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}
                </select>
              </label>
              <label>Nome exibido aos pacientes<input name="nome" required maxLength={120} placeholder="Dra. Maria" /></label>
              <label>Especialidade<input name="especialidade" required maxLength={80} placeholder="Clínica geral" /></label>
              <label>Registro profissional <span className="ajuda">Opcional. Ex.: CRM-RN-12345</span><input name="registro" maxLength={20} /></label>
              <button type="submit">Cadastrar</button>
            </form>
          )}
        </section>
      )}

      {unidadesEscala.length > 0 && profissionais.length > 0 && (
        <section aria-labelledby="t-escala">
          <h2 id="t-escala">Dias e horários de atendimento</h2>
          <form className="campos" action={acaoEscala}>
            <label>Profissional
              <select name="profissional" required>{profissionais.map((p) => <option key={p.id} value={p.id}>{p.nome} · {p.especialidade}</option>)}</select>
            </label>
            <label>Unidade
              <select name="unidade" required>{unidadesEscala.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}</select>
            </label>
            <fieldset>
              <legend>Dias da semana</legend>
              <div className="linha">
                {DIAS.map((d, i) => (
                  <label key={d} className="opcao">
                    <input type="checkbox" name="dia" value={i} defaultChecked={i >= 1 && i <= 5} /> {d}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="linha">
              <label>Início<input type="time" name="inicio" required defaultValue="07:00" /></label>
              <label>Fim<input type="time" name="fim" required defaultValue="11:00" /></label>
              <label>Minutos por consulta<input type="number" name="duracao" min={5} max={240} required defaultValue={20} /></label>
            </div>
            <div className="linha">
              <label>Vale a partir de<input type="date" name="vigencia_inicio" required defaultValue={hoje} /></label>
              <label>Até (opcional)<input type="date" name="vigencia_fim" /></label>
              <label>Abrir vagas até<input type="date" name="gerar_ate" required /></label>
            </div>
            <button type="submit">Salvar e abrir vagas</button>
          </form>
        </section>
      )}

      {unidadesAusencia.length > 0 && profissionais.length > 0 && (
        <section aria-labelledby="t-aus">
          <h2 id="t-aus">O profissional não poderá atender</h2>
          <p className="suave">As vagas livres do período são bloqueadas. As consultas marcadas continuam registradas, aguardando novo horário, e cada paciente recebe um e-mail.</p>
          <form className="campos" action={acaoAusencia}>
            <label>Profissional
              <select name="profissional" required>{profissionais.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}</select>
            </label>
            <label>Unidade
              <select name="unidade" required>{unidadesAusencia.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}</select>
            </label>
            <div className="linha">
              <label>De<input type="datetime-local" name="inicio" required /></label>
              <label>Até<input type="datetime-local" name="fim" required /></label>
            </div>
            <label>Motivo<input name="motivo" required minLength={3} maxLength={300} placeholder="Ex.: atestado médico" /></label>
            <button type="submit" className="perigo">Registrar ausência e avisar pacientes</button>
          </form>
        </section>
      )}

      {!equipe && unidadesEscala.length === 0 && unidadesAusencia.length === 0 && (
        <p className="aviso">Você não tem permissão para gerenciar escalas. Peça ao gestor do município.</p>
      )}
    </>
  );
}
