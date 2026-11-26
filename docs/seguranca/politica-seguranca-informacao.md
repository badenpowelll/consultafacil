# Política de Segurança da Informação — Consulta Fácil 2.0

Versão 1.0 · 23/11/2026 · Responsável: gestão do projeto (Baden)

Esta política vale para o código, a infraestrutura (Railway em produção, Vercel só para previews com dados fictícios), as pessoas que desenvolvem e operam o sistema e as ferramentas de IA usadas no desenvolvimento. Ela segue a LGPD (Lei 13.709/2018, com atenção ao art. 11 sobre dados de saúde), o modelo de controles da ABNT NBR ISO/IEC 27001:2022 e as listas OWASP Top 10 (web), OWASP API Security Top 10 e OWASP Top 10 para Aplicações com LLM.

## 1. Princípios

1. **Falha fechada.** Na dúvida, o sistema nega. Sem município no contexto, o banco não devolve nenhuma linha.
2. **Defesa em profundidade.** Cada controle supõe que o anterior pode falhar: tela, rota, serviço e banco verificam de novo.
3. **Menor privilégio.** A aplicação conecta com o papel `cf_app`, que não é dono de nada, não ignora RLS e não lê tabelas de identidade diretamente.
4. **Mínimo de dados.** Coletamos só o necessário para agendar. CPF e CNS ficam cifrados; a busca usa índice cego.
5. **Rastreabilidade.** Toda ação administrativa e todo acesso a dado sensível geram registro de auditoria imutável, sem dado pessoal em claro.

## 2. Classificação dos dados

| Classe | Exemplos | Regras |
|---|---|---|
| Sensível (saúde) | observações clínicas, triagem, motivo de consulta | cifrado em campo, permissão clínica explícita, MFA obrigatório, auditoria de leitura |
| Pessoal | nome, CPF, CNS, telefone, e-mail, nascimento | CPF/CNS cifrados com índice cego; nunca em log, URL, auditoria ou mensagem de erro |
| Interno | agendas, escalas, perfis, auditoria | isolado por município (RLS forçado) |
| Público | nome e identidade visual do município | pode ser exibido sem login |

## 3. Ameaças com IA e respostas

A IA barateou ataques que antes exigiam esforço humano. O sistema parte do princípio de que o atacante tem agentes automatizados, persistentes e capazes de imitar pessoas.

**Nenhum sistema é 100% seguro.** Os controles abaixo encarecem e tornam visível o ataque automatizado; não o tornam impossível. Por isso há camadas (borda, aplicação, banco), detecção, resposta a incidentes (seção 8) e pentest externo antes de qualquer dado real.

| Ameaça | Como aparece | Controles |
|---|---|---|
| Credential stuffing e força bruta automatizados | agentes testam listas de senhas vazadas em escala, trocando IP | limite por IP e por CPF no banco (`app.limite_consumir`) com **bloqueio progressivo**: cada novo estouro em 24 h dobra o tempo de bloqueio, até 24 h, e tentativas durante o bloqueio não passam nem contam (migração 0012); resposta e tempo idênticos para CPF inexistente e senha errada; Argon2id; **MFA TOTP obrigatório para toda conta da equipe e da gestão** (sem MFA na sessão, nenhuma permissão de equipe vale); selo assinado e campo-isca nos formulários públicos; recomendação de WAF e desafio anti-robô (Cloudflare Turnstile) na borda |
| Robôs que tomam vagas | scripts reservam vagas em massa para revender ou sabotar | limite de consultas futuras por pessoa (incremento 2); teto de marcações, remarcações e desmarcações por conta por hora, com bloqueio progressivo; confirmação por link de uso único; auditoria de padrões; bloqueio de conta com motivo (`scripts/municipio.ts bloquear-conta`) |
| Raspagem de dados (scraping) | agentes percorrem páginas e APIs para montar bases | nenhuma listagem pública de pessoas; IDs opacos (UUID); paginação limitada; teto de buscas de vagas por conta e de buscas de cidadão por servidor; vigia de segurança no worker que registra na auditoria conta com volume anormal (mais de 300 ações em 10 min) e loga `alerta.seguranca` em início de bloqueios em massa; `robots.txt` e `X-Robots-Tag: noai` (sinal, não barreira); RLS impede leitura entre municípios mesmo com sessão válida |
| Enumeração de cadastros | perguntar "este CPF existe?" | respostas uniformes; recuperação de senha sempre responde igual |
| Robôs em formulários públicos | agentes preenchem cadastro, login e recuperação em massa | selo HMAC emitido pela página (vale 2 h, não pode ser forjado nem reaproveitado com outro horário), campo-isca invisível, tempo mínimo de preenchimento no cadastro e na recuperação; recusa com a mesma resposta de erro comum, para o robô não aprender; limite por IP |
| Phishing e engenharia social gerados por IA | e-mails e mensagens convincentes imitando a prefeitura | MFA; sessões revogáveis; links de ação de uso único e prazo curto; o sistema nunca pede senha por e-mail ou WhatsApp; orientação aos servidores |
| Deepfake de voz/vídeo pedindo acesso | "sou o secretário, libere meu acesso" | concessão de permissão só pelo sistema, por gestor autenticado com MFA, sempre auditada; nenhum acesso concedido por telefone |
| Injeção de prompt | texto do usuário ou de documento manipula um modelo de linguagem | **o produto não tem nenhum recurso com modelo de linguagem, então não há superfície de injeção de prompt hoje**; qualquer recurso futuro segue a seção 5 |
| Pacotes alucinados e cadeia de suprimentos | IA sugere pacote inexistente que um atacante registra ("slopsquatting") | versões exatas, lockfile, `npm ci`, `--ignore-scripts` no CI, Dependabot com espera de 7 dias (npm e GitHub Actions), ações do CI fixadas por SHA de commit, `npm audit` sem nenhuma vulnerabilidade conhecida, revisão humana de toda dependência nova (seção 6) |
| Código inseguro gerado por IA | SQL montado por concatenação, verificação de permissão esquecida | lint bloqueia SQL interpolado; RLS garante isolamento mesmo se a rota esquecer; testes de isolamento obrigatórios no CI; CodeQL; revisão humana |
| Vazamento de dados para ferramentas de IA | colar dados reais ou segredos num assistente | proibido (seção 6) |

## 4. Controles técnicos obrigatórios

**Identidade e sessão.** Senhas com Argon2id (mínimo 12 caracteres, lista de senhas óbvias). MFA TOTP obrigatório para gestor, Super Admin e qualquer permissão clínica; o mesmo código não vale duas vezes. Sessão é um identificador opaco de 256 bits em cookie `__Host-` (HttpOnly, Secure, SameSite=Lax); o banco guarda só o SHA-256. Expira por inatividade (30 min) e por prazo absoluto (12 h). Troca de senha, bloqueio de conta e suspensão de município revogam sessões na hora.

**Autorização.** Sessão válida → município escolhido → vínculo ativo → permissão no escopo (município ou unidade). Verificada no servidor em toda requisição. Permissões clínicas só existem em perfis atribuídos e exigem registro profissional.

**Isolamento entre municípios.** Toda tabela municipal tem `tenant_id`, RLS forçado e chaves estrangeiras compostas. O contexto vale só dentro da transação (`set_config(..., true)`). A única ponte entre municípios é a tabela de ocupação, que responde apenas "livre" ou "conflito".

**Criptografia.** TLS em todo tráfego (HSTS). CPF, CNS e segredos de MFA com AES-256-GCM, chave versionada e contexto do campo como dado autenticado. Índice cego HMAC-SHA-256 com chave separada.

**Aplicação web.** CSP com nonce por requisição, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP. Cabeçalhos internos `x-cf-*` vindos do cliente são descartados. Só consultas parametrizadas.

**Prevenção de vazamento.** Cada caminho de saída de dados (respostas de API, erros, logs, exportações, uploads, links por e-mail, cache, backups) tem barreiras em camadas descritas em [`matriz-vazamento.md`](matriz-vazamento.md), com o teste que prova cada uma.

**Auditoria.** Tabela somente inserção (gatilhos bloqueiam UPDATE, DELETE e TRUNCATE; a aplicação não tem esses privilégios). Detalhes passam por filtro que remove dado pessoal.

## 5. Uso de IA dentro do produto (quando existir)

Nenhum recurso de IA faz parte do piloto. Antes de existir algum, ele precisa cumprir:

1. O modelo não recebe CPF, CNS, nome completo ou dado clínico identificável sem base legal registrada e contrato com o fornecedor que proíba treinamento e retenção.
2. Todo texto vindo de usuário, documento ou e-mail é **dado, não instrução**: fica delimitado no prompt e nunca muda permissões.
3. O modelo não executa ações. Ele sugere; uma pessoa com permissão confirma pela interface normal, que passa pelas mesmas verificações e auditoria.
4. As ferramentas expostas ao modelo usam a sessão do próprio usuário, nunca uma credencial de serviço com mais acesso.
5. Saídas do modelo são escapadas antes de exibir e nunca viram SQL, HTML bruto ou comando.
6. Limite de uso por conta e registro de cada chamada (sem o conteúdo pessoal).

## 6. Desenvolvimento assistido por IA

1. **Nada real para a IA.** É proibido colar em qualquer assistente dados reais de pacientes, servidores, credenciais, chaves, cadeias de conexão ou conteúdo do sistema antigo. Usamos só dados fictícios.
2. **Revisão humana obrigatória.** Todo código gerado por IA entra por pull request revisado por uma pessoa antes do merge. A IA não aprova nem faz merge.
3. **Dependências.** Antes de adicionar um pacote: conferir que existe há tempo, tem mantenedores e downloads reais, e que o nome não é variação de um pacote conhecido. Versão exata no `package.json`; o lockfile entra no commit.
4. **Segredos.** Ficam só nas variáveis do Railway e do GitHub. O CI roda gitleaks no histórico; um segredo encontrado é tratado como vazado e trocado, mesmo que o commit seja removido.
5. **Testes de isolamento.** Mudança em tabela municipal precisa de teste que prove que outro município não lê nem grava.

## 7. Gestão de chaves e segredos

| Segredo | Onde fica | Rotação |
|---|---|---|
| Chaves de dados (`CF_CHAVES_DADOS`) | variável do Railway | anual ou em incidente: nova versão, recifragem em lote, remoção da antiga |
| Chave de índice (`CF_CHAVE_INDICE`) | variável do Railway | só em incidente (exige recalcular índices) |
| Senha de `cf_app` | variável do Railway | semestral ou em incidente |
| Credencial administrativa do banco | só no ambiente de migração | nunca na aplicação |

Backups do banco são cifrados pelo provedor e testados com restauração trimestral.

## 8. Resposta a incidentes

1. **Detectar e conter (até 1 h):** revogar sessões afetadas (`app.sessao_revogar_conta` ou `municipio_alterar_estado`), bloquear contas, trocar segredos expostos.
2. **Avaliar (até 24 h):** usar a auditoria para saber o que foi acessado, por quem e em qual município.
3. **Comunicar:** havendo risco ou dano relevante aos titulares, o controlador (o município) comunica a ANPD e os titulares no prazo do Regulamento de Comunicação de Incidentes (Resolução CD/ANPD nº 15/2024: 3 dias úteis). Nós apoiamos o município com os fatos.
4. **Corrigir e aprender:** registro do incidente, causa e mudança aplicada em `docs/seguranca/incidentes/`.

Vulnerabilidades podem ser relatadas como descrito em `SECURITY.md`.

## 9. Revisão

Esta política é revista a cada incremento e sempre que surgir uma nova classe de ameaça. Mudanças passam por pull request.
