# Consulta Fácil 2.0

Plataforma de agendamento de atendimentos de saúde para vários municípios. A prioridade é o **agendamento do paciente**: marcar, desmarcar com reabertura da vaga, remarcar e ser avisado quando o profissional não puder atender.

Este repositório está no **incremento 1 (base segura)**: identidade única, municípios isolados no banco, sessões, autorização por permissão e unidade, auditoria e política de segurança. Agendamento entra no incremento 2.

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
npm run dev
```

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
| `src/lib/http/`, `src/lib/exportacao/`, `src/lib/arquivos/` | respostas projetadas, exportação mascarada, upload seguro |
| `docs/seguranca/` | política de segurança da informação e matriz de barreiras contra vazamento |
| `docs/arquitetura.md` | decisões de arquitetura |

## Infraestrutura

Produção inteira no Railway (aplicação, worker e Postgres na mesma região). Vercel só para previews com dados fictícios.

## Segurança

Leia [`SECURITY.md`](SECURITY.md) e a [política de segurança](docs/seguranca/politica-seguranca-informacao.md). Nunca faça commit de `.env*` nem use dados reais em desenvolvimento.
