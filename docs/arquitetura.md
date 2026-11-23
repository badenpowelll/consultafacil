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

## Fora do piloto

Prescrição, atestado com CID-10 e envio por WhatsApp ficam para a fase clínica, conforme o plano v2.
