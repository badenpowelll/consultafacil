import { VERSAO_TERMOS } from "@/lib/cidadao/recepcao";

/**
 * Termos de uso e aviso de privacidade em linguagem simples. Texto de referência para o piloto:
 * a versão final depende de validação jurídica da prefeitura (controladora dos dados).
 */
export default function Termos() {
  return (
    <>
      <h1>Termos de uso e privacidade</h1>
      <p className="suave">Versão {VERSAO_TERMOS}. Texto do piloto, sujeito a validação jurídica da prefeitura.</p>
      <h2>Para que serve</h2>
      <p>O Consulta Fácil serve para marcar, remarcar e desmarcar consultas na rede municipal de saúde, para você e para seus dependentes.</p>
      <h2>Que dados usamos</h2>
      <ul>
        <li>Nome, CPF e data de nascimento, para saber quem é você e evitar cadastro duplicado.</li>
        <li>E-mail, se você informar, para avisos de consulta e para criar nova senha.</li>
        <li>As consultas marcadas e o que aconteceu com cada uma (presença, falta, desmarcação).</li>
      </ul>
      <p>O CPF e o e-mail ficam cifrados. A equipe da unidade vê só o necessário para atender você, e cada acesso fica registrado.</p>
      <h2>Seus compromissos</h2>
      <ul>
        <li>Informar dados verdadeiros e manter sua senha em segredo.</li>
        <li>Desmarcar com antecedência quando não puder ir, para a vaga ir para outra pessoa.</li>
        <li>Incluir como dependente só quem está sob sua responsabilidade. A unidade confere o documento.</li>
      </ul>
      <h2>Seus direitos</h2>
      <p>Você pode pedir na unidade ou à prefeitura uma cópia dos seus dados, a correção do que estiver errado e informações sobre como eles são usados, como prevê a Lei Geral de Proteção de Dados.</p>
    </>
  );
}
