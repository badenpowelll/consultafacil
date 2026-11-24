import { redirect } from "next/navigation";
import {
  alterarPerfil, atribuirPerfil, criarPerfil, ErroGestao, MENSAGENS_GESTAO, MODELOS_POR_SETOR, painelDePerfis, removerAtribuicao,
  SETORES, type Setor,
} from "@/lib/gestao/perfis";
import { requisicaoAtual } from "@/lib/web/requisicao";
import { semAcesso } from "@/lib/web/acesso";

/** Perfis por setor e quem tem cada um, em cada unidade. Exige gestao.perfis com MFA. */
async function executar(trabalho: () => Promise<unknown>, ok: string): Promise<never> {
  try {
    await trabalho();
  } catch (e) {
    if (e instanceof ErroGestao) redirect(`/equipe/perfis?erro=${e.codigo}`);
    throw e;
  }
  redirect(`/equipe/perfis?ok=${ok}`);
}

async function requisicao() {
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  return atual.req;
}

async function acaoCriar(f: FormData): Promise<void> {
  "use server";
  const req = await requisicao();
  const setor = String(f.get("setor") ?? "") as Setor;
  const marcadas = f.getAll("permissao").map(String);
  // Sem nenhuma marcada, começa pelo modelo do setor (só o que quem cria pode conceder).
  const permitidas = new Set(f.getAll("disponivel").map(String));
  const permissoes = marcadas.length ? marcadas : (MODELOS_POR_SETOR[setor] ?? []).filter((p) => permitidas.has(p));
  await executar(() => criarPerfil(req, { nome: f.get("nome"), setor, permissoes }), "criado");
}

async function acaoAlterar(f: FormData): Promise<void> {
  "use server";
  const req = await requisicao();
  await executar(
    () => alterarPerfil(req, f.get("perfil"), {
      nome: f.get("nome"), setor: f.get("setor"), ativo: f.get("ativo") === "sim", permissoes: f.getAll("permissao").map(String),
    }),
    "alterado",
  );
}

async function acaoAtribuir(f: FormData): Promise<void> {
  "use server";
  const req = await requisicao();
  const unidade = String(f.get("unidade") ?? "");
  await executar(
    () => atribuirPerfil(req, { vinculoId: f.get("membro"), perfilId: f.get("perfil"), unidadeId: unidade === "todas" ? null : unidade }),
    "atribuido",
  );
}

async function acaoRemover(f: FormData): Promise<void> {
  "use server";
  const req = await requisicao();
  await executar(() => removerAtribuicao(req, f.get("atribuicao")), "removido");
}

const MODULOS: Record<string, string> = {
  agendamento: "Agendamento", recepcao: "Recepção", cadastro: "Cadastro de cidadãos", gestao: "Gestão", auditoria: "Auditoria",
};

const OK: Record<string, string> = {
  criado: "Perfil criado. Confira as permissões abaixo.",
  alterado: "Perfil atualizado. Vale imediatamente para quem tem esse perfil.",
  atribuido: "Perfil atribuído.",
  removido: "Perfil retirado. O acesso acabou na hora.",
};

export default async function Perfis({ searchParams }: { searchParams: Promise<{ erro?: string; ok?: string }> }) {
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  const { erro, ok } = await searchParams;
  let painel;
  try {
    painel = await painelDePerfis(atual.req);
  } catch (e) {
    return semAcesso(e);
  }
  const descricao = new Map(painel.catalogo.map((c) => [c.codigo, c.descricao]));
  const porModulo = new Map<string, typeof painel.catalogo>();
  for (const c of painel.catalogo) porModulo.set(c.modulo, [...(porModulo.get(c.modulo) ?? []), c]);
  const nomeMembro = new Map(painel.membros.map((m) => [m.vinculo_id, m.nome]));

  const caixas = (marcadas: string[]) =>
    [...porModulo.entries()].map(([modulo, itens]) => (
      <fieldset key={modulo} className="permissoes">
        <legend>{MODULOS[modulo] ?? modulo}</legend>
        {itens.map((c) => (
          <label key={c.codigo} className="marcar">
            <input type="checkbox" name="permissao" value={c.codigo} defaultChecked={marcadas.includes(c.codigo)} /> {c.descricao}
          </label>
        ))}
      </fieldset>
    ));

  return (
    <>
      <h1>Perfis e permissões</h1>
      <p className="suave">Monte um perfil por setor e dê a cada pessoa da equipe, numa unidade ou em todas. Quem não é gestor só concede o que já tem.</p>
      {ok && OK[ok] && <p className="ok" role="status">{OK[ok]}</p>}
      {erro && erro in MENSAGENS_GESTAO && <p className="erro" role="alert">{MENSAGENS_GESTAO[erro as keyof typeof MENSAGENS_GESTAO]}</p>}

      <h2>Quem tem cada perfil</h2>
      {painel.atribuicoes.length === 0 && <p className="suave">Ninguém recebeu perfil ainda.</p>}
      {painel.atribuicoes.length > 0 && (
        <table>
          <thead><tr><th>Pessoa</th><th>Perfil</th><th>Onde</th><th><span className="sr">Ação</span></th></tr></thead>
          <tbody>
            {painel.atribuicoes.map((a) => (
              <tr key={a.id}>
                <td>{nomeMembro.get(a.vinculo_id) ?? "—"}</td>
                <td>{a.perfil}</td>
                <td>{a.unidade ?? "Todas as unidades"}</td>
                <td>
                  <form action={acaoRemover}>
                    <input type="hidden" name="atribuicao" value={a.id} />
                    <button className="secundario" type="submit">Retirar</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form className="campos cartao" action={acaoAtribuir}>
        <h3>Dar um perfil</h3>
        <label>
          Pessoa da equipe
          <select name="membro" required defaultValue="">
            <option value="" disabled>Escolha</option>
            {painel.membros.map((m) => <option key={m.vinculo_id} value={m.vinculo_id}>{m.nome}{m.papel === "gestor" ? " (gestão)" : ""}</option>)}
          </select>
        </label>
        <label>
          Perfil
          <select name="perfil" required defaultValue="">
            <option value="" disabled>Escolha</option>
            {painel.perfis.filter((p) => p.ativo).map((p) => <option key={p.id} value={p.id}>{p.nome} · {SETORES[p.setor]}</option>)}
          </select>
        </label>
        <label>
          Onde vale
          <select name="unidade" defaultValue="todas">
            <option value="todas">Todas as unidades</option>
            {painel.unidades.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
          </select>
        </label>
        <button type="submit">Dar perfil</button>
      </form>

      <h2>Perfis</h2>
      {painel.perfis.map((p) => (
        <details className="cartao" key={p.id}>
          <summary>
            <strong>{p.nome}</strong> · {SETORES[p.setor]} · {p.pessoas} {p.pessoas === 1 ? "pessoa" : "pessoas"}
            {!p.ativo && <span className="etiqueta">desativado</span>}
          </summary>
          <p className="suave">{p.permissoes.map((c) => descricao.get(c) ?? c).join(" · ") || "Sem permissões."}</p>
          <form className="campos" action={acaoAlterar}>
            <input type="hidden" name="perfil" value={p.id} />
            <label>Nome <input name="nome" defaultValue={p.nome} required minLength={2} maxLength={80} /></label>
            <label>
              Setor
              <select name="setor" defaultValue={p.setor}>
                {Object.entries(SETORES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label>
              Situação
              <select name="ativo" defaultValue={p.ativo ? "sim" : "nao"}>
                <option value="sim">Ativo</option>
                <option value="nao">Desativado (ninguém usa enquanto estiver assim)</option>
              </select>
            </label>
            {caixas(p.permissoes)}
            <button type="submit">Salvar perfil</button>
          </form>
        </details>
      ))}

      <form className="campos cartao" action={acaoCriar}>
        <h3>Novo perfil</h3>
        <label>Nome <input name="nome" required minLength={2} maxLength={80} placeholder="Ex.: Recepção da UBS Centro" /></label>
        <label>
          Setor
          <select name="setor" defaultValue="agendamento">
            {Object.entries(SETORES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <p className="suave">Se não marcar nada, o perfil começa com as permissões de costume do setor.</p>
        {painel.catalogo.map((c) => <input key={c.codigo} type="hidden" name="disponivel" value={c.codigo} />)}
        {caixas([])}
        <button type="submit">Criar perfil</button>
      </form>
    </>
  );
}
