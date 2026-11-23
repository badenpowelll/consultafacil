import type { Metadata } from "next";
import type { ReactNode } from "react";

// A CSP usa nonce por requisição; páginas estáticas não recebem o nonce, então tudo é dinâmico.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Consulta Fácil",
  description: "Agendamento de atendimentos de saúde do município.",
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
