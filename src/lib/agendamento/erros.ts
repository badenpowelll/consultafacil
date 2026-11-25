import { AcessoNegado } from "@/lib/auth/autorizar";

/**
 * Erros de regra do agendamento, com mensagens para a pessoa. O banco levanta códigos curtos
 * (ex.: 'vaga_indisponivel'); aqui eles viram mensagens claras, sem detalhes internos.
 */
export const MENSAGENS = {
  vaga_inexistente: "Esta vaga não existe mais.",
  vaga_indisponivel: "Esta vaga acabou de ser ocupada. Escolha outro horário.",
  vaga_no_passado: "Este horário já passou.",
  limite_consultas: "Já há o número máximo de consultas futuras marcadas para esta pessoa.",
  conflito_horario: "Esta pessoa já tem outro atendimento nesse horário.",
  dependente_invalido: "Dependente não encontrado ou ainda não aprovado pela unidade.",
  consulta_inexistente: "Consulta não encontrada.",
  motivo_obrigatorio: "Informe o motivo.",
  transicao_invalida: "Esta consulta não pode mudar para essa situação.",
  nao_e_sua: "Consulta não encontrada.",
  sem_vinculo_cidadao: "Seu cadastro neste município ainda não está ativo.",
  escala_inexistente: "Escala não encontrada.",
  horizonte_maximo_120_dias: "As vagas podem ser abertas até 120 dias à frente.",
  dados_invalidos: "Dados inválidos.",
  fora_do_horario: "Ainda não é possível registrar isso: a consulta é mais tarde.",
  especialidade_inexistente: "Não há profissional dessa especialidade no município.",
  unidade_inexistente: "Unidade não encontrada.",
  limite_espera: "Esta pessoa já está no número máximo de listas de espera.",
  ja_na_espera: "Esta pessoa já está na lista de espera dessa especialidade.",
  espera_encerrada: "Este pedido já saiu da lista de espera.",
  oferta_encerrada: "O prazo para responder passou ou a vaga já foi respondida.",
  espera_incompativel: "Esta vaga não combina com o pedido da lista de espera.",
  sem_tempo_para_oferta: "Não há tempo para oferecer esta vaga.",
  oferta_invalida: "Oferta inválida.",
  ja_confirmada: "Esta consulta não está aguardando confirmação.",
} as const;

export type CodigoErro = keyof typeof MENSAGENS;

export class ErroAgendamento extends Error {
  constructor(public readonly codigo: CodigoErro) {
    super(MENSAGENS[codigo]);
    this.name = "ErroAgendamento";
  }
}

/** Converte exceções do banco em erros de regra; o resto segue como está. */
export function traduzirErroBanco(erro: unknown): never {
  const msg = erro instanceof Error ? erro.message : "";
  if (msg === "sem_permissao") throw new AcessoNegado("sem_permissao");
  if (msg in MENSAGENS) throw new ErroAgendamento(msg as CodigoErro);
  if (/^Transição de .* não permitida$/.test(msg)) throw new ErroAgendamento("transicao_invalida");
  const codigo = (erro as { code?: string }).code;
  if (codigo === "23P01" && /agendamento_vaga_ativa|vaga/.test(msg)) throw new ErroAgendamento("vaga_indisponivel");
  if (codigo === "23505" && /agendamento_vaga_ativa|oferta_ativa_vaga/.test(msg)) throw new ErroAgendamento("vaga_indisponivel");
  if (codigo === "23505" && /espera_vigente/.test(msg)) throw new ErroAgendamento("ja_na_espera");
  throw erro;
}
