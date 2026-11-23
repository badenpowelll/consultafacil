# Consulta Fácil 2.0

Plataforma de agendamento de atendimentos de saúde para vários municípios. A prioridade é o **agendamento do paciente**: marcar, desmarcar com reabertura da vaga, remarcar e ser avisado quando o profissional não puder atender.

Incrementos entregues:

1. **Base segura**: identidade única, municípios isolados no banco, sessões, autorização por permissão e unidade, auditoria e política de segurança.
2. **Agendamento do paciente**: escalas (dias e horários de cada profissional), vagas, marcar, desmarcar (a vaga reabre), remarcar, check-in e falta, ausência do profissional com aviso por e-mail, autocadastro do cidadão com aprovação da unidade e verificação em duas etapas para a equipe.

## Requisitos

- Node 22 (`.nvmrc`)
- PostgreSQL 16 (local via `docker compose up -d`)

## Primeiros passos

```bash
cp .env.example .env.local        # preencha chaves e senhas (instruções no arquivo)
npm ci
npm run db:migrate                # usa DATABASE_URL_ADMIN
npm run db:app-password           # define a senha do papel cf_app
npm run db:seed                   # só dados fictícios; recusa rodar em produção
npm run dev                       # abra http://demo.localhost:3000
npm run worker                    # outro terminal: envia os e-mails da fila
```

O seed cria o município `demo` com uma gestora (CPF 529.982.247-25), uma médica (111.444.777-35) e uma cidadã (390.533.447-05), todas fictícias e com a senha definida em `CF_SEED_SENHA`.

## Verificações

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

`npm test` roda testes de unidade e de integração. Os de integração precisam do Postgres e provam, como o papel da aplicação, que um município não lê nem grava dados de outro.

## Onde está cada coisa

| Caminho | Conteúdo |
|---|---|
| `db/migrations/` | papéis, tabelas, RLS forçado, funções `SECURITY DEFINER` |
| `src/lib/db/` | pool e contexto de município por transação |
| `src/lib/auth/` | sessão, login, autorização |
| `src/lib/security/` | cifra de campo, índice cego, senhas, TOTP, tokens |
| `src/middleware.ts` | CSP com nonce, município pelo subdomínio |
| `docs/seguranca/` | política de segurança da informação |
| `docs/arquitetura.md` | decisões de arquitetura |

## Infraestrutura

Produção inteira no Railway, na mesma região:

| Serviço | Comando | Observação |
|---|---|---|
| Aplicação | `npm run build` e `npm start` | `CF_AMBIENTE=producao`, domínio curinga `*.seu-dominio` |
| Worker de e-mails | `npm run worker` | mesmas variáveis; `CF_EMAIL_TRANSPORTE=resend` |
| Postgres 16 | — | migrações com `npm run db:migrate` antes de cada versão |

Vercel só para previews com dados fictícios.

## Segurança

Leia [`SECURITY.md`](SECURITY.md) e a [política de segurança](docs/seguranca/politica-seguranca-informacao.md). Nunca faça commit de `.env*` nem use dados reais em desenvolvimento.
