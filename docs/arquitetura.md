# Arquitetura — decisões do incremento 1

## Multimunicípio no mesmo banco, isolado por RLS forçado

Um banco, um esquema `app`, `tenant_id` em toda tabela municipal. O isolamento é do PostgreSQL, não da aplicação:

- A aplicação conecta como `cf_app`: `NOBYPASSRLS`, dona de nada, só com os `GRANT`s explícitos.
- As tabelas são de `cf_owner` (`NOLOGIN`), usado só por migrações.
- `FORCE ROW LEVEL SECURITY` com política `tenant_id = app.tenant_atual()` para leitura e escrita.
- O município vem de `set_config('app.tenant_id', ..., true)` dentro da transação (`comMunicipio`). Sem contexto, nenhuma linha.
- Chaves estrangeiras compostas `(tenant_id, id)` impedem apontar para registro de outro município.

## Identidade global, vínculos por município

Uma pessoa (CPF) tem uma conta e pode ter vínculos em vários municípios (gestor, equipe, cidadão). As tabelas de identidade (`pessoa`, `conta`, `sessao`) não têm política para `cf_app`: o acesso é só por funções `SECURITY DEFINER` com propósito único, `search_path` fixo e retorno mínimo.

## Mesma pessoa, nunca em dois lugares ao mesmo tempo

`app.ocupacao_pessoa` guarda só `(pessoa, período, município, referência)` com restrição de exclusão GiST. Reservar num município um horário que se sobrepõe a outro compromisso, em qualquer município, devolve apenas "conflito", sem revelar onde.

## Sessão opaca em vez de JWT

Revogar precisa valer na hora (troca de senha, suspensão de município, demissão). O cookie leva 256 bits aleatórios; o banco guarda o SHA-256.

## Autorização

Sessão → município escolhido (precisa coincidir com o subdomínio) → vínculo ativo → permissão no escopo. O gestor recebe permissões administrativas, nunca clínicas; permissões clínicas só vêm de perfis atribuídos.

## Agendamento (incremento 2)

- **Escala → vagas.** O gestor define dias da semana, horário e duração da consulta; `app.vagas_gerar` cria as vagas em horário local do município (`tenant.fuso`). Cada vaga reserva o horário do profissional na ocupação global, então ele nunca tem vagas sobrepostas em duas unidades ou municípios.
- **Marcar.** `app.agendamento_marcar` trava a vaga (`FOR UPDATE`), confere vínculo de cidadão ativo, limite de 3 consultas futuras e reserva o horário do paciente na ocupação global. Duas pessoas na mesma vaga ao mesmo tempo: uma consegue, a outra recebe "vaga ocupada".
- **Desmarcar e remarcar.** A consulta não é apagada (gatilho bloqueia DELETE); muda de estado e a vaga volta a ficar livre se ainda estiver no futuro.
- **Máquina de estados.** `app.agendamento_transicao_valida` lista as transições permitidas; qualquer outra é recusada pelo banco. Cada transição gera um evento em `agendamento_evento` (somente inserção).
- **Ausência do profissional.** Bloqueia as vagas livres da unidade no período e põe as consultas em "aguardando remanejamento": elas continuam valendo até o paciente escolher outro horário ou a unidade agir. Silêncio nunca cancela consulta.
- **E-mails.** As operações gravam na fila `notificacao` só identificadores. O worker (`npm run worker`) reserva lotes com `SKIP LOCKED`, busca o endereço cifrado por uma função própria, envia por API HTTPS e tenta de novo com espera crescente (até 5 vezes). Cada envio leva a chave de idempotência `notificacao-<id>`: se o worker cair entre o envio e o registro, a nova tentativa não chega duas vezes. Aviso que perdeu o sentido antes de sair (consulta desmarcada, oferta encerrada) fica como `descartada`.
- **Lista de espera (`espera`, `oferta`).** O cidadão (ou a recepção, por ele ou por um dependente) entra na fila de uma especialidade, com unidade e turno opcionais; até 3 listas por pessoa. Quando uma vaga abre (desmarque, remarcação, escala nova, oferta recusada ou vencida), `app.oferecer_vaga`/`app.espera_distribuir` a oferecem ao primeiro compatível (prioridade marcada pela equipe primeiro, depois ordem de entrada). A vaga fica só para essa pessoa por 2 horas contadas das 7h às 20h (`app.prazo_oferta`), terminando no máximo 2 horas antes da consulta. A disponibilidade é calculada na consulta: oferta vencida já conta como livre, sem depender de rotina. Ninguém marca vaga oferecida a outra pessoa (gatilho `agendamento_oferta`), e marcar a especialidade por outro caminho tira a pessoa da fila.
- **Rotinas do worker.** A cada minuto, para cada município ativo: `espera_distribuir` (ofertas pendentes) e `lembretes_gerar` (lembrete da véspera, das 9h às 20h, uma vez por consulta por índice único). Nada desmarca consulta por falta de resposta: quem não confirmou ou ficou sem aviso aparece em "Contatos pendentes" para a recepção ligar.

## Comprovante de agendamento

O cidadão baixa o comprovante em PDF em "Minhas consultas"; a equipe com permissão de ver a agenda da unidade também emite, para imprimir na recepção. O PDF traz um código de validação e um QR code que levam à página pública `/validar/<código>` no subdomínio do município.

- O código é um HMAC do id da consulta com a chave do índice cego: a segunda via sai igual, não dá para adivinhar e não revela o id. O banco guarda só o SHA-256 dele (`app.comprovante`, somente inserção, RLS forçado).
- A validação pública roda pela função `app.comprovante_validar`, só no município de origem, com limite de 60 consultas por hora por IP, e mostra a situação atual, data, unidade, profissional e as iniciais do paciente. Nome completo, CPF e contato não aparecem.
- Os metadados do PDF não têm autor nem assunto. A logomarca do município entra no lugar da marca genérica quando o envio de logo existir.

## Fora do piloto

Prescrição, atestado com CID-10 e envio por WhatsApp ficam para a fase clínica, conforme o plano v2.
