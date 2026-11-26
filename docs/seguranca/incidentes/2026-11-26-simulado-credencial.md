# Incidente SIMULADO — credencial de profissional exposta (26/11/2026)

Ensaio, em ambiente local e com dados fictícios. Nenhum dado real envolvido.

**Cenário.** A senha de uma conta de profissional do município de demonstração aparece num lugar
público. A conta está com sessão aberta.

| Passo | O que foi feito | Resultado |
|---|---|---|
| Detectar | sessão ativa da conta localizada pela tabela de sessões (num caso real: auditoria e relato) | conta identificada só pelo id, sem CPF ou nome |
| Conter | `npm run municipio -- bloquear-conta <id> "Incidente simulado: credencial exposta"` | 1 sessão revogada; comando concluído em 0,5 s |
| Confirmar | a página com o cookie antigo redireciona para "Entrar"; novo login com a senha certa é recusado | contido |
| Rastro | auditoria do município registra `conta.bloquear` com operador e motivo | ok |
| Encerrar | `desbloquear-conta` depois da troca de senha (simulada) | ok |

Ensaio complementar no mesmo dia: `suspender demo` com o servidor no ar. A sessão aberta caiu, o
endereço passou a mostrar o aviso de indisponibilidade, e `reativar` devolveu a operação normal.

**O que aprendemos.**
- Faltava um comando de bloqueio de conta para o operador: criado neste incremento.
- A detecção ainda depende de olhar a auditoria: o alerta automático de volume fora do padrão fica
  para o incremento 8 (piloto monitorado), junto com os alertas do Railway.
- Comunicação à ANPD não foi ensaiada: depende do encarregado do município do piloto.
