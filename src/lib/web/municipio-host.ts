/**
 * Slug do município a partir do Host. Usado pelo middleware e pelas páginas: o Host decide para
 * onde a requisição vai, então não serve para um cliente "trocar" de município sem trocar de endereço.
 */
const SLUG = /^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$/;

export function slugDoHost(
  hostCabecalho: string | null,
  base = process.env.CF_DOMINIO_BASE ?? "localhost",
  unico = process.env.CF_MUNICIPIO_UNICO,
): string | null {
  const host = (hostCabecalho ?? "").toLowerCase().replace(/:\d+$/, "");
  // Ambiente de um município só (teste no domínio gerado pelo Railway, que não aceita subdomínio):
  // o próprio domínio base abre o município configurado. Subdomínios continuam valendo.
  if (unico && host === base.toLowerCase()) return SLUG.test(unico) ? unico : null;
  const sufixo = `.${base.toLowerCase()}`;
  if (!host.endsWith(sufixo)) return null;
  const slug = host.slice(0, -sufixo.length);
  return SLUG.test(slug) ? slug : null;
}
