import { NextResponse, type NextRequest } from "next/server";

/**
 * 1. Remove cabeçalhos internos que um cliente tente forjar (x-cf-*).
 * 2. Resolve o município pelo subdomínio e repassa em x-cf-municipio (só o slug; o id
 *    é buscado no banco e a sessão é conferida no servidor).
 * 3. Monta a CSP com nonce por requisição: nenhum script inline sem nonce executa.
 * 4. Proíbe cache de qualquer resposta dinâmica: páginas e APIs carregam dados pessoais e
 *    não podem ficar em proxy, CDN, cache do navegador nem no histórico de "voltar".
 */
const SLUG = /^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$/;

export function middleware(req: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const cabecalhos = new Headers(req.headers);
  for (const nome of [...cabecalhos.keys()]) {
    if (nome.toLowerCase().startsWith("x-cf-")) cabecalhos.delete(nome);
  }

  const base = (process.env.CF_DOMINIO_BASE ?? "localhost").toLowerCase();
  const host = (req.headers.get("host") ?? "").toLowerCase().replace(/:\d+$/, "");
  if (host.endsWith(`.${base}`)) {
    const slug = host.slice(0, -(base.length + 1));
    if (SLUG.test(slug)) cabecalhos.set("x-cf-municipio", slug);
  }

  const dev = process.env.NODE_ENV !== "production";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'${dev ? " 'unsafe-inline'" : ""}`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
  cabecalhos.set("x-cf-nonce", nonce);
  cabecalhos.set("content-security-policy", csp);

  const resposta = NextResponse.next({ request: { headers: cabecalhos } });
  resposta.headers.set("Content-Security-Policy", csp);
  resposta.headers.set("Cache-Control", "no-store, private, max-age=0");
  resposta.headers.set("Pragma", "no-cache");
  resposta.headers.set("Vary", "Cookie");
  return resposta;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico).*)" }],
};
