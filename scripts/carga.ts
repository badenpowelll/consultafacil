/**
 * Teste de carga do cenário de 10 municípios (incremento 7). Só com dados fictícios e nunca em
 * produção: cria municípios "carga-…" no banco apontado e os deixa lá para inspeção.
 *
 *   DATABASE_URL_ADMIN=… DATABASE_URL=… npm run carga
 *   (opcional) CF_CARGA_MUNICIPIOS=10 CF_CARGA_CIDADAOS=100 CF_CARGA_CONCORRENCIA=40
 *
 * Mede a camada de regras + banco (as mesmas funções que as telas chamam, com o papel cf_app e o
 * pool de 10 conexões do app): abertura de agenda, busca de vagas, marcação disputada e painel do
 * gestor. Ao fim confere as invariantes: nenhuma vaga com duas consultas ativas, ninguém em dois
 * lugares ao mesmo tempo, ninguém acima do limite de consultas futuras.
 */
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { encerrarPool } from "@/lib/db/pool";
import { criarSessao, definirMunicipio, validarSessao } from "@/lib/auth/sessao";
import { cadastrarProfissional, criarEscala, marcarParaMim, vagasParaCidadao, type Requisicao } from "@/lib/agendamento/servico";
import { ErroAgendamento } from "@/lib/agendamento/erros";
import { painelDoMunicipio } from "@/lib/gestao/indicadores";

const MUNICIPIOS = Number(process.env.CF_CARGA_MUNICIPIOS ?? 10);
const CIDADAOS = Number(process.env.CF_CARGA_CIDADAOS ?? 100);
const CONCORRENCIA = Number(process.env.CF_CARGA_CONCORRENCIA ?? 40);
const DIAS = 5;

function parar(m: string): never {
  console.error(m);
  process.exit(1);
}

function dataLocal(dias: number): string {
  return new Date(Date.now() - 3 * 3_600_000 + dias * 86_400_000).toISOString().slice(0, 10);
}

const tempos: Record<string, number[]> = {};
async function medir<T>(nome: string, f: () => Promise<T>): Promise<T> {
  const t = performance.now();
  try {
    return await f();
  } finally {
    (tempos[nome] ??= []).push(performance.now() - t);
  }
}

function percentil(v: number[], p: number): number {
  const o = [...v].sort((a, b) => a - b);
  return o[Math.min(o.length - 1, Math.floor((p / 100) * o.length))] ?? 0;
}

/** Executa as tarefas com no máximo `n` em paralelo. */
async function emParalelo<T>(tarefas: (() => Promise<T>)[], n: number): Promise<T[]> {
  const saida: T[] = new Array(tarefas.length);
  let proxima = 0;
  await Promise.all(Array.from({ length: Math.min(n, tarefas.length) }, async () => {
    while (proxima < tarefas.length) {
      const i = proxima++;
      saida[i] = await tarefas[i]!();
    }
  }));
  return saida;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production" || process.env.CF_AMBIENTE === "producao") parar("Teste de carga não roda em produção");
  const url = process.env.DATABASE_URL_ADMIN;
  if (!url || !process.env.DATABASE_URL) parar("Defina DATABASE_URL_ADMIN e DATABASE_URL");
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const rodada = randomBytes(3).toString("hex");

  const pessoa = async (papel: string): Promise<string> => {
    const p = await admin.query<{ id: string }>(
      "INSERT INTO app.pessoa (nome, cpf_cifrado, cpf_indice) VALUES ($1, $2, $3) RETURNING id",
      [`Pessoa Fictícia Carga ${papel}`, randomBytes(40), randomBytes(32)],
    );
    const c = await admin.query<{ id: string }>("INSERT INTO app.conta (pessoa_id, senha_hash) VALUES ($1, 'x') RETURNING id", [p.rows[0]!.id]);
    return c.rows[0]!.id;
  };
  const vincular = async (tenantId: string, contaId: string, papel: string) =>
    (await admin.query<{ id: string }>("INSERT INTO app.vinculo (tenant_id, conta_id, papel, estado) VALUES ($1, $2, $3, 'ativo') RETURNING id", [tenantId, contaId, papel])).rows[0]!.id;
  const requisicao = async (contaId: string, tenantId: string, mfa: boolean): Promise<Requisicao> => {
    const token = await criarSessao(contaId, mfa);
    await definirMunicipio(token, tenantId);
    return { sessao: await validarSessao(token), tenantDaUrl: tenantId, ip: "203.0.113.90" };
  };

  console.warn(`Preparando ${MUNICIPIOS} municípios fictícios (rodada ${rodada})…`);
  const municipios: { id: string; gestor: Requisicao; cidadaos: Requisicao[] }[] = [];
  for (let m = 0; m < MUNICIPIOS; m++) {
    const t = await admin.query<{ id: string }>("INSERT INTO app.tenant (slug, nome, estado) VALUES ($1, $2, 'ativo') RETURNING id", [`carga-${rodada}-${m}`, `Município Fictício Carga ${m}`]);
    const tenantId = t.rows[0]!.id;
    const gestor = await requisicao(await (async () => { const c = await pessoa("gestor"); await vincular(tenantId, c, "gestor"); return c; })(), tenantId, true);
    for (let u = 0; u < 2; u++) {
      const unidadeId = (await admin.query<{ id: string }>("INSERT INTO app.unidade (tenant_id, nome) VALUES ($1, $2) RETURNING id", [tenantId, `UBS Fictícia ${u}`])).rows[0]!.id;
      for (let p = 0; p < 2; p++) {
        const medico = await pessoa("medico");
        const profissionalId = await cadastrarProfissional(gestor, { vinculoId: await vincular(tenantId, medico, "equipe"), nomeExibicao: `Dra. Fictícia ${u}${p}`, especialidade: "Clínica geral" });
        for (let d = 1; d <= DIAS; d++) {
          const dia = dataLocal(d);
          await medir("abrir agenda (1 dia, 20 vagas)", () => criarEscala(gestor, {
            profissionalId, unidadeId, diaSemana: new Date(`${dia}T12:00:00Z`).getUTCDay(),
            horaInicio: "07:00", horaFim: "17:00", duracaoMin: 30, vigenciaInicio: dia, vigenciaFim: dia, gerarAte: dia,
          }));
        }
      }
    }
    const cidadaos: Requisicao[] = [];
    for (let c = 0; c < CIDADAOS; c++) {
      const conta = await pessoa("cidadao");
      await vincular(tenantId, conta, "cidadao");
      cidadaos.push(await requisicao(conta, tenantId, false));
    }
    municipios.push({ id: tenantId, gestor, cidadaos });
  }

  // Todos disputam o mesmo dia e as primeiras vagas: o pior caso de concorrência.
  const dia = dataLocal(1);
  let marcadas = 0;
  let disputasPerdidas = 0;
  const erros: Record<string, number> = {};
  const tarefas: (() => Promise<void>)[] = [];
  for (const m of municipios) {
    for (const cid of m.cidadaos) {
      tarefas.push(async () => {
        for (let tentativa = 0; tentativa < 4; tentativa++) {
          const vagas = await medir("buscar vagas", () => vagasParaCidadao(cid, { de: `${dia}T00:00:00-03:00`, ate: `${dia}T23:59:59-03:00` }));
          if (vagas.length === 0) return;
          const escolha = vagas[Math.floor(Math.random() * Math.min(5, vagas.length))]!;
          try {
            await medir("marcar consulta", () => marcarParaMim(cid, escolha.id));
            marcadas++;
            return;
          } catch (e) {
            if (e instanceof ErroAgendamento && e.codigo === "vaga_indisponivel") { disputasPerdidas++; continue; }
            const codigo = e instanceof ErroAgendamento ? e.codigo : (e as Error).name;
            erros[codigo] = (erros[codigo] ?? 0) + 1;
            return;
          }
        }
      });
    }
    for (let i = 0; i < 5; i++) tarefas.push(async () => { await medir("painel do gestor", () => painelDoMunicipio(m.gestor, { de: dataLocal(-30), ate: dataLocal(DIAS) })); });
  }
  tarefas.sort(() => Math.random() - 0.5);

  console.warn(`Disparando ${tarefas.length} jornadas com ${CONCORRENCIA} simultâneas…`);
  const inicio = performance.now();
  await emParalelo(tarefas, CONCORRENCIA);
  const segundos = (performance.now() - inicio) / 1000;

  const ids = municipios.map((m) => m.id);
  const inv = await admin.query<{ duplas: number; sobrepostas: number; acima: number; ativas: number }>(
    `SELECT
       (SELECT count(*)::int FROM (SELECT vaga_id FROM app.agendamento WHERE tenant_id = ANY($1) AND estado IN ('marcada','confirmada')
          GROUP BY vaga_id HAVING count(*) > 1) x) AS duplas,
       (SELECT count(*)::int FROM app.ocupacao_pessoa a JOIN app.ocupacao_pessoa b
          ON a.pessoa_id = b.pessoa_id AND a.id < b.id AND a.periodo && b.periodo WHERE a.tenant_id = ANY($1)) AS sobrepostas,
       (SELECT count(*)::int FROM (SELECT pessoa_id FROM app.agendamento WHERE tenant_id = ANY($1) AND estado IN ('marcada','confirmada')
          GROUP BY pessoa_id HAVING count(*) > app.limite_consultas_futuras()) y) AS acima,
       (SELECT count(*)::int FROM app.agendamento WHERE tenant_id = ANY($1) AND estado IN ('marcada','confirmada')) AS ativas`,
    [ids],
  );
  const r = inv.rows[0]!;

  console.warn("\nResultado");
  console.warn(`  Municípios: ${MUNICIPIOS} · cidadãos: ${MUNICIPIOS * CIDADAOS} · vagas no dia disputado: ${MUNICIPIOS * 4 * 20}`);
  console.warn(`  Tempo da disputa: ${segundos.toFixed(1)} s · consultas marcadas: ${marcadas} · disputas perdidas e refeitas: ${disputasPerdidas}`);
  console.warn(`  Erros inesperados: ${Object.keys(erros).length ? JSON.stringify(erros) : "nenhum"}`);
  console.warn("  Latência (ms)              n     p50     p95     p99     máx");
  for (const [nome, v] of Object.entries(tempos)) {
    console.warn(`  ${nome.padEnd(26)}${String(v.length).padStart(5)}${[50, 95, 99, 100].map((p) => percentil(v, p).toFixed(0).padStart(8)).join("")}`);
  }
  console.warn(`  Invariantes: vagas com duas consultas = ${r.duplas}, horários sobrepostos = ${r.sobrepostas}, acima do limite = ${r.acima}, consultas ativas no banco = ${r.ativas}`);

  await admin.end();
  await encerrarPool();
  const ok = r.duplas === 0 && r.sobrepostas === 0 && r.acima === 0 && r.ativas === marcadas && Object.keys(erros).length === 0;
  if (!ok) parar("FALHOU: alguma invariante ou erro inesperado (ver acima)");
  console.warn("OK");
}

main().catch((e) => {
  console.error((e as Error).name);
  process.exit(1);
});
