# whatsapp-bot-alignment

Bot de WhatsApp que só inicia a análise quando alguém menciona o bot em um grupo. O Gemini interpreta mensagens, relatórios e imagens. Após a escolha da aba, o bot grava os dados válidos e pede os campos que ainda faltam.

## Funcionamento

- Antes da menção, o bot mantém em memória uma janela das mensagens recentes para usar como contexto quando for chamado. Depois da menção, acompanha aquele grupo por até duas horas. As sessões, filas de processamento e histórico de confirmações são isolados por grupo.
- O Gemini considera o texto, o título do grupo, a taxonomia, o glossário e as combinações de máquinas da planilha de configuração (recarregadas periodicamente).
- Anexos JPEG, PNG, WebP e PDF (inclusive quando enviados como `application/octet-stream` com extensão `.pdf`) são enviados ao Gemini para leitura. Relatórios com vários equipamentos geram uma proposta para cada equipamento. Anexos acima de 20 MB ou em formatos não suportados ficam pendentes para revisão.
- PDFs com vários geradores recebem uma segunda leitura focada no GAP final de cada conjunto. Folga do virabrequim, pré-GAP e valores anteriores ao alinhamento não entram na coluna `Coupling GAP`.
- Após identificar um alinhamento, o bot consulta as abas atuais e pede que alguém escolha o destino antes da primeira gravação. As listas interativas têm até dez opções; também é possível responder à mensagem numerada quando a lista não aparecer. A escolha fica associada ao alinhamento.
- Com a aba escolhida e a linha identificada, o bot grava os dados válidos e informa os campos obrigatórios ainda faltantes. Para corrigir ou completar campos, use o formato `Axial Vertical: -0,01 mm`, respondendo à mensagem do equipamento quando houver vários alinhamentos abertos.
- Uma divergência entre legenda e imagem fica pendente até receber o valor correto. Qualquer participante pode selecionar ou corrigir, salvo quando `AUTHORIZED_APPROVERS` estiver configurada ou `RESTRICT_CONFIRMATION_TO_REQUESTER=true`. A gravação é verificada na planilha.
- Se embarcação ou equipamento ainda estiverem como `não informado`, o bot pede esses dados e não grava até poder identificar o registro com segurança.
- O mesmo equipamento na mesma embarcação usa a linha existente, inclusive depois de duas horas. Se houver várias linhas históricas, a sessão ou uma data completa e única identifica a linha. Se o destino ficar ambíguo, ou mudar após a conferência, o bot pede nova validação antes de gravar.
- Equipamentos diferentes podem ser registrados em sequência, cada um com sua própria seleção de aba.
- Tolerâncias e medições são extraídas separadamente. O código não calcula valores nem conclui aceitabilidade sem dados compatíveis.

## Planilhas e permissões

- **Registros:** planilha de alinhamentos; definir o ID em `SPREADSHEET_ID`. As abas são consultadas diretamente na planilha.
- **Referências:** planilha de configuração, abas `Taxonomia`, `Glossario`, `Configurações` e `Masterlist`; definir o ID em `CONFIG_SPREADSHEET_ID`.
- A conta de serviço precisa de leitura na planilha de referências e edição na planilha de registros. Na VM, o Google Sheets usa Application Default Credentials da conta anexada; não use chaves privadas no repositório.
- `GEMINI_API_KEY` deve vir do ambiente ou do gerenciador de segredos. Nunca registre a chave nos logs.

Os cabeçalhos ocupam as linhas 1 e 2 e incluem grupos de colunas. O mapeamento considera o título e o grupo, inclusive para `Maker`, `Model` e `Equipment Class` repetidos. `Comments` guarda observações, identificadores de sessão e de confirmação, e o horário de inclusão de linhas novas. A coluna U, se vazia ou com o cabeçalho `Nome do grupo whatsapp`, recebe o nome do grupo obtido dos metadados do WhatsApp. Se o nome não estiver disponível, a coluna não é atualizada e o grupo é avisado; se U tiver outro cabeçalho, a gravação é bloqueada.

## Configuração

Variáveis obrigatórias:

```env
SPREADSHEET_ID=1oc2u-thAhflrqEb3m6hxux8Yg6jEE6wGY-zFQyBRR38
CONFIG_SPREADSHEET_ID=ID_DA_PLANILHA_DE_REFERENCIAS
GEMINI_CONVERSATION_ENABLED=true
GEMINI_API_KEY=CHAVE_FORNECIDA_PELO_AMBIENTE
GEMINI_MODEL=gemini-3.1-flash-lite
# Opcionais:
# AUTHORIZED_APPROVERS=5521999990000,outro@s.whatsapp.net
# ALLOWED_GROUP_JIDS=120363000000000000@g.us
```

Execute `npm install` e depois `npm start`. O serviço de produção é gerenciado por systemd na VM `alinhamento-bot`.

## Privacidade e operação

IDs processados, sessões, propostas e pendências ficam em arquivos locais privados. `alignment-sessions.json`, `alignment-confirmations.json` e `pending-alignment.jsonl` podem conter conteúdo operacional; mantenha-os fora do Git e com acesso restrito. O bot envia mensagens somente depois de ser mencionado: primeiro pede a escolha da aba e, em seguida, informa o resultado da gravação.

## Verificação

Rode `npm test` para verificar a confirmação completa, o destino da gravação, a ativação por menção e o registro sequencial de equipamentos. Use um grupo de teste e dados fictícios para conferir a operação no WhatsApp e no Google Sheets.

## Grupos e abas de registros

Com `ALLOWED_GROUP_JIDS` vazio, o bot aceita menções em qualquer grupo; preenchida, a variável restringe o atendimento aos grupos listados. As sessões e respostas são isoladas por grupo.

A planilha de registros pode ter uma aba por família de equipamento. A pessoa escolhe uma das abas retornadas pela planilha, mesmo quando existe apenas uma. Cada novo alinhamento com data completa diferente é registrado em uma nova linha; respostas posteriores à mesma sessão atualizam a linha já criada na aba escolhida.
