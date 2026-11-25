# Procedimentos de suporte

Guia curto para quem atende o município no piloto. Vale a regra de sempre: só dados fictícios fora de produção, e nunca pedir senha, código de verificação ou link de acesso a ninguém.

## Quem faz o quê

| Situação | Quem resolve | Onde no sistema |
| --- | --- | --- |
| Cidadão esqueceu a senha e tem e-mail | O próprio cidadão | "Esqueci minha senha" na tela de entrada |
| Cidadão sem e-mail ou sem celular | Recepção | Equipe › Cidadãos › ficha › "Gerar link de primeiro acesso" (vale 3 dias, uso único) |
| Cadastro pelo site aguardando aprovação | Recepção com `cidadao.aprovar` | Equipe › Cadastros pendentes |
| Dependente (criança, guarda, curatela) | Recepção confere o documento | Ficha do cidadão › Incluir dependente, ou Cadastros pendentes |
| Não confirmou, ficou sem aviso, vaga para hoje ou amanhã | Recepção | Equipe › Contatos pendentes |
| Profissional vai faltar | Gestor ou quem tem `ausencia.registrar` | Equipe › Escalas e ausências |
| Prioridade na lista de espera (idoso, gestante, PcD) | Recepção confere o documento | Ficha do cidadão › Incluir na lista de espera, ou Equipe › Lista de espera |
| Alguém da equipe sem acesso a uma tela | Gestor | Equipe › Perfis e permissões |
| Suspeita de acesso indevido | Gestor e encarregado de dados | Equipe › Auditoria (filtrar por pessoa, ação e data) |

## Regras que não mudam

- Consulta marcada só deixa de existir por ação de uma pessoa (cidadão, recepção ou gestor), com motivo. Falta de resposta, e-mail não entregue ou falha do sistema nunca desmarcam.
- A vaga oferecida pela lista de espera fica guardada para a pessoa até o prazo mostrado. Depois disso, vai para o próximo automaticamente. Se a pessoa aceitar por telefone, a recepção usa "A pessoa aceitou" em Contatos pendentes.
- Exportações (CSV) exigem verificação em duas etapas e ficam na auditoria com o número da exportação, que também vai no rodapé do arquivo. Arquivo encontrado fora do lugar: procure esse número na auditoria.

## Problemas comuns

**"Não recebi o e-mail."** Confira em Contatos pendentes se a pessoa aparece como "Sem e-mail cadastrado" ou "E-mail não entregue". O sistema tenta de novo até 5 vezes, com intervalos crescentes, sem mandar a mesma mensagem duas vezes. Se não houver e-mail, avise por telefone ou no balcão e, se a pessoa quiser usar o site, gere o link de primeiro acesso.

**"A vaga sumiu enquanto eu escolhia."** Outra pessoa marcou antes, ou a vaga foi oferecida a alguém da lista de espera. O sistema mostra a próxima vaga livre. Para a vaga voltar, só se a oferta vencer ou for recusada.

**"O cidadão diz que tem cadastro, mas a busca não acha."** Busque pelo CPF completo (11 dígitos). Pela busca por nome, digite ao menos 3 letras. Cadastro de outro município não aparece: cada município vê só os seus.

**"Limite de consultas atingido."** Cada paciente pode ter até 3 consultas futuras, e cada titular até 10 somando os dependentes. Desmarque uma que não vai usar.

**"A tela pede verificação em duas etapas."** Gestão, auditoria e exportação exigem. A pessoa ativa em Conta › Segurança e entra de novo.

## Escalonamento

1. Recepção resolve o que está na tabela acima.
2. Gestor do município: permissões, ausências, prioridades, auditoria.
3. Suporte técnico (responsável definido no contrato do piloto): erro de sistema, lentidão, indisponibilidade. Envie data, hora, tela e o que estava fazendo. Não envie CPF, nome de paciente nem print com dados pessoais: use o número da consulta ou da exportação.
4. Incidente de segurança ou vazamento: siga `docs/seguranca/politica-seguranca-informacao.md` (comunicação ao encarregado e, se for o caso, à ANPD e aos titulares).
