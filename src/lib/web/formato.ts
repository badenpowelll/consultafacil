const FUSO = "America/Fortaleza";

export function dataHora(d: Date, fuso = FUSO): string {
  return new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit", timeZone: fuso }).format(d);
}

export function hora(d: Date, fuso = FUSO): string {
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: fuso }).format(d);
}

export function hojeLocal(fuso = FUSO): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: fuso }).format(new Date());
}

export const ESTADOS: Record<string, string> = {
  marcada: "Marcada",
  confirmada: "Confirmada",
  aguardando_remanejamento: "Profissional ausente: escolha outro horário",
  presente: "Chegou",
  atendida: "Atendida",
  faltou: "Faltou",
  cancelada_cidadao: "Desmarcada por você",
  cancelada_unidade: "Desmarcada pela unidade",
  remarcada: "Remarcada",
};
