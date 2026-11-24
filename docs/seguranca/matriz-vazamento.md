# Matriz de barreiras contra vazamento de dados

Versão 1.0 · 23/11/2026 · complementa a [política de segurança](politica-seguranca-informacao.md)

Cada caminho por onde um dado pessoal ou de saúde pode sair do sistema tem pelo menos duas barreiras independentes: se uma falhar (erro de código, conta comprometida, servidor mal-intencionado), a outra ainda segura. A coluna "Teste" aponta o teste automatizado que prova a barreira no CI; "operacional" indica controle que depende de configuração ou processo, fora do código.

Legenda das camadas: **B** banco (RLS, privilégios, gatilhos, restrições) · **S** servidor (código) · **H** cabeçalhos HTTP · **L** lint/CI · **O** operacional.

## 1. Matriz

| # | Ameaça (caminho de vazamento) | Barreiras | Camada | Teste |
|---|---|---|---|---|
| 1 | **Município lê dados de outro** (sessão válida, URL trocada, rota que esquece o filtro) | RLS forçado por `tenant_id`; FKs compostas; sessão presa ao município do subdomínio | B, S | `tests/integration/isolamento.test.ts` (PR #1) |
| 2 | **Resposta de API com campos demais** (devolver a linha do banco inteira, com hash, texto cifrado, índice cego) | `respostaSegura(esquema, dados)` projeta só os campos do esquema zod; segunda checagem bloqueia a resposta inteira se aparecer `senha_*`, `*_hash`, `*_cifrado`, `*_indice`, `mfa_*`, `cpf`, `cns`, binário; lint proíbe `Response.json(linhas)` | S, L | `tests/unit/resposta-api.test.ts` |
| 3 | **Mensagem de erro revela dado** (`duplicate key (email)=(...)`, pilha, SQL) | `respostaDeErro` devolve só código fixo e id de correlação; o log guarda tipo e SQLSTATE, nunca a mensagem | S | `tests/unit/resposta-api.test.ts` |
| 4 | **Existência de registro revelada** ("este CPF existe?", "esta consulta é de outro?") | Login com resposta e tempo idênticos (PR #1); "sem permissão" e "não existe" respondem o mesmo 404; links inválidos por qualquer motivo devolvem o mesmo `null` | S | `autenticacao.test.ts`, `resposta-api.test.ts`, `vazamento.test.ts` |
| 5 | **Enumeração de CPF por servidor ou robô** (varrer a base pela busca de cidadão ou pela recuperação de senha) | Limites por conta e por IP (`POLITICAS` em `src/lib/security/limites.ts`): 60 buscas/h por conta, 3 recuperações/h por CPF, 10/h por IP; chave do limite guarda só resumo SHA-256 | B, S | `vazamento.test.ts` › limite de busca |
| 6 | **Exportação em massa / relatório vazado** | Caminho único `exportar()`: 5 exportações/h por conta → permissão `gestao.exportar` **com MFA** → RLS → teto de 5.000 linhas (recusa, não corta) → colunas tipadas com máscara obrigatória (não existe tipo "CPF completo") → redação de texto livre → auditoria com id → rodapé de rastreio com o mesmo id | B, S | `vazamento.test.ts` › exportação, `exportacao-csv.test.ts` |
| 7 | **Injeção de fórmula em CSV** (`=HYPERLINK(...)` exfiltra a planilha de quem abre) | Células iniciadas em `= + - @ tab CR` recebem apóstrofo; toda célula entre aspas | S | `exportacao-csv.test.ts` |
| 8 | **Log com dado pessoal ou segredo** (Railway é terceiro) | `logInfo`/`logErro` só aceitam campos de uma lista e só primitivos; todo texto passa por `redigir` (CPF, CNS, e-mail, telefone, token, senha, URL com credencial); lint proíbe `console.*(erro|linhas|req|body)` | S, L | `mascaramento-redacao.test.ts` |
| 9 | **Auditoria vira vazamento** | Filtro por nome de chave (PR #1) **e agora por valor**: CPF/e-mail/token dentro de chave inocente é descartado | S | `mascaramento-redacao.test.ts`, `auditoria.test.ts` |
| 10 | **Cache** (proxy, CDN, navegador compartilhado, botão voltar mostra dados de outro) | Middleware põe `Cache-Control: no-store, private` e `Vary: Cookie` em toda resposta dinâmica; downloads e APIs repetem o cabeçalho | H | `env-cabecalhos.test.ts` |
| 11 | **Upload malicioso ou com metadados** (SVG com script, HTML disfarçado de PNG, foto com GPS de quem tirou, arquivo poliglota) | Tipo pelos bytes (só PNG/JPEG, sem SVG); 1 MiB; remoção de EXIF/XMP/IPTC/comentário e chunks de texto PNG; descarte de bytes após o fim da imagem; nome gerado pelo servidor em `tenant/<id>/<categoria>/<uuid>`; servido com `nosniff` e CSP `sandbox` | S, H | `upload-imagem.test.ts` |
| 12 | **Arquivo de outro município** (trocar a chave do objeto na URL) | `chavePertenceAoMunicipio` confere o prefixo antes de servir; bucket privado (sem URL pública) | S, O | `upload-imagem.test.ts` |
| 13 | **Link compartilhado/encaminhado** (e-mail de confirmar, cancelar, recuperar senha) | Token de 256 bits, só o hash no banco; prazo curto por finalidade com **teto imposto pelo banco** (recuperar senha ≤ 1 h); uso único atômico; gatilho impede "reabrir" link usado; a aplicação só pode alterar `usado_em` (privilégio por coluna); preso ao município por RLS; página do link com `Referrer-Policy: no-referrer` | B, S, H | `vazamento.test.ts` › links de ação |
| 14 | **Segredo no repositório** | `.gitignore` de `.env*`; gitleaks no histórico inteiro a cada PR com regras para chaves do sistema, URLs de banco com senha e senhas de `cf_app`/seed | L | CI › job `segredos` |
| 15 | **Credencial administrativa no processo da aplicação** (se a aplicação for invadida, leva junto o dono do banco) | Em produção a aplicação recusa subir com `DATABASE_URL_ADMIN`, `CF_SEED_SENHA` ou `CF_APP_DB_PASSWORD` no ambiente, ou com `DATABASE_URL` que não seja do papel `cf_app` | S | `env-cabecalhos.test.ts` |
| 16 | **Código gerado por IA inseguro** (SQL concatenado, `eval`, HTML bruto) | Lint bloqueia SQL com interpolação **ou concatenação** em `.query()`, `eval`/`new Function`, `dangerouslySetInnerHTML`; CodeQL | L | lint no CI |
| 17 | **Acesso interno abusivo** (servidor consulta quem não atende, por curiosidade ou venda) | Permissão por unidade; limites de volume por conta (#5, #6); auditoria imutável de exportações e ações; documento completo só por revelação individual com motivo (incremento 2, política `revelarDocumento` já definida) | B, S | `vazamento.test.ts`; revelação no incremento 2 |
| 18 | **Backup vazado** | Backups cifrados pelo provedor (Railway); CPF/CNS/MFA cifrados em campo, então um dump sem as chaves não revela documentos; chaves só nas variáveis do Railway, nunca no banco; restauração testada por trimestre | B, O | operacional |
| 19 | **Dados reais em desenvolvimento, preview ou IA** | Seed só fictício e recusa produção; Vercel só com dados fictícios; política proíbe colar dados reais em assistentes | O | `scripts/seed.ts` |
| 20 | **Raspagem por robôs de IA** | Nenhuma listagem pública de pessoas; IDs opacos; `robots.txt` e `X-Robots-Tag: noai`; limites (#5) | H, S | PR #1 |

## 2. Como usar estas barreiras no código

| Para... | Use | Nunca |
|---|---|---|
| devolver dados numa rota | `respostaSegura(Esquema, dados)` | `Response.json(linhas)` |
| devolver erro | `respostaDeErro(erro, rota)` | `erro.message` na resposta |
| registrar no log | `logInfo({...})`, `logErro({ evento }, erro)` | `console.error(erro)` |
| exibir CPF/CNS/telefone/e-mail em lista | `mascararCpf`, `mascararCns`, ... e campo `*_mascarado` | o valor decifrado |
| exportar | `exportar(pedido, { relatorio, colunas, consulta })` | montar CSV na rota |
| buscar cidadão por CPF | `exigirLimite("buscaCidadao", contaId)` antes da busca | busca sem limite |
| receber imagem | `validarELimparImagem` + `chaveDoObjeto` | gravar o arquivo e o nome enviados |
| enviar link por e-mail | `criarLinkAcao` / `consumirLinkAcao` + `CABECALHOS_PAGINA_COM_TOKEN` | token próprio, sem prazo ou reutilizável |

## 3. O que ainda depende de fora do código

1. **Railway:** migrações num serviço/job separado (a aplicação não sobe com `DATABASE_URL_ADMIN`); backups ativos e teste de restauração trimestral; logs com retenção curta.
2. **Bucket de arquivos:** privado, sem listagem, sem URL pública; acesso só pela aplicação.
3. **Borda:** WAF e desafio anti-robô (Cloudflare Turnstile) nas telas públicas de login e agendamento.
4. **Pessoas:** termo de confidencialidade para servidores com acesso a dados; revisão trimestral de quem tem `gestao.exportar` e permissões clínicas.

## 4. Próximos passos (incrementos seguintes)

- Revelação individual de CPF/CNS completo com motivo obrigatório e auditoria de leitura (tabelas do paciente chegam no incremento 2).
- Painel de auditoria com alerta de volume anômalo por conta (muitas buscas, exportações fora do horário).
- Recodificar imagens no servidor (hoje: validação e remoção de metadados, sem recodificação).
- Verificação de senha contra vazamentos conhecidos por k-anonimato.
