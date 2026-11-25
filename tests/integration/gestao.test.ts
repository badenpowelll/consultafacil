import { deflateSync, crc32 } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encerrarPool } from "@/lib/db/pool";
import { comPermissao, AcessoNegado } from "@/lib/auth/autorizar";
import { criarSessao, definirMunicipio, validarSessao } from "@/lib/auth/sessao";
import type { Requisicao } from "@/lib/agendamento/servico";
import { alterarPerfil, atribuirPerfil, criarPerfil, painelDePerfis, removerAtribuicao } from "@/lib/gestao/perfis";
import { consultarAuditoria, exportarAuditoria } from "@/lib/gestao/auditoria";
import { definirCorPrimaria, enviarLogomarca, logomarcaPublica } from "@/lib/gestao/identidade";
import { gerarPdfComprovante, codigoDoComprovante } from "@/lib/agendamento/comprovante";
import { admin, criarMunicipio, criarPessoaEConta, criarUnidade, vincular } from "./ambiente";

/** Gestão do município: perfis por setor, auditoria e logomarca. Dados fictícios. */
async function requisicao(contaId: string, tenantId: string, mfa = true): Promise<Requisicao> {
  const token = await criarSessao(contaId, mfa);
  await definirMunicipio(token, tenantId);
  return { sessao: await validarSessao(token), tenantDaUrl: tenantId, ip: "203.0.113.20" };
}

async function pode(req: Requisicao, permissao: string, unidadeId: string | null = null): Promise<boolean> {
  try {
    await comPermissao({ sessao: req.sessao, tenantDaUrl: req.tenantDaUrl, permissao, unidadeId }, async () => undefined);
    return true;
  } catch (e) {
    if (e instanceof AcessoNegado) return false;
    throw e;
  }
}

/** PNG real 2x2, decodificável (o comprovante precisa embutir). */
function pngReal(): Buffer {
  const chunk = (tipo: string, dados: Buffer) => {
    const t = Buffer.alloc(4);
    t.writeUInt32BE(dados.length);
    const corpo = Buffer.concat([Buffer.from(tipo, "latin1"), dados]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc32(corpo) >>> 0);
    return Buffer.concat([t, corpo, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8 bits, RGB
  const linhas = Buffer.from([0, 20, 120, 60, 20, 120, 60, 0, 20, 120, 60, 20, 120, 60]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("tEXt", Buffer.from("Author\0Pessoa Ficticia")),
    chunk("IDAT", deflateSync(linhas)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let A: string;
let B: string;
let unidade1: string;
let unidade2: string;
let gestor: Requisicao;
let gestorSemMfa: Requisicao;
let gestorB: Requisicao;
let recepcionista: { req: Requisicao; vinculo: string };
let subgestor: { req: Requisicao; vinculo: string };
let cidadaoVinculo: string;

beforeAll(async () => {
  A = await criarMunicipio("Município Fictício Gestão A");
  B = await criarMunicipio("Município Fictício Gestão B");
  unidade1 = await criarUnidade(A, "UBS Fictícia Norte");
  unidade2 = await criarUnidade(A, "UBS Fictícia Sul");
  const g = await criarPessoaEConta();
  await vincular(A, g.contaId, "gestor");
  gestor = await requisicao(g.contaId, A);
  gestorSemMfa = await requisicao(g.contaId, A, false);
  const gB = await criarPessoaEConta();
  await vincular(B, gB.contaId, "gestor");
  gestorB = await requisicao(gB.contaId, B);
  const r = await criarPessoaEConta();
  recepcionista = { vinculo: await vincular(A, r.contaId, "equipe"), req: await requisicao(r.contaId, A) };
  const s = await criarPessoaEConta();
  subgestor = { vinculo: await vincular(A, s.contaId, "equipe"), req: await requisicao(s.contaId, A) };
  cidadaoVinculo = await vincular(A, (await criarPessoaEConta()).contaId, "cidadao");
});

afterAll(async () => {
  await encerrarPool();
  await admin.end();
});

describe("perfis por setor", () => {
  let perfilRecepcao: string;

  it("o gestor cria o perfil da recepção e atribui só na UBS Norte", async () => {
    perfilRecepcao = await criarPerfil(gestor, {
      nome: "Recepção", setor: "recepcao", permissoes: ["agenda.ver", "recepcao.checkin", "agenda.marcar"],
    });
    expect(await pode(recepcionista.req, "recepcao.checkin", unidade1)).toBe(false);
    await atribuirPerfil(gestor, { vinculoId: recepcionista.vinculo, perfilId: perfilRecepcao, unidadeId: unidade1 });
    expect(await pode(recepcionista.req, "recepcao.checkin", unidade1)).toBe(true);
    expect(await pode(recepcionista.req, "recepcao.checkin", unidade2)).toBe(false);
    expect(await pode(recepcionista.req, "recepcao.checkin", null)).toBe(false);
    expect(await pode(recepcionista.req, "gestao.perfis", null)).toBe(false);
  });

  it("o painel mostra perfis, membros, unidades e atribuições do município", async () => {
    const p = await painelDePerfis(gestor);
    expect(p.perfis.find((x) => x.id === perfilRecepcao)).toMatchObject({ setor: "recepcao", pessoas: 1 });
    expect(p.unidades.map((u) => u.nome)).toEqual(expect.arrayContaining(["UBS Fictícia Norte", "UBS Fictícia Sul"]));
    expect(p.membros.some((m) => m.vinculo_id === recepcionista.vinculo)).toBe(true);
    expect(p.membros.some((m) => m.vinculo_id === cidadaoVinculo)).toBe(false);
    expect(p.catalogo.some((c) => c.codigo.startsWith("clinico."))).toBe(false);
  });

  it("desativar o perfil corta o acesso na hora; reativar devolve", async () => {
    await alterarPerfil(gestor, perfilRecepcao, { nome: "Recepção", setor: "recepcao", ativo: false, permissoes: ["agenda.ver", "recepcao.checkin"] });
    expect(await pode(recepcionista.req, "recepcao.checkin", unidade1)).toBe(false);
    await alterarPerfil(gestor, perfilRecepcao, { nome: "Recepção", setor: "recepcao", ativo: true, permissoes: ["agenda.ver", "recepcao.checkin"] });
    expect(await pode(recepcionista.req, "recepcao.checkin", unidade1)).toBe(true);
    expect(await pode(recepcionista.req, "agenda.marcar", unidade1)).toBe(false); // retirada na alteração
  });

  it("quem gerencia perfis sem ser gestor não concede o que não tem (sem escalada)", async () => {
    const delegado = await criarPerfil(gestor, { nome: "Gestão de perfis", setor: "outros", permissoes: ["gestao.perfis", "agenda.ver"] });
    await atribuirPerfil(gestor, { vinculoId: subgestor.vinculo, perfilId: delegado, unidadeId: null });
    await expect(criarPerfil(subgestor.req, { nome: "Tudo", setor: "outros", permissoes: ["auditoria.ver"] }))
      .rejects.toMatchObject({ codigo: "acima_do_proprio_acesso" });
    const auditoria = await criarPerfil(gestor, { nome: "Auditoria", setor: "outros", permissoes: ["auditoria.ver"] });
    await expect(atribuirPerfil(subgestor.req, { vinculoId: subgestor.vinculo, perfilId: auditoria, unidadeId: null }))
      .rejects.toMatchObject({ codigo: "acima_do_proprio_acesso" });
    // Dentro do próprio acesso, pode.
    const leitura = await criarPerfil(subgestor.req, { nome: "Só leitura da agenda", setor: "auxiliares", permissoes: ["agenda.ver"] });
    await atribuirPerfil(subgestor.req, { vinculoId: recepcionista.vinculo, perfilId: leitura, unidadeId: unidade2 });
    expect(await pode(recepcionista.req, "agenda.ver", unidade2)).toBe(true);
  });

  it("recusa permissão clínica, perfil para cidadão, sem MFA, sem permissão e de outro município", async () => {
    await expect(criarPerfil(gestor, { nome: "Clínico", setor: "medicos", permissoes: ["clinico.observacao.ver"] }))
      .rejects.toMatchObject({ codigo: "permissao_clinica" });
    await expect(atribuirPerfil(gestor, { vinculoId: cidadaoVinculo, perfilId: perfilRecepcao, unidadeId: null }))
      .rejects.toMatchObject({ codigo: "perfil_so_para_equipe" });
    await expect(criarPerfil(gestorSemMfa, { nome: "Sem MFA", setor: "outros", permissoes: [] })).rejects.toMatchObject({ motivo: "sem_mfa" });
    await expect(painelDePerfis(recepcionista.req)).rejects.toMatchObject({ motivo: "sem_permissao" });
    // Vínculo e perfil de outro município não existem para quem está em B.
    await expect(atribuirPerfil(gestorB, { vinculoId: recepcionista.vinculo, perfilId: perfilRecepcao, unidadeId: null }))
      .rejects.toMatchObject({ name: "ErroGestao" });
    expect((await painelDePerfis(gestorB)).perfis).toHaveLength(0);
  });

  it("nome repetido e atribuição repetida dão mensagem clara", async () => {
    await expect(criarPerfil(gestor, { nome: "Recepção", setor: "recepcao", permissoes: [] })).rejects.toMatchObject({ codigo: "nome_repetido" });
    await expect(atribuirPerfil(gestor, { vinculoId: recepcionista.vinculo, perfilId: perfilRecepcao, unidadeId: unidade1 }))
      .rejects.toMatchObject({ codigo: "ja_atribuido" });
  });

  it("remover a atribuição tira o acesso", async () => {
    const p = await painelDePerfis(gestor);
    const at = p.atribuicoes.find((a) => a.vinculo_id === recepcionista.vinculo && a.perfil_id === perfilRecepcao)!;
    await removerAtribuicao(gestor, at.id);
    expect(await pode(recepcionista.req, "recepcao.checkin", unidade1)).toBe(false);
  });
});

describe("menu de auditoria", () => {
  it("mostra quem fez o quê, filtra por módulo e não vaza para outro município", async () => {
    const pag = await consultarAuditoria(gestor, { modulo: "gestao" });
    expect(pag.linhas.length).toBeGreaterThan(5);
    expect(pag.linhas.every((l) => l.modulo === "gestao")).toBe(true);
    expect(pag.linhas.some((l) => l.acao === "perfil.atribuir" && l.quem)).toBe(true);
    expect(pag.modulos).toContain("gestao");
    const outro = await consultarAuditoria(gestorB, {});
    expect(outro.linhas.some((l) => l.acao.startsWith("perfil."))).toBe(false);
  });

  it("exige auditoria.ver com MFA e valida filtros", async () => {
    await expect(consultarAuditoria(recepcionista.req, {})).rejects.toMatchObject({ motivo: "sem_permissao" });
    await expect(consultarAuditoria(gestorSemMfa, {})).rejects.toMatchObject({ motivo: "sem_mfa" });
    await expect(consultarAuditoria(gestor, { modulo: "x'; DROP TABLE app.auditoria; --" })).rejects.toMatchObject({ codigo: "dados_invalidos" });
  });

  it("a exportação sai com nomes mascarados e fica registrada", async () => {
    const arq = await exportarAuditoria(gestor, { modulo: "gestao" });
    expect(arq.linhas).toBeGreaterThan(0);
    expect(arq.conteudo).toContain("perfil.criar");
    expect(arq.conteudo).not.toMatch(/Pessoa Fictícia [0-9a-f]{8}/);
    const reg = await admin.query("SELECT 1 FROM app.auditoria WHERE tenant_id = $1 AND acao = 'exportacao.gerar' AND objeto_tipo = 'auditoria'", [A]);
    expect(reg.rowCount).toBe(1);
  });
});

describe("logomarca do município", () => {
  it("o gestor envia a logomarca: metadados somem, a versão sobe e o comprovante usa", async () => {
    expect(await logomarcaPublica(A)).toBeNull();
    await enviarLogomarca(gestor, pngReal());
    const logo = await logomarcaPublica(A);
    expect(logo?.contentType).toBe("image/png");
    expect(logo!.dados.toString("latin1")).not.toContain("Pessoa Ficticia");
    expect(logo!.versao).toBeGreaterThanOrEqual(1);
    await definirCorPrimaria(gestor, "#1A5FB4");
    expect((await logomarcaPublica(A))!.versao).toBe(logo!.versao + 1);
    expect(await logomarcaPublica(B)).toBeNull();

    const pdf = await gerarPdfComprovante({
      municipio: "Município Fictício Gestão A", corPrimaria: "#1a5fb4", situacao: "Agendado", inicio: new Date(), fuso: "America/Fortaleza",
      unidade: "UBS Fictícia Norte", profissional: "Dra. Fictícia", especialidade: "Clínica geral", paciente: "Pessoa Fictícia",
      codigo: codigoDoComprovante("00000000-0000-4000-8000-000000000001"), endereco: "https://exemplo.test/validar/x", emitidoEm: new Date(),
      logo: { contentType: logo!.contentType, dados: logo!.dados },
    });
    expect(Buffer.from(pdf).toString("latin1")).toContain("/Subtype /Image");
  });

  it("recusa arquivo que não é imagem e exige a permissão com MFA", async () => {
    await expect(enviarLogomarca(gestor, Buffer.from("<svg onload=alert(1)>"))).rejects.toMatchObject({ codigo: "imagem_invalida" });
    await expect(enviarLogomarca(recepcionista.req, pngReal())).rejects.toMatchObject({ motivo: "sem_permissao" });
    await expect(enviarLogomarca(gestorSemMfa, pngReal())).rejects.toMatchObject({ motivo: "sem_mfa" });
    await expect(definirCorPrimaria(gestor, "red; background:url(x)")).rejects.toMatchObject({ codigo: "dados_invalidos" });
  });

  it("arquivos são somente inserção e isolados por município", async () => {
    await expect(admin.query("DELETE FROM app.arquivo WHERE tenant_id = $1", [A])).rejects.toThrow();
    const visto = await comPermissao({ sessao: gestorB.sessao, tenantDaUrl: B, permissao: "agenda.ver" }, (tx) =>
      tx.query("SELECT 1 FROM app.arquivo WHERE tenant_id = $1", [A]),
    );
    expect(visto.rowCount).toBe(0);
  });
});

describe("donos dos objetos do esquema", () => {
  it("nenhuma tabela ou função SECURITY DEFINER do esquema app pertence a superusuário", async () => {
    const f = await admin.query<{ nome: string }>(
      `SELECT p.proname AS nome FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.pronamespace = 'app'::regnamespace AND (r.rolsuper OR r.rolbypassrls)`,
    );
    expect(f.rows).toEqual([]);
    const t = await admin.query<{ nome: string }>(
      `SELECT c.relname AS nome FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
       WHERE c.relnamespace = 'app'::regnamespace AND c.relkind IN ('r', 'p') AND (r.rolsuper OR r.rolbypassrls)`,
    );
    expect(t.rows).toEqual([]);
  });
});
