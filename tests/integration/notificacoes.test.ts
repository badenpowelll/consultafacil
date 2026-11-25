import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encerrarPool } from "@/lib/db/pool";
import { criarSessao, definirMunicipio, validarSessao } from "@/lib/auth/sessao";
import { cadastrarProfissional, criarEscala, marcarParaMim, registrarAusencia, vagasParaCidadao, type Requisicao } from "@/lib/agendamento/servico";
import { processarLote } from "@/lib/notificacoes/worker";
import { TransporteMemoria } from "@/lib/notificacoes/transporte";
import { escaparHtml } from "@/lib/notificacoes/modelos";
import { cifrar } from "@/lib/security/crypto";
import { admin, criarMunicipio, criarPessoaEConta, criarUnidade, vincular } from "./ambiente";

async function requisicao(contaId: string, tenantId: string): Promise<Requisicao> {
  const token = await criarSessao(contaId, true);
  await definirMunicipio(token, tenantId);
  return { sessao: await validarSessao(token), tenantDaUrl: tenantId };
}

function dataLocal(dias: number): string {
  return new Date(Date.now() - 3 * 3_600_000 + dias * 86_400_000).toISOString().slice(0, 10);
}

let municipio: string;
let gestor: Requisicao;
let unidade: string;
let profissional: string;

beforeAll(async () => {
  await admin.query("UPDATE app.notificacao SET estado = 'sem_contato' WHERE estado = 'pendente'");
  municipio = await criarMunicipio("Município Fictício Avisos");
  unidade = await criarUnidade(municipio, "UBS Fictícia <Avisos>");
  const g = await criarPessoaEConta();
  await vincular(municipio, g.contaId, "gestor");
  gestor = await requisicao(g.contaId, municipio);
  const medico = await criarPessoaEConta();
  profissional = await cadastrarProfissional(gestor, {
    vinculoId: await vincular(municipio, medico.contaId, "equipe"), nomeExibicao: "Dra. Fictícia Lima", especialidade: "Ginecologia",
  });
  const dia = dataLocal(6);
  await criarEscala(gestor, {
    profissionalId: profissional, unidadeId: unidade, diaSemana: new Date(`${dia}T12:00:00Z`).getUTCDay(),
    horaInicio: "13:00", horaFim: "14:00", duracaoMin: 30, vigenciaInicio: dia, vigenciaFim: dia, gerarAte: dia,
  });
  // A fila é global (o worker atende todos os municípios). Avisos pendentes deixados por outros
  // arquivos de teste ocupariam o lote de 20 e tirariam os deste arquivo, conforme a ordem de execução.
  await admin.query("UPDATE app.notificacao SET estado = 'enviada' WHERE estado = 'pendente' AND tenant_id <> $1", [municipio]);
});

afterAll(async () => {
  await encerrarPool();
  await admin.end();
});

describe("avisos por e-mail", () => {
  it("avisa quando a consulta é marcada e quando o médico não pode atender, sem dado sensível", async () => {
    const { pessoaId, contaId } = await criarPessoaEConta();
    await admin.query("UPDATE app.pessoa SET email_cifrado = $2 WHERE id = $1", [pessoaId, cifrar("paciente.ficticio@exemplo.test", "pessoa.email")]);
    await vincular(municipio, contaId, "cidadao");
    const cidadao = await requisicao(contaId, municipio);
    const dia = dataLocal(6);
    const [vaga] = await vagasParaCidadao(cidadao, { de: `${dia}T00:00:00-03:00`, ate: `${dia}T23:59:59-03:00` });
    await marcarParaMim(cidadao, vaga!.id);
    await registrarAusencia(gestor, {
      profissionalId: profissional, unidadeId: unidade, inicio: `${dia}T00:00:00-03:00`, fim: `${dia}T23:59:59-03:00`, motivo: "Licença",
    });

    const transporte = new TransporteMemoria();
    const r = await processarLote(transporte);
    expect(r.enviadas).toBe(2);
    expect(transporte.enviados.map((e) => e.destino)).toEqual(["paciente.ficticio@exemplo.test", "paciente.ficticio@exemplo.test"]);
    // O lote não tem ordem garantida entre avisos do mesmo instante.
    const mensagens = transporte.enviados.map((e) => e.mensagem);
    const marcada = mensagens.find((m) => m.assunto.startsWith("Consulta marcada"));
    const ausente = mensagens.find((m) => m.assunto.startsWith("Aviso:"));
    expect(marcada!.assunto).toContain("Consulta marcada");
    expect(ausente!.assunto).toContain("não poderá atender");
    expect(ausente!.texto).toContain("Dra. Fictícia Lima");
    expect(ausente!.texto).toContain("13:00");
    // Nome da unidade com caracteres especiais é escapado no HTML.
    expect(ausente!.html).toContain("UBS Fictícia &lt;Avisos&gt;");
    expect(ausente!.html).not.toContain("<Avisos>");

    // Nada é reenviado.
    expect((await processarLote(transporte)).enviadas).toBe(0);
  });

  it("quem não tem e-mail fica registrado como sem contato, para a unidade avisar de outro jeito", async () => {
    const { contaId } = await criarPessoaEConta();
    await vincular(municipio, contaId, "cidadao");
    const cidadao = await requisicao(contaId, municipio);
    const dia = dataLocal(6);
    await admin.query("UPDATE app.vaga SET estado = 'livre' WHERE unidade_id = $1 AND estado = 'bloqueada'", [unidade]);
    const [vaga] = await vagasParaCidadao(cidadao, { de: `${dia}T00:00:00-03:00`, ate: `${dia}T23:59:59-03:00` });
    await marcarParaMim(cidadao, vaga!.id);
    const r = await processarLote(new TransporteMemoria());
    expect(r.semContato).toBe(1);
  });

  it("escapa HTML", () => {
    expect(escaparHtml(`<script>"x"&'y'</script>`)).toBe("&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;");
  });
});
