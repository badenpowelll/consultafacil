/**
 * Downloads sensíveis (exportações) só a partir das telas do próprio município. O cookie de
 * sessão é SameSite=Lax, então um link em outro site (ou no subdomínio de outro município, que é
 * "same-site") ainda leva o cookie numa navegação GET: sem esta checagem, qualquer página poderia
 * disparar exportações em nome de um gestor logado, gastando o limite dele e sujando a auditoria.
 *
 * `none` é endereço digitado ou favorito; navegador sem o cabeçalho (antigo) passa, e as outras
 * barreiras (permissão, MFA, limite, auditoria) continuam valendo.
 */
export function pedidoDeOutroSite(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  return site !== null && site !== "same-origin" && site !== "none";
}
