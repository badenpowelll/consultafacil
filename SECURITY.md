# Segurança

## Como relatar uma vulnerabilidade

Não abra issue pública. Use o relato privado de vulnerabilidades do GitHub (aba **Security → Report a vulnerability**) neste repositório. Respondemos em até 3 dias úteis.

Inclua: o que encontrou, como reproduzir com dados fictícios e o impacto esperado. Não acesse, copie ou altere dados reais de pessoas para demonstrar a falha.

## O que já protege o sistema

Resumo; o detalhe está em [`docs/seguranca/politica-seguranca-informacao.md`](docs/seguranca/politica-seguranca-informacao.md).

- Isolamento entre municípios no banco (RLS forçado), testado no CI.
- Aplicação conecta com papel sem privilégios de dono e sem acesso direto a identidades.
- Sessões opacas e revogáveis; Argon2id; MFA obrigatório para toda a equipe, com anti-reuso.
- Limites de tentativa com bloqueio progressivo (login, recuperação, cadastro, buscas, marcação, exportação).
- Selo anti-robô e campo-isca nos formulários públicos; vigia de volume anormal no worker.
- CPF, CNS e segredos de MFA cifrados (AES-256-GCM) com índice cego para busca.
- Auditoria somente inserção, sem dado pessoal em claro.
- CSP com nonce e cabeçalhos de segurança; CodeQL, gitleaks, `npm audit`, Dependabot e ações do CI fixadas por SHA.
- Sem recurso de modelo de linguagem no produto, logo sem superfície de injeção de prompt.

Nenhum sistema é 100% seguro: estas camadas encarecem e expõem o ataque, e o pentest externo antes de dado real continua obrigatório.
- Barreiras contra vazamento em cada caminho de saída (API, erros, logs, exportações, uploads, links, cache): ver [`docs/seguranca/matriz-vazamento.md`](docs/seguranca/matriz-vazamento.md).
