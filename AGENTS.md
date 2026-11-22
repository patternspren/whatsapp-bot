# Guia Compartilhado do Repositório — `patternspren/whatsapp-bot`

Este arquivo orienta **Google Antigravity**, **OpenAI Codex** e colaboradores que trabalham neste repositório, mantendo continuidade simples mesmo quando o acompanhamento acontece remotamente pelo GitHub (incluindo iPad).

## 1. Sobre o Projeto

- **Objetivo**: bot de WhatsApp que aguarda menção explícita em um grupo, reúne o contexto recente, interpreta mensagens e anexos (imagens/PDFs) usando a Gemini API, publica uma mensagem de conferência no grupo e, somente após aprovação explícita (`confirmo` / `confirmado`) por participante autorizado (`AUTHORIZED_APPROVERS` ou solicitante original), grava ou atualiza registros na aba `Modelo alinhamento` do Google Sheets com verificação pós-gravação.
- **Execução em produção**: VM Compute Engine `alinhamento-bot` (Debian 13, Node.js, serviço systemd `alinhamento-bot.service`), usando Application Default Credentials (ADC) e deploy automatizado via GitHub Actions após aprovação no ambiente `production`.

## 2. Fontes de Verdade vs Documentação Legada

Sempre confira o comportamento real no código e nos testes antes de assumir qualquer regra de negócio:

- **Fontes de verdade atuais**:
  - Código principal: `index.js`, `gemini_conversation.js`, `alignment_config.js`, `alignment_history.js`, `alignment_measurements.js`, `confirmations.js`.
  - Testes automatizados: `test/*.test.js` (`package.json` usa `node --test`, incluindo `test/e2e_virtual_flow.test.js` e `test/qa_realistic_sheet_flow.test.js`).
  - Documentação e deploy atuais: `README.md`, `docs/ci-cd-setup.md`, `.github/workflows/ci-deploy.yml`, `scripts/deploy-vm.sh`.
- **Documentação legada (NÃO usar como especificação do bot atual)**:
  - `SUPPORT.md` e `GITHUB-SETUP.md` pertencem a um projeto antigo em francês ("Bot WhatsApp École IGA") e citam arquivos inexistentes aqui (`config.json`, `blacklist.json`, `credentials.json`).
  - `QUICK-START.md` possui trechos desatualizados (como timeout de 15 minutos, enquanto `index.js` usa `GROUP_ARM_WINDOW_MS = 2 * 60 * 60 * 1000`). Em qualquer divergência, confie no código e no `README.md`.

## 3. Como Trabalhar com o Proprietário

1. **Causa raiz antes de correções superficiais**: investigue o fluxo completo, identifique onde a falha nasce e apresente evidências concretas (arquivo, função, linha, saída de teste ou log). Trate relatos de clientes como evidência do sintoma observado, sem presumir a causa antes de investigar.
2. **Fatos vs hipóteses**: nunca apresente uma suposição como fato verificado. Separe claramente o que foi lido/testado do que ainda é hipótese.
3. **Linguagem simples e acessível**: comece explicando o diagnóstico, a proposta ou o resultado em português claro (sem pressupor experiência avançada em programação) antes de entrar nos detalhes técnicos.
4. **Autonomia com segurança**: investigue, leia arquivos e rode testes offline com autonomia; pare e peça decisão humana apenas quando envolver escolha de regra de negócio, risco relevante, alteração de código de produção, teste em ambiente real, mudança de branch/PR ou deploy.
5. **Sem suposições entre ferramentas**: não presuma que skills, memórias ou regras configuradas no ChatGPT, no Codex (`~/.codex/`) ou no Antigravity (`.agents/`) sejam compartilhadas automaticamente entre si.

## 4. Continuidade (Antigravity <-> Codex <-> ChatGPT <-> GitHub)

- **Nunca trabalhe diretamente na branch `master`**: crie ou continue em uma branch separada com commits pequenos, claros e focados.
- **Resumo de Continuidade (Handoff)**: ao concluir qualquer etapa relevante (investigação, implementação, revisão ou testes), entregue ao final o bloco abaixo pronto para copiar e colar em outra ferramenta ou PR:

```markdown
### Resumo de Continuidade (Handoff)
- **Branch e commit**: `<branch>` (`<sha>`)
- **O que foi feito**: <resumo objetivo em linguagem simples>
- **Evidências e testes**: <arquivos verificados + comando rodado + resultado>
- **Decisões tomadas e hipóteses pendentes**: <fatos confirmados vs pontos em aberto>
- **Próximo passo sugerido**: <ação exata recomendada para o próximo agente/ferramenta>
```

### Papéis especializados do projeto (Antigravity e Codex)

No Google Antigravity, os arquivos em `.agents/agents/` funcionam como Custom Agents nativos. No **Codex** (ou em qualquer outro assistente que leia este repositório), quando o usuário mencionar um dos papéis abaixo pelo nome, leia o arquivo Markdown correspondente e siga seu escopo, checklist e limites (usando as ferramentas disponíveis no ambiente atual):

- **`diagnosticador`** -> `.agents/agents/diagnosticador.md` (investigação de causa raiz em modo somente leitura, sem editar arquivos).
- **`integracoes`** -> `.agents/agents/integracoes.md` (desenvolvimento Node.js e integrações Baileys, Gemini, Google Sheets e GCP; propor e aguardar aprovação explícita antes de alterar código).
- **`qa-testes`** -> `.agents/agents/qa-testes.md` (simulações quase reais ponta a ponta em `test/`, auditoria célula a célula na aba `Modelo alinhamento` e evidências com `node --test`).

## 5. Validação Padrão Offline

- Execute `npm test` (ou `node --test`).
- A suíte atual usa `node:test`, `node:assert/strict`, `node:vm` e mocks em memória para rodar **100% offline** sem tocar em WhatsApp real, Gemini API, Google Sheets ou Google Cloud.
- Nunca crie testes que dependam de grupos reais de WhatsApp, planilhas de produção ou chaves reais sem autorização explícita e ambiente de teste isolado.

## 6. Regras Invioláveis de Segurança e Operação

- **Zero acesso a credenciais e dados operacionais**: nunca leia, exiba, copie ou versione `.env`, `credentials.json`, `*.service-account.json`, `auth_info_baileys/`, `alignment-sessions.json`, `alignment-confirmations.json`, `pending-alignment.jsonl`, `processed-message-ids.json`, `failed-attachments/`, `feedbacks.json`, `messages-responsable.json` ou `disabled_users.json`.
- **Sem edição não aprovada na lógica de produção**: não altere arquivos de produção ou regras de negócio sem aprovação explícita do proprietário.
- **Sem deploy ou push automático**: nunca execute `scripts/deploy-vm.sh`, `gcloud`, `systemctl`, `git push` ou abertura/merge de Pull Request sem aprovação explícita.
