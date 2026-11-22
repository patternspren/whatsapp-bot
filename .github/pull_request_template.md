## Resumo simples (para revisão rápida)

<!-- Explique em 2 a 4 frases simples o que mudou e por que essa mudança é necessária. -->

## Causa raiz / Evidências

<!-- Liste os arquivos e funções verificados e, quando aplicável, o que foi confirmado vs o que era hipótese. -->
- Arquivos verificados:
- Evidência principal:

## Testes realizados

<!-- Confirme que os testes rodaram offline/isolados e informe a saída real. -->
- Comando executado: `npm test` (ou `node --test`)
- Resultado observado:
- Isolamento: testes 100% offline com mocks, sem grupos reais do WhatsApp ou planilhas de produção.

## Riscos e plano de rollback

- Impacto esperado:
- Como reverter com segurança: `git revert <commit>` (ou reaprovação da versão anterior via workflow de deploy).

## Checklist de segurança

- [ ] Nenhuma credencial ou arquivo operacional incluído (`.env`, `credentials.json`, `auth_info_baileys/`, `alignment-*.json`, `pending-alignment.jsonl`)
- [ ] Testes `node --test` passando offline
- [ ] Sem alterações não solicitadas na lógica de produção
- [ ] Pronto para revisão humana (merge na `master` ainda exigirá aprovação manual do deploy no ambiente `production`)

## Continuidade (Antigravity / Codex)

- **Branch / origem**:
- **Próximo passo após aprovação**:
- **Pendências ou decisões em aberto**:
