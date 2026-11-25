import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { municipioAtual, sessaoAtual } from "@/lib/web/requisicao";
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
              Consulta Fácil{municipio ? ` · ${municipio.nome}` : ""}
            </strong>
            {municipio && (
              <nav aria-label="Principal">
                {sessao ? (
                  <>
                    <a href="/minhas-consultas">Minhas consultas</a>
                    <a href="/marcar">Marcar consulta</a>
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
        <main id="conteudo">{children}</main>
      </body>
    </html>
  );
}
