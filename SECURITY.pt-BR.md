# Política de segurança

[English](SECURITY.md) · [Português (Brasil)](SECURITY.pt-BR.md) · [Deutsch](SECURITY.de.md) · [Français](SECURITY.fr.md)

## Versão suportada

Correções de segurança são aplicadas ao commit mais recente da `main`. Antes de uma versão estável, commits antigos e forks locais não têm garantia de backport.

## Reportar uma vulnerabilidade

Não divulgue detalhes exploráveis em uma issue pública. Use **Security → Report a vulnerability** quando disponível ou contate o responsável pelo repositório de forma privada pelo GitHub.

Inclua:

- componente e commit afetados;
- passos de reprodução ou prova de conceito mínima;
- impacto esperado e pré-requisitos do ataque;
- se state do scanner, GitHub Checks ou dados do repositório foram expostos;
- mitigação já testada.

Permita tempo para validação antes da divulgação pública. Enquanto o projeto estiver pré-estável, não há SLA de resposta, mas relatórios acionáveis serão priorizados.

## Fronteiras de segurança

- Saída do scanner, findings, caminhos, logs e conteúdo do repositório são entradas não confiáveis.
- O produto é local-first. Dados só deixam a máquina por integração explicitamente solicitada, como GitHub Checks ou workflow com API.
- Falhas operacionais nunca podem virar decisões de segurança aprovadas.
- `OPENAI_API_KEY` é um secret do GitHub Actions. A aplicação verifica a presença, mas não lê nem persiste o valor.
- A exclusão gerenciada pode remover saída local do scan; alvo e efeito devem permanecer explícitos na interface.

Nunca anexe secrets reais, código privado, state completo, bancos ou caminhos pessoais em issues públicas. Redija logs e forneça o menor artefato capaz de reproduzir o problema.
