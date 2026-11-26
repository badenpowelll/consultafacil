# Restauração do banco

O Railway faz os backups agendados do serviço `postgres` (ligar em `postgres` → Backups, ver
`docs/deploy-railway.md`). Backup que nunca foi restaurado não conta: a política pede ensaio
trimestral.

## Ensaio trimestral (isolado)

1. Crie um serviço PostgreSQL 16 temporário no Railway, num ambiente separado de produção e sem
   domínio público. Esse é o destino.
2. Restaure nele o backup mais recente pelo painel (`postgres` → Backups → Restore no serviço
   temporário). Ou, para medir a cópia lógica a partir de produção, rode o script abaixo de um
   terminal com `railway run`:

   ```bash
   CF_ORIGEM_URL=<URL do banco de origem> \
   CF_DESTINO_URL=<URL admin do serviço temporário, banco postgres> \
   scripts/ensaio-restauracao.sh
   ```

   O script copia com `pg_dump`, restaura num banco novo `cf_restauro_<data>`, confere contagem de
   linhas por tabela, migrações com checksum, RLS forçado e políticas, mede o tempo e apaga a
   cópia (use `CF_MANTER_COPIA=1` para inspecionar). A cópia trabalha numa pasta temporária só do
   dono, apagada ao fim.
3. Anote data, tamanho, tempo e resultado na tabela abaixo e remova o serviço temporário.

| Data | Origem | Tamanho | Tempo até a cópia restaurada | Resultado |
|---|---|---|---|---|
| 26/11/2026 | banco local de testes (fictício) | 1,1 MB | 1 s | fiel à origem |

## Restauração real

1. Abra um incidente ([incidentes.md](incidentes.md)) e suspenda os municípios afetados para parar
   escrita nova (`npm run municipio -- suspender …`).
2. Restaure o backup escolhido num serviço novo e rode as conferências do script contra ele.
3. Aplique as migrações que faltarem (`npm run db:predeploy` com as variáveis do serviço novo).
4. Troque a referência `DATABASE_URL` dos serviços `site` e `worker` para o banco restaurado e
   faça redeploy. A senha de `cf_app` é a mesma do ambiente (o pré-deploy a confirma).
5. Reative os municípios e registre o que foi perdido entre o backup e o incidente (consultas
   marcadas nesse intervalo precisam ser conferidas com as unidades).
