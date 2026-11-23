/** Validação de CPF e CNS (Cartão Nacional de Saúde). Só confere formato e dígitos. */

export function normalizarCpf(entrada: string): string {
  return entrada.replace(/\D/g, "");
}

export function cpfValido(entrada: string): boolean {
  const cpf = normalizarCpf(entrada);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const digitos = cpf.split("").map(Number);
  for (const tamanho of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < tamanho; i++) soma += digitos[i]! * (tamanho + 1 - i);
    const resto = (soma * 10) % 11;
    if ((resto === 10 ? 0 : resto) !== digitos[tamanho]) return false;
  }
  return true;
}

export function normalizarCns(entrada: string): string {
  return entrada.replace(/\D/g, "");
}

/** Regra oficial do CNS: números iniciados em 1/2 (definitivos) e 7/8/9 (provisórios). */
export function cnsValido(entrada: string): boolean {
  const cns = normalizarCns(entrada);
  if (cns.length !== 15) return false;
  const primeiro = cns[0]!;
  if (!"12789".includes(primeiro)) return false;
  let soma = 0;
  for (let i = 0; i < 15; i++) soma += Number(cns[i]) * (15 - i);
  return soma % 11 === 0;
}
