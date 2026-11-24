# Publicação automática no Railway

A infraestrutura de produção está descrita em [`.railway/railway.ts`](../.railway/railway.ts) (Railway Infrastructure as Code). Depois da configuração inicial abaixo, **cada push em `main` publica o site sozinho**, e só depois que o CI do GitHub passa.

## O que roda

| Serviço | O que faz |
|---|---|
| `postgres` | banco de dados (rede privada do Railway, sem porta pública necessária) |
| `site` | Next.js (`next start`), com verificação de saúde em `/api/health` |
| `worker` | e-mails de aviso (`npm run worker`). **Desligado** até o Resend ser configurado (em produção ele não sobe sem e-mail de verdade): troque `COM_WORKER` para `true` no arquivo |

Em cada deploy do `site`:

1. O Railway espera o CI do GitHub passar (lint, tipos, testes de isolamento, build, gitleaks). CI vermelho = nada é publicado.
2. Constrói a aplicação (`npm run build`).
3. **Pré-deploy:** `npm run db:predeploy` aplica as migrações novas e confirma a senha do papel `cf_app`. Se falhar, o deploy para e a versão anterior continua no ar.
4. Sobe a versão nova e só troca o tráfego quando `/api/health` responde 200 (o que inclui conseguir falar com o banco).

O servidor sobe com `env -u` removendo `DATABASE_URL_ADMIN`, `CF_APP_DB_PASSWORD` e `CF_SEED_SENHA` do ambiente: o processo da aplicação nunca enxerga as credenciais administrativas, que só existem para o pré-deploy.

## Configuração inicial (uma vez)

Nunca cole segredos em chat, issue, PR ou arquivo do repositório. Eles vão só no painel do Railway.

### 1. No painel do Railway

1. Crie um projeto vazio chamado `consulta-facil`.
2. Em **Account Settings → Integrations**, confirme que o GitHub está conectado e que o app do Railway tem acesso ao repositório `badenpowelll/consultafacil`.

### 2. No seu computador (Railway CLI 5.42.1 ou mais nova)

```bash
npm install -g @railway/cli
git clone https://github.com/badenpowelll/consultafacil && cd consultafacil
npm ci
railway login
railway link              # escolha o projeto consulta-facil e o ambiente production
railway config plan       # mostra o que será criado: postgres e site
railway config apply
```

O primeiro deploy do `site` vai falhar até o passo 3: é esperado, porque os segredos ainda não existem.

### 3. Variáveis do serviço `site` (painel → `site` → Variables)

Gere cada valor no seu computador e cole direto no painel:

| Variável | Valor |
|---|---|
| `CF_APP_DB_PASSWORD` | `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"` (48 caracteres) |
| `DATABASE_URL` | exatamente `postgresql://cf_app:${{CF_APP_DB_PASSWORD}}@${{postgres.PGHOST}}:${{postgres.PGPORT}}/${{postgres.PGDATABASE}}` (o Railway completa as referências) |
| `CF_CHAVES_DADOS` | `1:` seguido de `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `CF_CHAVE_INDICE` | outro valor gerado com o mesmo comando (nunca igual à chave de dados) |
| `CF_DOMINIO_BASE` | o domínio do site (veja o passo 4) |

`NODE_ENV`, `DATABASE_URL_ADMIN` e as demais já vêm do arquivo. Guarde `CF_CHAVES_DADOS` e `CF_CHAVE_INDICE` também num cofre de senhas: sem elas, CPF e CNS cifrados não podem ser lidos.

Ao salvar, o Railway faz um novo deploy.

### 4. Domínio

- Para testar: `site` → Settings → Networking → **Generate Domain**.
- Para os municípios (cada um no seu subdomínio, como `mossoro.seudominio.gov.br`): adicione um domínio próprio **curinga** (`*.seudominio.gov.br`) em Networking, crie os registros DNS que o Railway indicar e ponha `CF_DOMINIO_BASE=seudominio.gov.br`.

### 5. Conferências no painel

- `site` → Settings → Source: ramo `main` e **Wait for CI** ligado.
- `postgres` → Backups: ligue backups agendados (a política pede teste de restauração trimestral).
- Todos os serviços na mesma região.

## Depois

- **Mudar a infraestrutura:** edite `.railway/railway.ts`, abra um PR e, depois do merge, rode `railway config plan` e `railway config apply`.
- **Trocar a senha de `cf_app`** (semestral ou em incidente): troque `CF_APP_DB_PASSWORD` no painel. O pré-deploy aplica a senha nova e `DATABASE_URL` acompanha pela referência.
- **Ligar o worker:** com a conta do Resend criada e o domínio do remetente verificado, troque `COM_WORKER` para `true`, aplique, e preencha `RESEND_API_KEY` e `CF_EMAIL_REMETENTE` no serviço `worker`.
- **Reverter uma versão:** painel → `site` → Deployments → versão anterior → Redeploy. Migrações não voltam sozinhas: corrija com uma migração nova.
