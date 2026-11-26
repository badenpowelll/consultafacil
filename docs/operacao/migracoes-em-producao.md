# Migrações em produção

O pré-deploy do Railway (`npm run db:predeploy`) aplica as migrações novas antes de a versão nova
subir. Se falhar, nada muda e a versão anterior continua no ar. Por isso cada migração precisa
funcionar com a versão do app que já está rodando, e não só com a nova.

## Regras

- **Expandir, depois contrair.** Coluna, tabela ou função nova entra numa versão; o código passa a
  usá-la; só numa versão seguinte o que ficou velho sai. Nada destrutivo no mesmo deploy.
- **Função trocada mantém a assinatura** (`CREATE OR REPLACE` com os mesmos parâmetros e retorno).
  Assinatura nova é função nova.
- **Travas curtas.** Cada migração roda numa transação com `lock_timeout = 5s`: se uma tabela
  movimentada não liberar, a migração falha em vez de parar o sistema. Índice em tabela grande:
  migração própria com `CREATE INDEX CONCURRENTLY` (fora de transação) quando a tabela passar de
  alguns milhões de linhas.
- **Imutável depois de aplicada.** O checksum é conferido a cada execução. Erro se corrige com
  migração nova.
- **Nunca volta sozinha.** Reverter o app (Redeploy da versão anterior) não desfaz a migração; ela
  já precisa ser compatível com a versão anterior (regra 1).

## Antes do merge

1. CI verde (aplica todas as migrações do zero e roda a suíte).
2. Ensaio contra a versão em produção: banco na versão do `main`, com dados, e a migração nova
   aplicada enquanto o teste de carga roda.

   ```bash
   git worktree add /tmp/cf-main origin/main            # versão em produção
   (cd /tmp/cf-main && DATABASE_URL_ADMIN=…/ensaio npm run db:migrate)
   DATABASE_URL_ADMIN=…/ensaio DATABASE_URL=…/ensaio npm run carga             # dados
   (DATABASE_URL_ADMIN=…/ensaio DATABASE_URL=…/ensaio npm run carga &)          # carga durante…
   DATABASE_URL_ADMIN=…/ensaio npm run db:migrate                               # …a migração nova
   ```

   Ensaio da 0011 em 26/11/2026: aplicada com 1.500 cidadãos disputando vagas, sem erro e sem
   quebra das invariantes.
3. Migração que reescreve muitas linhas: medir o tempo no ensaio e, se passar de alguns segundos,
   dividir em lotes.

## Depois do deploy

Confira no Railway o log do pré-deploy (`aplicada: …`) e o `/api/health`. Se algo estiver errado,
Redeploy da versão anterior e correção com migração nova.
