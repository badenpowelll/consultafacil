# Operação do Consulta Fácil

Roteiros para quem opera a plataforma (Super Admin e suporte técnico). Tudo aqui roda fora do
processo web, com a credencial administrativa do banco, que nunca fica no serviço `site`.

| Roteiro | Quando usar |
|---|---|
| [Ciclo de vida do município](ciclo-do-municipio.md) | ativar, suspender, reativar, encerrar e exportar um município |
| [Incidentes](incidentes.md) | suspeita de acesso indevido, vazamento, credencial exposta, indisponibilidade |
| [Restauração do banco](restauracao.md) | ensaio trimestral e restauração real depois de perda de dados |
| [Migrações em produção](migracoes-em-producao.md) | toda mudança de banco que vai para o Railway |
| [Teste de carga](#teste-de-carga) | antes do piloto e antes de cada município novo |

## Ensaios do incremento 7 (26/11/2026, ambiente local, dados fictícios)

Todos rodados neste repositório, contra PostgreSQL 16 local. Os números servem de linha de base;
os ensaios precisam ser repetidos na homologação do Railway antes do piloto.

| Ensaio | Resultado |
|---|---|
| Teste de carga, 10 municípios, 1.000 cidadãos disputando 800 vagas do mesmo dia, 40 jornadas simultâneas | 800 consultas marcadas em 1,8 s; marcar p95 44 ms, buscar vagas p95 42 ms, painel p95 116 ms; nenhuma vaga dupla, nenhuma sobreposição, nenhum erro inesperado |
| Restauração isolada (`scripts/ensaio-restauracao.sh`) | cópia de 1,1 MB restaurada em 1 s; contagem de linhas, migrações com checksum, RLS forçado e políticas idênticos à origem |
| Migração em produção simulada | banco na versão do `main` (0001–0010) com 1.000 consultas; a 0011 entrou com uma segunda carga de 1.500 cidadãos rodando: sem erro, sem consulta perdida, invariantes intactas |
| Suspensão e reativação (servidor rodando) | sessões revogadas na hora, endereço mostra o aviso, e-mails ficam retidos e saem ao reativar |
| Encerramento com exportação completa (teste automatizado) | encerrar só depois da exportação; manifesto SHA-256 confere; nada de outro município na exportação |
| Incidente simulado (credencial exposta) | conta bloqueada e sessão derrubada em 0,5 s pelo comando; novo login recusado; registro em [incidentes/2026-11-26-simulado-credencial.md](../seguranca/incidentes/2026-11-26-simulado-credencial.md) |

## Teste de carga

```bash
DATABASE_URL_ADMIN=… DATABASE_URL=… CF_CHAVES_DADOS=… CF_CHAVE_DADOS_ATIVA=… CF_CHAVE_INDICE=… npm run carga
# opcional: CF_CARGA_MUNICIPIOS=10 CF_CARGA_CIDADAOS=100 CF_CARGA_CONCORRENCIA=40
```

Roda só fora de produção (recusa `NODE_ENV=production` e `CF_AMBIENTE=producao`) e deixa os
municípios `carga-…` no banco para inspeção: use um banco de homologação descartável. Mede as
mesmas funções que as telas chamam, com o papel `cf_app` e o pool de 10 conexões do app; não mede
a rede nem a renderização das páginas. O comando termina com erro se alguma invariante falhar.

Critério para o piloto: marcar e buscar com p95 abaixo de 300 ms na homologação do Railway com o
cenário de 10 municípios, e as invariantes zeradas.
