import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { municipioAtual, sessaoAtual, situacaoDoMunicipioInativo, type SituacaoMunicipio } from "@/lib/web/requisicao";
import { comMunicipio } from "@/lib/db/contexto";
import { versaoDaLogomarca } from "@/lib/gestao/identidade";

// A CSP usa nonce por requisição; páginas estáticas não recebem o nonce, então tudo é dinâmico.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Consulta Fácil",
  description: "Agendamento de atendimentos de saúde do município.",
  robots: { index: false, follow: false },
};

export default async function Layout({ children }: { children: ReactNode }) {
  const municipio = await municipioAtual();
  const inativo = municipio ? null : await situacaoDoMunicipioInativo();
  const sessao = municipio ? await sessaoAtual() : null;
  const versaoLogo = municipio ? await versaoDaLogomarca(municipio.id) : null;
  // Só mostra o menu da equipe para quem tem vínculo de equipe ou gestão neste município.
  const daEquipe =
    sessao?.tenantId === municipio?.id && municipio && sessao
      ? await comMunicipio({ tenantId: municipio.id, contaId: sessao.contaId }, async (tx) =>
          (await tx.query("SELECT 1 FROM app.vinculo WHERE conta_id = app.conta_atual() AND papel IN ('gestor', 'equipe') AND estado = 'ativo'")).rowCount! > 0,
        )
      : false;
  return (
    <html lang="pt-BR">
      <body>
        <a className="pular" href="#conteudo">Pular para o conteúdo</a>
        <header className="topo">
          <div className="faixa">
            <strong>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {versaoLogo !== null && <img className="logo-topo" src={`/marca?v=${versaoLogo}`} alt="" />}
              Consulta Fácil{municipio ? ` · ${municipio.nome}` : inativo ? ` · ${inativo.nome}` : ""}
            </strong>
            {municipio && (
              <nav aria-label="Principal">
                {sessao ? (
                  <>
                    <a href="/minhas-consultas">Minhas consultas</a>
                    <a href="/marcar">Marcar consulta</a>
                    <a href="/lista-de-espera">Lista de espera</a>
                    <a href="/minha-familia">Minha família</a>
                    {daEquipe && <a href="/equipe">Equipe</a>}
                    <form action="/sair" method="post">
                      <button className="secundario" type="submit">Sair</button>
                    </form>
                  </>
                ) : (
                  <>
                    <a href="/entrar">Entrar</a>
                    <a href="/cadastro">Criar cadastro</a>
                  </>
                )}
              </nav>
            )}
          </div>
        </header>
        <main id="conteudo">{inativo ? <AvisoInativo situacao={inativo} /> : children}</main>
      </body>
    </html>
  );
}

/** Município suspenso ou em encerramento: nada do sistema funciona por este endereço. */
function AvisoInativo({ situacao }: { situacao: SituacaoMunicipio }) {
  return (
    <>
      <h1>Agendamento on-line indisponível</h1>
      <p className="aviso" role="status">
        {situacao.estado === "suspenso"
          ? `O agendamento on-line de ${situacao.nome} está temporariamente suspenso.`
          : `O agendamento on-line de ${situacao.nome} foi encerrado neste endereço.`}
      </p>
      <p>Suas consultas já marcadas continuam registradas. Para marcar, desmarcar ou tirar dúvidas, procure a recepção da sua unidade de saúde.</p>
    </>
  );
}
