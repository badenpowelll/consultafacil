# Roteiro de incidentes

Complementa a seção 8 da [política de segurança](../seguranca/politica-seguranca-informacao.md):
aqui estão os comandos. Cada incidente (real ou simulado) ganha um registro em
`docs/seguranca/incidentes/AAAA-MM-DD-assunto.md`, sem dado pessoal.

## Papéis

| Papel | Quem (definir no contrato do piloto) |
|---|---|
| Responsável pelo incidente | coordena, decide contenção, abre o registro |
| Operador técnico | roda os comandos, guarda as evidências |
| Encarregado (DPO) do município | decide e faz a comunicação à ANPD e aos titulares |
| Contato da prefeitura | recebe os fatos, autoriza suspensão |

## 1. Detectar e conter (meta: 1 hora)

Sinais: alerta de volume, relato de cidadão ou servidor, achado em auditoria, segredo exposto.

```bash
export CF_OPERADOR=apelido DATABASE_URL_ADMIN=…
# Uma conta: bloqueia em todos os municípios e derruba as sessões (o id vem da auditoria).
npm run municipio -- bloquear-conta <conta_id> "Incidente AAAA-MM-DD: motivo"
# Um município inteiro: sessões, links, rotinas e e-mails param; dados preservados.
npm run municipio -- suspender <slug> "Incidente AAAA-MM-DD: motivo"
```

Segredo exposto: troque no Railway (Variables) e faça redeploy.
- `CF_APP_DB_PASSWORD`: o pré-deploy aplica a senha nova ao papel `cf_app`.
- `CF_CHAVES_DADOS`: acrescente uma versão nova e mude `CF_CHAVE_DADOS_ATIVA`; a recifragem em
  lote dos dados antigos é um passo seguinte.
- `RESEND_API_KEY`: gere outra no Resend e revogue a antiga.
- `DATABASE_URL_ADMIN`: troque a senha do usuário administrativo no Postgres.

## 2. Avaliar (meta: 24 horas)

A auditoria responde quem fez o quê, onde e quando. Consultas de apoio (somente leitura):

```sql
-- O que a conta suspeita fez, por município e ação
SELECT tenant_id, acao, count(*), min(criado_em), max(criado_em)
FROM app.auditoria WHERE conta_id = '<conta_id>' AND criado_em > now() - interval '30 days'
GROUP BY 1, 2 ORDER BY 3 DESC;

-- Contas com volume fora do padrão na última hora
SELECT tenant_id, conta_id, count(*) AS acoes
FROM app.auditoria WHERE criado_em > now() - interval '1 hour' AND conta_id IS NOT NULL
GROUP BY 1, 2 HAVING count(*) > 200 ORDER BY 3 DESC;

-- Exportações no período (cada arquivo traz o id no rodapé)
SELECT tenant_id, conta_id, objeto_tipo, objeto_id, detalhes, criado_em
FROM app.auditoria WHERE acao = 'exportacao.gerar' AND criado_em > now() - interval '7 days';

-- Sessões da conta (de onde e quando)
SELECT tenant_id, criada_em, ultima_atividade, revogada_em, motivo_revogacao
FROM app.sessao WHERE conta_id = '<conta_id>' ORDER BY criada_em DESC LIMIT 50;
```

Guarde o resultado das consultas no registro do incidente sem copiar dado pessoal (use ids).

## 3. Comunicar

Havendo risco ou dano relevante aos titulares, o município (controlador) comunica a ANPD e os
titulares em até 3 dias úteis (Resolução CD/ANPD nº 15/2024). Nós entregamos os fatos por escrito:
o que aconteceu, quando, quais municípios, quantas pessoas, que dados, o que foi feito.

## 4. Corrigir e aprender

Causa, correção (PR) e mudança de processo no registro. Reative o que foi suspenso
(`reativar`, `desbloquear-conta`) só depois da correção.

## Ensaios

Um incidente simulado antes do piloto e depois a cada semestre. Registro do primeiro:
[2026-11-26-simulado-credencial.md](../seguranca/incidentes/2026-11-26-simulado-credencial.md).
