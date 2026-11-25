import Link from "next/link";
import { redirect } from "next/navigation";
import { requisicaoAtual } from "@/lib/web/requisicao";

export default async function Equipe() {
  const atual = await requisicaoAtual();
  if (!atual?.req.sessao) redirect("/entrar");
  return (
    <>
      <h1>Área da equipe</h1>
      <p className="suave">Cada setor vê só o que o gestor liberou para a sua unidade.</p>
      <div className="grade">
        <a className="cartao" href="/equipe/agenda"><strong>Agenda do dia</strong><br />Marcar para o cidadão, check-in, atendida e falta.</a>
        <Link className="cartao" href="/equipe/cidadaos"><strong>Cidadãos</strong><br />Buscar por CPF ou nome, cadastrar no balcão, dependentes e link de acesso.</Link>
        <a className="cartao" href="/equipe/cadastros"><strong>Cadastros pendentes</strong><br />Aprovar cidadãos e dependentes pedidos pelo site.</a>
        <a className="cartao" href="/equipe/escalas"><strong>Escalas e ausências</strong><br />Dias e horários de cada profissional; avisar pacientes quando ele faltar.</a>
        <a className="cartao" href="/equipe/perfis"><strong>Perfis e permissões</strong><br />Perfis por setor e o que cada pessoa pode fazer em cada unidade.</a>
        <a className="cartao" href="/equipe/auditoria"><strong>Auditoria</strong><br />Quem fez o quê, quando e de onde. Exportação em CSV.</a>
        <a className="cartao" href="/equipe/identidade"><strong>Logomarca e cor</strong><br />Identidade do município no site e no comprovante.</a>
        <a className="cartao" href="/conta/seguranca"><strong>Segurança da conta</strong><br />Verificação em duas etapas.</a>
      </div>
    </>
  );
}
