---
trigger: always_on
description: "Regra de coordenação e delegação entre os custom agents diagnosticador, integracoes e qa-testes no repositório patternspren/whatsapp-bot."
---

# Coordenação da Equipe de Custom Agents (`patternspren/whatsapp-bot`)

Esta regra define como o agente coordenador deve delegar tarefas entre os três Custom Agents do repositório (`.agents/agents/`) e quais limites de segurança e governança são invioláveis.

## Visão Geral da Equipe

| Agente | Modelo | Modo / Política | Especialidade Principal | Pode Editar Código? |
| :--- | :--- | :--- | :--- | :--- |
| `diagnosticador` | `pro` | Somente leitura (`off`) | Análise de causa raiz (RCA), debugging e mapeamento de falhas | **Não** |
| `integracoes` | `pro` | Investigação + aprovação (`off`) | Node.js, Baileys, Gemini API, Google Sheets e Google Cloud | **Somente após aprovação explícita do usuário** |
| `qa-testes` | `flash` | Sandbox (`sandbox`) | Testes `node:test`, regressão, mocks offline, race conditions e evidências | **Apenas arquivos em `test/`** |

---

## Matriz de Decisão: Quando Delegar Cada Tarefa

### 1. Delegar para `diagnosticador`
Acione `diagnosticador` sempre que a demanda exigir entendimento profundo sem risco de alteração no workspace:
- Investigar um bug, erro em runtime, exceção ou comportamento inesperado no bot (extração, confirmação, seleção de linha, menção, reconexão).
- Realizar análise de causa raiz (RCA) entre múltiplos módulos (`index.js`, `gemini_conversation.js`, `alignment_config.js`, `alignment_history.js`, `alignment_measurements.js`, `confirmations.js`).
- Mapear onde uma condição de corrida, perda de estado ou regressão pode ocorrer antes de propor qualquer mudança.
- Auditar lógica de negócios ou fluxo de dados em modo estritamente somente leitura.

### 2. Delegar para `integracoes`
Acione `integracoes` quando a tarefa envolver contratos externos, protocolos, bibliotecas de integração ou infraestrutura GCP:
- Falhas ou melhorias envolvendo **Baileys / WhatsApp** (`makeWASocket`, `useMultiFileAuthState`, `DisconnectReason`, `downloadMediaMessage`, menções, citações, anexos).
- Ajustes de **Gemini API** (`geminiJson`, timeout de `AbortController`, retries, `GEMINI_MODEL`, leitura de anexos e PDFs multi-gerador).
- Ajustes ou investigação em **Google Sheets API** (`loadAlignmentConfig`, `getRecordSchema`, `resolveRecordTarget`, `recordHistory`, `batchUpdate`, `append`, Application Default Credentials).
- Diagnóstico e propostas para **Node.js / Google Cloud / CI-CD** (`docs/ci-cd-setup.md`, `.github/workflows/ci-deploy.yml`, `scripts/deploy-vm.sh`).
- **Exigência obrigatória**: o `integracoes` deve sempre investigar primeiro, apresentar a proposta (arquivos, diff resumido, riscos, rollback e plano de testes) e **obter aprovação explícita do usuário** antes de modificar qualquer código de produção.

### 3. Delegar para `qa-testes`
Acione `qa-testes` quando for necessário provar comportamento, prevenir regressões ou testar concorrência:
- Criar ou atualizar testes automatizados em `test/*.test.js` usando `node:test` e `node:assert/strict`.
- Construir ou ampliar mocks offline (`node:vm`, fakes de Google Sheets, fakes de Gemini/Baileys, diretórios temporários) mantendo `npm test` 100% determinístico e sem chamadas externas.
- Escrever testes para condições de corrida (`serializeConfirmations`, concorrência entre tick de 5 minutos e mensagens/confirmações, duplicidade de `seenIds`, mudança de destino na planilha).
- Executar a suíte de testes e entregar relatório objetivo de evidências (cenários cobertos, arquivos alterados, comando rodado e contagens reais).

---

## Fluxos Recomendados de Handoff

1. **Bug ou incidente reportado**:
   - `diagnosticador` (RCA somente leitura com evidências no código) ->
   - `integracoes` (valida impacto na integração, propõe correção e pede aprovação ao usuário -> implementa após aceite) ->
   - `qa-testes` (cria teste de regressão/concorrência e apresenta evidências com `npm test`).
2. **Melhoria ou ajuste em integração externa (WhatsApp, Gemini, Sheets, GCP)**:
   - `integracoes` (investiga contrato atual, propõe mudança e solicita aprovação -> implementa após aceite) ->
   - `qa-testes` (adiciona mocks de sucesso, falha, timeout e retry + valida suíte completa).
3. **Blindagem de confiabilidade / investigação de race condition**:
   - `diagnosticador` (identifica pontos de concorrência e estados críticos) ->
   - `qa-testes` (reproduz o cenário de forma determinística em `test/` e reporta evidências; se confirmar bug em produção, escala de volta para `integracoes` propor a correção ao usuário).
4. **Regras de delegação e paralelismo**:
   - Informe sempre no prompt do subagente o objetivo exato, os arquivos envolvidos e o critério de conclusão esperado.
   - Investigações somente leitura (`diagnosticador`) podem rodar em paralelo (`workspace: "inherit"`), mas **nunca** execute dois agentes editando os mesmos arquivos simultaneamente.

---

## Guardrails Invioláveis do Repositório

Todos os agentes e o coordenador devem cumprir estas restrições sem exceção:

1. **Nunca modificar a lógica do bot sem aprovação explícita** do usuário.
2. **Nunca acessar, ler, imprimir ou versionar credenciais ou estado operacional**:
   - Proibido ler `.env`, `credentials.json`, `*.service-account.json`, `auth_info_baileys/`, `alignment-sessions.json`, `alignment-confirmations.json`, `pending-alignment.jsonl`, `processed-message-ids.json`, `failed-attachments/`, `feedbacks.json`, `messages-responsable.json` e `disabled_users.json`.
3. **Nunca alterar a branch `master` diretamente**: todo trabalho deve ocorrer em uma branch separada.
4. **Nunca executar deploy** (`scripts/deploy-vm.sh`, `gcloud`, `systemctl` ou reinício da VM `alinhamento-bot`).
5. **Nunca fazer `git push` nem abrir Pull Request** sem aprovação explícita do usuário.
