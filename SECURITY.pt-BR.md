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
- O produto é local-first. Iniciar um scan autoriza explicitamente a conexão selecionada a receber os prompts e as evidências limitadas do repositório exigidas pela metodologia. Publicar no GitHub continua sendo uma ação separada.
- Falhas operacionais nunca podem virar decisões de segurança aprovadas.
- Secrets de providers e tokens OAuth são write-only na API local e ficam no cofre de credenciais do sistema operacional. O SQLite guarda apenas referências opacas e os DTOs públicos nunca retornam credenciais.
- Manifests, telemetria, SSE e logs persistidos passam pela fronteira compartilhada de redação. Processos locais por assinatura recebem um ambiente mínimo.
- Endpoints compatíveis customizados são configuração não confiável. A tupla persistida exata de conexão, modelo e protocolo precisa passar pelas validações de URL, transporte, redirect, tamanho e capacidade antes de liberar esse modelo para scan; o Sentinel não substitui silenciosamente a tupla.
- A exclusão gerenciada só está disponível para scans terminalizados. Ela pode remover o registro local e um diretório de artefatos gerenciado pelo Sentinel, mas nunca o repositório analisado ou um caminho externo; alvo e efeito devem permanecer explícitos na interface.

Nunca anexe secrets reais, código privado, state completo, bancos ou caminhos pessoais em issues públicas. Redija logs e forneça o menor artefato capaz de reproduzir o problema.
