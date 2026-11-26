import { cookies } from "next/headers";
import { entrar } from "@/lib/auth/login";
import { COOKIE_SESSAO, definirMunicipio, opcoesCookieSessao } from "@/lib/auth/sessao";
import { conferirFormulario } from "@/lib/security/formulario";
import { logInfo } from "@/lib/log";
import { ipDaRequisicao, municipioAtual } from "@/lib/web/requisicao";

/**
 * Login por POST de formulário comum (funciona sem JavaScript). Um Route Handler, e não uma
 * Server Action, para o cookie da sessão já valer na página para onde redirecionamos.
 */
function para(destino: string): Response {
  return new Response(null, { status: 303, headers: { Location: destino } });
}

export async function POST(req: Request) {
  // Só formulários da própria origem (proteção contra CSRF de login).
  const origem = req.headers.get("origin");
  if (!origem || new URL(origem).host !== req.headers.get("host")) return new Response(null, { status: 403 });
  const municipio = await municipioAtual();
  if (!municipio) return para("/");

  const f = await req.formData();
  // Robôs: selo ausente/forjado/vencido ou campo-isca preenchido. Mesma resposta de credencial errada.
  const robo = conferirFormulario(f, 0);
  if (robo) {
    logInfo({ evento: "seguranca.formulario_recusado", rota: "entrar", motivo: robo });
    return para("/entrar?erro=credenciais");
  }
  const resultado = await entrar({
    cpf: String(f.get("cpf") ?? "").slice(0, 20),
    senha: String(f.get("senha") ?? "").slice(0, 200),
    codigoMfa: String(f.get("codigo") ?? "").trim().slice(0, 6) || undefined,
    ip: await ipDaRequisicao(),
  });
  if (!resultado.ok) return para(`/entrar?erro=${resultado.motivo}`);

  (await cookies()).set(COOKIE_SESSAO, resultado.token, opcoesCookieSessao());
  const atuando = await definirMunicipio(resultado.token, municipio.id);
  return para(atuando ? "/minhas-consultas" : "/entrar?erro=sem_vinculo");
}
