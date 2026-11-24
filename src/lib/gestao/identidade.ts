import { z } from "zod";
import { comPermissao } from "@/lib/auth/autorizar";
import { registrarAuditoria } from "@/lib/auditoria";
import { obterPool, type Conexao } from "@/lib/db/pool";
import { chaveDoObjeto, ImagemRecusada, TAMANHO_MAXIMO, validarELimparImagem } from "@/lib/arquivos/imagem";
import type { Requisicao } from "@/lib/agendamento/servico";
import { ErroGestao } from "@/lib/gestao/perfis";

/**
 * Identidade visual do município: logomarca e cor principal. A imagem passa pela limpeza de
 * src/lib/arquivos/imagem.ts (só PNG/JPEG, sem metadados nem blocos extras) antes de ir ao banco.
 * Exige `gestao.identidade_visual` com MFA.
 */
function comIdentidade<T>(req: Requisicao, trabalho: (tx: Conexao) => Promise<T>): Promise<T> {
  return comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao: "gestao.identidade_visual", exigeMfa: true }, trabalho);
}

export interface IdentidadeVisual {
  temLogo: boolean;
  versao: number;
  corPrimaria: string | null;
}

export async function identidadeAtual(req: Requisicao): Promise<IdentidadeVisual> {
  return comIdentidade(req, async (tx) => {
    const r = await tx.query<{ logo_chave: string | null; versao: number; cor_primaria: string | null }>(
      "SELECT logo_chave, versao, cor_primaria FROM app.identidade_visual",
    );
    const l = r.rows[0];
    return { temLogo: !!l?.logo_chave, versao: l?.versao ?? 0, corPrimaria: l?.cor_primaria ?? null };
  });
}

export async function enviarLogomarca(req: Requisicao, dados: Buffer): Promise<void> {
  if (dados.length === 0 || dados.length > TAMANHO_MAXIMO) throw new ErroGestao("imagem_invalida");
  let limpa;
  try {
    limpa = validarELimparImagem(dados);
  } catch (e) {
    if (e instanceof ImagemRecusada) throw new ErroGestao("imagem_invalida");
    throw e;
  }
  await comIdentidade(req, async (tx) => {
    const chave = chaveDoObjeto(req.tenantDaUrl, "marca", limpa.tipo);
    await tx.query(
      "INSERT INTO app.arquivo (tenant_id, chave, content_type, dados, criado_por) VALUES (app.tenant_atual(), $1, $2, $3, app.conta_atual())",
      [chave, limpa.contentType, limpa.dados],
    );
    await tx.query(
      `INSERT INTO app.identidade_visual (tenant_id, logo_chave) VALUES (app.tenant_atual(), $1)
       ON CONFLICT (tenant_id) DO UPDATE SET logo_chave = EXCLUDED.logo_chave,
         versao = app.identidade_visual.versao + 1, alterado_em = now()`,
      [chave],
    );
    await registrarAuditoria(tx, {
      acao: "identidade.logomarca", modulo: "gestao", objetoTipo: "arquivo", objetoId: chave,
      detalhes: { bytes: limpa.dados.length, tipo: limpa.tipo }, ip: req.ip,
    });
  });
}

export async function definirCorPrimaria(req: Requisicao, cor: unknown): Promise<void> {
  const r = z.string().regex(/^#[0-9a-fA-F]{6}$/).safeParse(cor);
  if (!r.success) throw new ErroGestao("dados_invalidos");
  await comIdentidade(req, async (tx) => {
    await tx.query(
      `INSERT INTO app.identidade_visual (tenant_id, cor_primaria) VALUES (app.tenant_atual(), $1)
       ON CONFLICT (tenant_id) DO UPDATE SET cor_primaria = EXCLUDED.cor_primaria,
         versao = app.identidade_visual.versao + 1, alterado_em = now()`,
      [r.data.toLowerCase()],
    );
    await registrarAuditoria(tx, { acao: "identidade.cor", modulo: "gestao", detalhes: { cor: r.data.toLowerCase() }, ip: req.ip });
  });
}

export interface Logomarca {
  contentType: "image/png" | "image/jpeg";
  dados: Buffer;
  versao: number;
}

/** Logomarca vigente do município, pública (aparece no site antes do login e no comprovante). */
export async function logomarcaPublica(tenantId: string): Promise<Logomarca | null> {
  if (!z.string().uuid().safeParse(tenantId).success) return null;
  const r = await obterPool().query<{ content_type: Logomarca["contentType"]; dados: Buffer; versao: number }>(
    "SELECT * FROM app.logomarca_publica($1)",
    [tenantId],
  );
  const l = r.rows[0];
  return l ? { contentType: l.content_type, dados: l.dados, versao: l.versao } : null;
}

/** Versão da logomarca vigente (para o endereço da imagem mudar quando ela for trocada), ou null. */
export async function versaoDaLogomarca(tenantId: string): Promise<number | null> {
  if (!z.string().uuid().safeParse(tenantId).success) return null;
  const r = await obterPool().query<{ v: number | null }>("SELECT app.logomarca_versao($1) AS v", [tenantId]);
  return r.rows[0]?.v ?? null;
}
