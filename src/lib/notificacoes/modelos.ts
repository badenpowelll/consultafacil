/**
 * Textos dos e-mails. Só dados da consulta (data, unidade, profissional): nada de CPF, CNS
 * ou informação clínica. Todo valor dinâmico é escapado antes de entrar no HTML.
 */
export type Modelo = "consulta_marcada" | "consulta_desmarcada" | "profissional_ausente" | "consulta_remarcada";
export type ModeloConta = "recuperar_senha";

export interface DadosConsulta {
  municipio: string;
  unidade: string;
  profissional: string;
  especialidade: string;
  inicio: Date;
  fuso: string;
  link: string;
  pelaUnidade?: boolean;
  /** Primeiro nome do dependente, quando a consulta é dele (o aviso vai para o titular). */
  dependente?: string | null;
}

export interface Mensagem {
  assunto: string;
  texto: string;
  html: string;
}

export function escaparHtml(valor: string): string {
  return valor.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function quando(d: DadosConsulta): string {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "full", timeStyle: "short", timeZone: d.fuso }).format(d.inicio);
}

export function montarMensagem(modelo: Modelo, d: DadosConsulta): Mensagem {
  const paciente = d.dependente ? `Consulta de ${d.dependente}: ` : "";
  const detalhe = `${paciente}${quando(d)}, ${d.especialidade} com ${d.profissional}, na ${d.unidade}.`;
  const corpo: Record<Modelo, { assunto: string; linhas: string[] }> = {
    consulta_marcada: {
      assunto: "Consulta marcada",
      linhas: ["Sua consulta foi marcada.", detalhe, "Se não puder ir, desmarque pelo sistema para liberar a vaga para outra pessoa."],
    },
    consulta_remarcada: {
      assunto: "Consulta remarcada",
      linhas: ["Sua consulta foi remarcada para um novo horário.", detalhe],
    },
    consulta_desmarcada: {
      assunto: "Consulta desmarcada",
      linhas: [
        d.pelaUnidade ? "A unidade de saúde desmarcou sua consulta." : "Sua consulta foi desmarcada, como você pediu.",
        detalhe,
        "Você pode marcar outro horário pelo sistema.",
      ],
    },
    profissional_ausente: {
      assunto: "Aviso: o profissional não poderá atender",
      linhas: [
        "O profissional não poderá atender no horário da sua consulta.",
        detalhe,
        "Sua consulta continua registrada. Escolha um novo horário pelo sistema ou procure a unidade, que vai ajudar a remarcar.",
      ],
    },
  };
  const c = corpo[modelo];
  const rodape = `Consulta Fácil · ${d.municipio}. Não respondemos por e-mail e nunca pedimos senha por mensagem.`;
  const texto = [...c.linhas, "", `Acesse: ${d.link}`, "", rodape].join("\n");
  const html = [
    ...c.linhas.map((l) => `<p>${escaparHtml(l)}</p>`),
    `<p><a href="${escaparHtml(d.link)}">Abrir o Consulta Fácil</a></p>`,
    `<p style="color:#555;font-size:12px">${escaparHtml(rodape)}</p>`,
  ].join("\n");
  return { assunto: `${c.assunto} · ${d.municipio}`, texto, html };
}

/** Link de recuperação de senha. O texto não traz nome nem CPF: só o município e o prazo. */
export function montarMensagemConta(_modelo: ModeloConta, d: { municipio: string; link: string; minutos: number }): Mensagem {
  const linhas = [
    "Recebemos um pedido para criar uma nova senha no Consulta Fácil.",
    `O link abaixo vale por ${d.minutos} minutos e só pode ser usado uma vez.`,
    "Se não foi você, ignore esta mensagem: sua senha atual continua valendo.",
  ];
  const rodape = `Consulta Fácil · ${d.municipio}. Não respondemos por e-mail e nunca pedimos senha por mensagem.`;
  const texto = [...linhas, "", `Criar nova senha: ${d.link}`, "", rodape].join("\n");
  const html = [
    ...linhas.map((l) => `<p>${escaparHtml(l)}</p>`),
    `<p><a href="${escaparHtml(d.link)}">Criar nova senha</a></p>`,
    `<p style="color:#555;font-size:12px">${escaparHtml(rodape)}</p>`,
  ].join("\n");
  return { assunto: `Nova senha · ${d.municipio}`, texto, html };
}
