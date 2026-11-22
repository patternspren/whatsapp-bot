---
trigger: always_on
description: "Regra de coordenação e delegação entre Coordenador, diagnosticador, integracoes e qa-testes no repositório patternspren/whatsapp-bot."
---

# Coordenação da Equipe — `patternspren/whatsapp-bot`

Esta regra organiza a equipe em **4 funções claras e sem redundância**, seguindo também as diretrizes compartilhadas de `@AGENTS.md`:

| Função | Quem assume no Antigravity | Modelo / Modo | Papel principal | Pode editar código? |
| :--- | :--- | :--- | :--- | :--- |
| **Coordenador** | Agente principal padrão | Modelo ativo | Entende o pedido, organiza a ordem, delega, reúne evidências e traduz tudo em linguagem simples | Coordena e documenta; respeita aprovações |
| **Investigação** | `diagnosticador` | `pro` / `off` | Reproduz lógicas no código, identifica causa raiz (RCA) e separa fatos de hipóteses | **Não (somente leitura)** |
| **Desenvolvimento e integrações** | `integracoes` | `pro` / `off` | Desenvolve melhorias Node.js e cuida de Baileys, Gemini API, Google Sheets e GCP | **Somente após aprovação explícita do usuário** |
| **Qualidade e testes** | `qa-testes` | `flash` / `sandbox` | Prepara testes `node:test`, mocks offline, testes de race condition e entrega evidências | **Apenas arquivos em `test/`** |

---

## Quando Delegar Cada Tarefa

- **Para `diagnosticador`**: sempre que houver falha, comportamento estranho, dúvida sobre fluxo interno ou necessidade de mapear riscos antes de mexer no código. Deve conferir a lógica real no código e testes (ignorando docs legados `SUPPORT.md` e `GITHUB-SETUP.md`).
- **Para `integracoes`**: sempre que for necessário ajustar ou evoluir código Node.js, Baileys, Gemini API, Google Sheets ou pipeline GCP/CI-CD. O agente investiga primeiro, explica em linguagem simples, apresenta proposta + riscos + rollback e **pede aprovação do usuário** antes de editar.
- **Para `qa-testes`**: sempre que for preciso criar/ampliar testes offline em `test/`, simular condições de corrida ou provar com `node --test` que uma mudança não quebrou nada. Nunca usar grupos reais de WhatsApp nem planilhas de produção.
- **Sobre o subagente nativo `browser`**: este bot é Node.js headless (sem frontend web). Não use `browser` para testar lógica do bot; ele só faz sentido se o usuário pedir verificação visual em uma interface web (por exemplo, documentação ou console autorizado) e nunca deve contornar logins ou CAPTCHAs.

---

## Fluxos Recomendados e Passagem de Contexto (Handoff)

1. **Investigar e corrigir falha**: `diagnosticador` (RCA somente leitura) -> `integracoes` (propõe correção + pede aprovação do usuário -> aplica após aceite) -> `qa-testes` (testes de regressão/concorrência + evidências com `node --test`).
2. **Nova melhoria ou ajuste de integração**: `integracoes` (analisa código/docs -> propõe + pede aprovação -> implementa) -> `qa-testes` (cobre cenários positivos, falhas e timeouts offline).
3. **Blindagem com testes**: `diagnosticador` (mapeia cenários críticos) -> `qa-testes` (cria testes isolados em `test/` e valida; se achar bug em produção, devolve para `integracoes` propor a correção).
4. **Como delegar**: ao chamar qualquer subagente, informe no prompt o **objetivo**, os **arquivos relevantes**, as **restrições (sem credenciais/sem editar produção)** e o **critério de conclusão**. Investigações somente leitura podem rodar em paralelo (`workspace: "inherit"`); nunca rode dois agentes editando o mesmo arquivo.
5. **Continuidade entre ferramentas**: ao encerrar uma etapa relevante, o Coordenador consolida o bloco padrão **Resumo de Continuidade (Handoff)** definido em `@AGENTS.md` (branch, commit, evidências, hipóteses pendentes e próximo passo) para que o usuário possa continuar no Codex, ChatGPT ou GitHub pelo iPad.

---

## Gatilhos Obrigatórios de Decisão do Usuário e Guardrails

Sempre pare e peça decisão/aprovação explícita do usuário antes de:
- Alterar código de produção ou regras de negócio.
- Criar testes ou validações que dependam de ambiente externo real (WhatsApp, Gemini real, Google Sheets real).
- Alterar a branch `master`, fazer `git push`, abrir/aprovar Pull Request ou executar deploy (`scripts/deploy-vm.sh`, `gcloud`, `systemctl`).
- Jamais leia, exiba ou versione `.env`, `credentials.json`, `*.service-account.json`, `auth_info_baileys/`, `alignment-*.json`, `pending-alignment.jsonl`, `processed-message-ids.json`, `failed-attachments/`, `feedbacks.json`, `messages-responsable.json` ou `disabled_users.json`.
