import { cookies, headers } from "next/headers";
import { obterPool } from "@/lib/db/pool";
import { slugDoHost } from "@/lib/web/municipio-host";
import { COOKIE_SESSAO, validarSessao, type SessaoValida } from "@/lib/auth/sessao";
import type { Requisicao } from "@/lib/agendamento/servico";

export interface Municipio {
  id: string;
  slug: string;
  nome: string;
}

/** Município do subdomínio. */
export async function municipioAtual(): Promise<Municipio | null> {
  // A renderização que segue uma Server Action chega por uma requisição interna do Next para
  // localhost, com o endereço original em X-Forwarded-Host. Trocar esse cabeçalho só equivale a
  // visitar o endereço de outro município: sessão, vínculo e permissões continuam conferidos.
  const h = await headers();
  const slug = slugDoHost(h.get("host")) ?? slugDoHost(h.get("x-forwarded-host"));
  if (!slug) return null;
  const r = await obterPool().query<Municipio>("SELECT id, slug, nome FROM app.tenant WHERE slug = $1 AND estado = 'ativo'", [slug]);
  return r.rows[0] ?? null;
}

export interface SituacaoMunicipio {
  nome: string;
  estado: "suspenso" | "encerrando" | "encerrado";
}

/**
 * Município do subdomínio que existe mas não está ativo (suspenso ou em encerramento): a página
 * mostra um aviso no lugar do conteúdo. Município ainda em provisionamento não aparece.
 */
export async function situacaoDoMunicipioInativo(): Promise<SituacaoMunicipio | null> {
  const h = await headers();
  const slug = slugDoHost(h.get("host")) ?? slugDoHost(h.get("x-forwarded-host"));
  if (!slug) return null;
  const r = await obterPool().query<SituacaoMunicipio>("SELECT nome, estado FROM app.municipio_situacao($1)", [slug]);
  return r.rows[0] ?? null;
}

/**
 * IP do cliente. No Railway a borda acrescenta o IP real ao fim de X-Forwarded-For; os valores
 * à esquerda vêm do cliente e podem ser forjados, então usamos o último.
 */
export async function ipDaRequisicao(): Promise<string> {
  const h = await headers();
  const lista = (h.get("x-forwarded-for") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  return lista[lista.length - 1] ?? "desconhecido";
}

export async function tokenDaSessao(): Promise<string | undefined> {
  return (await cookies()).get(COOKIE_SESSAO)?.value;
}

export async function sessaoAtual(): Promise<SessaoValida | null> {
  return validarSessao(await tokenDaSessao());
}

export async function requisicaoAtual(): Promise<{ req: Requisicao; municipio: Municipio } | null> {
  const municipio = await municipioAtual();
  if (!municipio) return null;
  return { req: { sessao: await sessaoAtual(), tenantDaUrl: municipio.id, ip: await ipDaRequisicao() }, municipio };
}
