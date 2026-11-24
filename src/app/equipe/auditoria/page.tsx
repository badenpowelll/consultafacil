import Link from "next/link";
import { redirect } from "next/navigation";
import { consultarAuditoria } from "@/lib/gestao/auditoria";
import { ErroGestao } from "@/lib/gestao/perfis";
import { requisicaoAtual } from "@/lib/web/requisicao";
import { semAcesso } from "@/lib/web/acesso";

type Filtros = { de?: string; ate?: string; modulo?: string; acao?: string; pagina?: string };

function quando(d: Date): string {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "medium", timeZone: "America/Fortaleza" }).format(d);
}

function consulta(f: Filtros, pagina?: number): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, pagina: pagina ? String(pagina) : undefined })) if (v) p.set(k, v);
  return p.toString();
}

/** Menu de auditoria: quem fez o quê, quando e de onde. Somente leitura; exige auditoria.ver com MFA. */
export default async function Auditoria({ searchParams }: { searchParams: Promise<Filtros> }) {
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  const f = await searchParams;
  const filtros = { de: f.de || undefined, ate: f.ate || undefined, modulo: f.modulo || undefined, acao: f.acao || undefined };
  let pagina;
  try {
    pagina = await consultarAuditoria(atual.req, { ...filtros, pagina: f.pagina || 1 });
  } catch (e) {
    if (e instanceof ErroGestao) return <p className="erro" role="alert">Filtro inválido. <Link href="/equipe/auditoria">Limpar filtros</Link></p>;
    return semAcesso(e);
  }
  return (
    <>
      <h1>Auditoria</h1>
      <p className="suave">Registro de tudo o que foi feito no sistema neste município. Ninguém altera nem apaga estes registros, nem o gestor.</p>
      <form className="campos linha" method="get" action="/equipe/auditoria">
        <label>De <input type="date" name="de" defaultValue={filtros.de} /></label>
        <label>Até <input type="date" name="ate" defaultValue={filtros.ate} /></label>
        <label>
          Módulo
          <select name="modulo" defaultValue={filtros.modulo ?? ""}>
            <option value="">Todos</option>
            {pagina.modulos.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label>Ação começa com <input name="acao" defaultValue={filtros.acao} placeholder="ex.: agenda" maxLength={60} /></label>
        <button type="submit">Filtrar</button>
      </form>
      <p><a href={`/equipe/auditoria/exportar?${consulta(filtros)}`}>Exportar CSV com estes filtros</a></p>
      {pagina.linhas.length === 0 && <p className="suave">Nenhum registro com esses filtros.</p>}
      {pagina.linhas.length > 0 && (
        <table>
          <thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Objeto</th><th>Detalhes</th><th>IP</th></tr></thead>
          <tbody>
            {pagina.linhas.map((l) => (
              <tr key={l.id}>
                <td>{quando(l.criado_em)}</td>
                <td>{l.quem ?? <span className="suave">Sistema</span>}</td>
                <td><code>{l.acao}</code></td>
                <td>{l.objeto_tipo ? <><span>{l.objeto_tipo}</span> <code className="suave">{l.objeto_id?.slice(0, 8)}</code></> : ""}</td>
                <td><code className="quebra">{Object.keys(l.detalhes).length ? JSON.stringify(l.detalhes) : ""}</code></td>
                <td>{l.ip ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="linha">
        {pagina.pagina > 1 && <a href={`/equipe/auditoria?${consulta(f, pagina.pagina - 1)}`}>Mais recentes</a>}
        {pagina.temMais && <a href={`/equipe/auditoria?${consulta(f, pagina.pagina + 1)}`}>Mais antigos</a>}
      </p>
    </>
  );
}
