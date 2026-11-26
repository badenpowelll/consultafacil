# Ciclo de vida do município

```
provisionando → ativo → suspenso ⇄ ativo
ativo | suspenso → encerrando → encerrado   (só depois da exportação completa)
```

| Estado | O que acontece |
|---|---|
| provisionando | nada é público; o endereço responde como desconhecido |
| ativo | operação normal |
| suspenso | sessões revogadas na hora; o endereço mostra "agendamento on-line indisponível"; links de e-mail, comprovantes e logomarca deixam de abrir; rotinas (lista de espera, lembretes) e e-mails param, e os e-mails pendentes ficam guardados; nenhum dado é apagado |
| encerrando | igual a suspenso; é o prazo para gerar e entregar a exportação completa |
| encerrado | definitivo pelo comando (não volta a ativo); o expurgo segue o contrato e o prazo legal |

## Comandos

Rodam num terminal com acesso ao banco (Railway CLI `railway run`, ou o serviço de migração),
nunca no serviço `site`. `CF_OPERADOR` é um apelido curto de quem executa (sem e-mail): ele vai
para a auditoria do município junto com o motivo.

```bash
export CF_OPERADOR=apelido DATABASE_URL_ADMIN=…
npm run municipio -- situacao <slug>
npm run municipio -- ativar <slug> "Contrato assinado, gestor convidado"
npm run municipio -- suspender <slug> "Ofício nº … da prefeitura"
npm run municipio -- reativar <slug> "Pendência resolvida"
npm run municipio -- encerrar <slug> "Fim do contrato em …"
npm run municipio -- exportar <slug> /caminho/de/uma/pasta-nova
npm run municipio -- concluir-encerramento <slug> "Exportação entregue, recibo nº …"
```

Toda mudança é recusada se pular etapa, se faltar motivo ou se o operador não estiver identificado.

## Suspensão

1. Confirme o pedido por escrito (prefeitura, contrato ou incidente) e rode `situacao` para ver
   sessões ativas, consultas futuras e e-mails pendentes.
2. `suspender`. Avise o gestor do município: as unidades atendem pela recepção, e as consultas
   marcadas continuam valendo.
3. Para voltar, `reativar`. Os e-mails retidos saem em seguida; ofertas da lista de espera que
   venceram nesse meio-tempo já liberaram a vaga e não são reenviadas.

## Encerramento

1. `encerrar`: o município fica indisponível como na suspensão.
2. Avise as pessoas com consulta futura conforme o contrato (a prefeitura decide como).
3. `exportar` para uma pasta nova num computador protegido. A pasta sai só para o dono (0700) e
   traz um CSV por tabela, `pessoas.csv` (com CPF, CNS e e-mail decifrados), as imagens da
   identidade visual, `LEIA-ME.txt` e `manifesto.sha256`. A auditoria guarda o id e o hash do
   manifesto.
4. Entregue à prefeitura por meio seguro (mídia cifrada ou transferência com senha separada) e
   peça o recibo. Confira com `sha256sum -c manifesto.sha256` dos dois lados.
5. Apague as cópias intermediárias e só então `concluir-encerramento`.
6. Expurgo: depois do prazo contratual, preservando o que a lei manda reter, e com termo de
   eliminação. Os backups do provedor expiram no ciclo normal. Esse passo ainda não tem comando:
   faz parte do contrato do piloto e precisa de validação jurídica antes de existir.

A exportação completa também atende pedido de portabilidade da própria prefeitura com o município
ativo: ela é a controladora dos dados.
