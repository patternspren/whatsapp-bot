const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { loadAlignmentConfig, rowsAsObjects } = require('../alignment_config');
const { resolveRecordTarget, recordHistory } = require('../alignment_history');
const { verifyExtraction } = require('../gemini_conversation');

function createVirtualSheets(initialRows = null) {
  const heads = [
    ['Drive Machine', '', '', 'Histórico', '', '', '', '', '', '', '', 'Reference'],
    ['Vessel', 'Equipment / Tag', 'Maker', 'Data', 'Motivação', 'Executor', 'Axial Vertical', 'Axial Horizontal', 'Radial Vertical', 'Radial Horizontal', 'Coupling GAP', 'Comments']
  ];
  const rows = initialRows ? initialRows.map(r => [...r]) : heads.map(r => [...r]);
  const colToIndex = col => {
    let idx = 0;
    for (const ch of col) idx = idx * 26 + (ch.charCodeAt(0) - 64);
    return idx - 1;
  };
  const indexToCol = idx => {
    let n = idx + 1;
    let out = '';
    while (n > 0) {
      const rem = (n - 1) % 26;
      out = String.fromCharCode(65 + rem) + out;
      n = Math.floor((n - 1) / 26);
    }
    return out;
  };

  const configTabs = {
    Taxonomia: [['Taxonomia'], ['Motor Diesel'], ['Propulsão']],
    Glossario: [['Termo', 'Significado'], ['MCP', 'Motor de Combustão Principal'], ['Bordo', 'Lado da embarcação'], ['BB', 'Bombordo']],
    'Configurações': [['Maquina a ser alinhada / Drive Machine'], ['Motor Diesel / Gerador']],
    masterlist: [['', 'Navio'], ['Nome', 'Operação'], ['BRAM Atlas', 'PSV'], ['BRAM Breeze', 'PSV']]
  };

  const sheets = {
    spreadsheets: {
      get: async ({ spreadsheetId }) => {
        if (spreadsheetId === 'config-id') {
          return { data: { sheets: Object.keys(configTabs).map(title => ({ properties: { title } })) } };
        }
        return { data: { sheets: [{ properties: { title: 'Modelo alinhamento' } }] } };
      },
      values: {
        get: async ({ spreadsheetId, range }) => {
          if (spreadsheetId === 'config-id') {
            const tabMatch = range.match(/^'([^']+)'!/);
            const tabName = tabMatch ? tabMatch[1].replace(/''/g, "'") : '';
            return { data: { values: configTabs[tabName] || [] } };
          }
          if (range.endsWith('!A1:ZZ2')) {
            return { data: { values: rows.slice(0, 2) } };
          }
          return { data: { values: rows.map(r => [...r]) } };
        },
        append: async ({ range, valueInputOption, insertDataOption, requestBody }) => {
          assert.equal(valueInputOption, 'RAW');
          assert.equal(insertDataOption, 'INSERT_ROWS');
          const startColMatch = range.match(/!([A-Z]+)\d+/);
          const startCol = startColMatch ? colToIndex(startColMatch[1]) : 0;
          const width = rows[1].length;
          const newRow = Array(width).fill('');
          const incoming = requestBody.values[0];
          for (let i = 0; i < incoming.length; i++) {
            newRow[startCol + i] = incoming[i];
          }
          rows.push(newRow);
          const endCol = indexToCol(startCol + incoming.length - 1);
          const startLetter = indexToCol(startCol);
          return {
            data: {
              updates: {
                updatedRange: `'Modelo alinhamento'!${startLetter}${rows.length}:${endCol}${rows.length}`
              }
            }
          };
        },
        batchUpdate: async ({ requestBody }) => {
          assert.equal(requestBody.valueInputOption, 'RAW');
          for (const item of requestBody.data) {
            const m = item.range.match(/!([A-Z]+)(\d+)$/);
            assert.ok(m, `Invalid range ${item.range}`);
            const col = colToIndex(m[1]);
            const row = Number(m[2]) - 1;
            while (rows[row].length <= col) rows[row].push('');
            rows[row][col] = item.values[0][0];
          }
        }
      }
    }
  };
  return { sheets, rows, configTabs };
}

function bootVirtualBot({ env = {}, fetchHandler, sheets, initialRows = null, baileysOverride = null }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpp-e2e-'));
  const virtualSheets = sheets ? { sheets, rows: initialRows } : createVirtualSheets(initialRows);
  const sentMessages = [];
  const consoleErrors = [];
  let messageSeq = 0;
  const origFetch = global.fetch;
  global.fetch = fetchHandler;

  const sock = {
    user: { id: '5511999990000:1@s.whatsapp.net', lid: '999888777:2@lid' },
    groupMetadata: async (jid) => ({
      subject: jid === 'grupo-breeze@g.us' ? 'BRAM Breeze' : 'BRAM Atlas'
    }),
    sendMessage: async (group, message) => {
      messageSeq += 1;
      const id = `bot-msg-${messageSeq}`;
      sentMessages.push({ group, id, ...message });
      return { key: { id, remoteJid: group } };
    },
    updateMediaMessage: async (msg) => msg
  };

  const events = {};
  const fakeBaileys = baileysOverride || {
    default: () => ({
      ...sock,
      ev: {
        on: (name, fn) => { events[name] = fn; },
        removeAllListeners: () => {}
      },
      end: () => {}
    }),
    useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => {} }),
    DisconnectReason: { loggedOut: 401 },
    downloadMediaMessage: async (msg) => Buffer.from(msg._mockBuffer || 'mock-binary')
  };

  const repoRoot = path.resolve(__dirname, '..');
  const source = fs.readFileSync(path.join(repoRoot, 'index.js'), 'utf8');
  const endMarker = "console.log('Iniciando coletor silencioso de mensagens de alinhamento...');";
  const cut = source.indexOf(endMarker);
  assert.ok(cut > 0);

  const timers = [];
  const context = {
    require: (name) => {
      if (name === '@whiskeysockets/baileys') return fakeBaileys;
      if (name === 'qrcode-terminal') return { generate() {} };
      if (name === 'pino') return () => ({});
      if (name === 'googleapis') {
        return {
          google: {
            options() {},
            auth: { GoogleAuth: class {} },
            sheets: () => virtualSheets.sheets
          }
        };
      }
      if (name.startsWith('./')) return require(path.join(repoRoot, name));
      return require(name);
    },
    __dirname: tmpDir,
    Buffer,
    process: {
      env: {
        SPREADSHEET_ID: 'records-id',
        CONFIG_SPREADSHEET_ID: 'config-id',
        GEMINI_API_KEY: 'test-gemini-key',
        GEMINI_CONVERSATION_ENABLED: 'true',
        GEMINI_MODEL: 'gemini-test-model',
        ...env
      },
      on() {},
      exit() {},
      argv: ['node', 'index.js']
    },
    console: { log() {}, warn() {}, error: (...args) => consoleErrors.push(args.join(' ')) },
    fetch: fetchHandler,
    setInterval: () => ({ unref() {} }),
    setTimeout: (fn, ms) => {
      const t = setTimeout(fn, ms);
      timers.push(t);
      return t;
    },
    clearTimeout,
    Date
  };

  vm.runInNewContext(
    source.slice(0, cut) + '\nthis.handle = handleMessage; this.tracker = alignmentTracker; this.setSock = s => { activeSock = s; }; this.startBot = startBot; this.confirmations = confirmations;',
    context
  );
  context.setSock(sock);

  return {
    tmpDir,
    sock,
    events,
    sentMessages,
    consoleErrors,
    rows: virtualSheets.rows,
    sheets: virtualSheets.sheets,
    handle: (msg) => context.handle(sock, msg),
    tick: () => context.tracker.tick(),
    startBot: () => context.startBot(),
    cleanup: () => {
      global.fetch = origFetch;
      for (const t of timers) clearTimeout(t);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}


test('E2E virtual: gravação imediata parcial + cobrança de faltantes + preenchimento incremental na mesma linha (resposta e menção)', async () => {
  const bot = bootVirtualBot({
    fetchHandler: async (_url, options) => {
      const prompt = JSON.parse(options.body).contents[0].parts[0].text;
      if (prompt.includes('classifica mensagens')) {
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"decision":"related"}' }] } }] }) };
      }
      if (prompt.includes('Extraia um registro')) {
        return {
          ok: true,
          json: async () => ({
            candidates: [{
              content: {
                parts: [{
                  text: JSON.stringify({
                    records: [{
                      status: 'incomplete',
                      vessel: { value: 'BRAM Atlas', message: 1, quote: 'BRAM Atlas' },
                      equipment: { value: 'MCP 1', message: 1, quote: 'MCP 1' },
                      fields: {
                        date: { value: '22/11/2026', message: 1, quote: '22/11/2026' },
                        motivation: { value: 'preventiva', message: 1, quote: 'preventiva' },
                        method: { value: 'laser', message: 1, quote: 'laser' },
                        axial_vertical: { value: '0.02 mm', message: 1, quote: '0.02 mm' }
                      }
                    }]
                  })
                }]
              }
            }]
          })
        };
      }
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }) };
    }
  });

  try {
    const group = 'grupo-atlas@g.us';
    const user = '5521988881111@s.whatsapp.net';
    const ts = Math.floor(Date.now() / 1000);

    await bot.handle({
      key: { remoteJid: group, id: 'm1', participant: user },
      pushName: 'Isabela',
      messageTimestamp: ts,
      message: {
        extendedTextMessage: {
          text: '@bot BRAM Atlas MCP 1 Data: 22/11/2026 Motivação: preventiva Método: laser Axial Vertical: 0.02 mm',
          contextInfo: { mentionedJid: ['5511999990000@s.whatsapp.net'] }
        }
      }
    });

    assert.equal(bot.rows.length, 3);
    assert.equal(bot.rows[2][0], 'BRAM Atlas');
    assert.equal(bot.rows[2][1], 'MCP 1');
    assert.equal(bot.rows[2][6], '0.02 mm');
    assert.equal(bot.sentMessages.length, 1);
    assert.match(bot.sentMessages[0].text, /linha 3/);
    assert.match(bot.sentMessages[0].text, /- Executor/);
    assert.match(bot.sentMessages[0].text, /- Axial Horizontal/);
    assert.match(bot.sentMessages[0].text, /- Coupling GAP/);

    await bot.handle({
      key: { remoteJid: group, id: 'm2', participant: user },
      messageTimestamp: ts + 10,
      message: {
        extendedTextMessage: {
          text: 'Executor: Navship\nAxial Horizontal: 0.01 mm',
          contextInfo: { stanzaId: bot.sentMessages[0].id }
        }
      }
    });

    assert.equal(bot.rows.length, 3);
    assert.equal(bot.rows[2][5], 'Navship');
    assert.equal(bot.rows[2][7], '0.01 mm');
    assert.equal(bot.sentMessages.length, 2);
    assert.doesNotMatch(bot.sentMessages[1].text, /- Executor/);
    assert.match(bot.sentMessages[1].text, /- Radial Vertical/);
    assert.match(bot.sentMessages[1].text, /- Coupling GAP/);

    await bot.handle({
      key: { remoteJid: group, id: 'm3', participant: user },
      messageTimestamp: ts + 20,
      message: {
        extendedTextMessage: {
          text: '@bot Radial Vertical: 0.03 mm\nRadial Horizontal: -0.02 mm\nCoupling GAP: 25 mm',
          contextInfo: { mentionedJid: ['5511999990000@s.whatsapp.net'] }
        }
      }
    });

    assert.equal(bot.rows.length, 3);
    assert.equal(bot.rows[2][8], '0.03 mm');
    assert.equal(bot.rows[2][9], '-0.02 mm');
    assert.equal(bot.rows[2][10], '25 mm');
    assert.equal(bot.sentMessages.length, 3);
    assert.match(bot.sentMessages[2].text, /Todos os campos obrigatórios foram preenchidos/);
  } finally {
    bot.cleanup();
  }
});

test('E2E virtual: 4 geradores novos no mesmo relatório gravam imediatamente em 4 linhas distintas', async () => {
  const bot = bootVirtualBot({
    fetchHandler: async (_url, options) => {
      const prompt = JSON.parse(options.body).contents[0].parts[0].text;
      if (prompt.includes('Extraia um registro')) {
        return {
          ok: true,
          json: async () => ({
            candidates: [{
              content: {
                parts: [{
                  text: JSON.stringify({
                    records: [1, 2, 3, 4].map(n => ({
                      status: 'incomplete',
                      vessel: { value: 'BRAM Breeze', message: 1, quote: 'BRAM Breeze' },
                      equipment: { value: 'Diesel Generator #' + n, message: 1, quote: 'DG #' + n },
                      fields: { coupling_gap: { value: '2' + n + ',00 mm', message: 1, quote: '2' + n + ',00 mm' } }
                    }))
                  })
                }]
              }
            }]
          })
        };
      }
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }) };
    }
  });

  try {
    const ts = Math.floor(Date.now() / 1000);
    await bot.handle({
      key: { remoteJid: 'grupo-breeze@g.us', id: 'multi-1', participant: 'u@s.whatsapp.net' },
      messageTimestamp: ts,
      message: {
        extendedTextMessage: {
          text: '@bot BRAM Breeze DG #1 21,00 mm DG #2 22,00 mm DG #3 23,00 mm DG #4 24,00 mm',
          contextInfo: { mentionedJid: ['5511999990000@s.whatsapp.net'] }
        }
      }
    });
    assert.equal(bot.rows.length, 6);
    assert.equal(bot.sentMessages.length, 4);
  } finally {
    bot.cleanup();
  }
});

test('E2E virtual: grupos concorrentes não bloqueiam nem vazam estado entre si', async () => {
  const order = [];
  const bot = bootVirtualBot({
    fetchHandler: async (_url, options) => {
      const prompt = JSON.parse(options.body).contents[0].parts[0].text;
      if (prompt.includes('Extraia um registro')) {
        if (prompt.includes('Grupo Lento')) {
          await new Promise(resolve => setTimeout(resolve, 100));
          order.push('finish-lento');
          return {
            ok: true,
            json: async () => ({
              candidates: [{
                content: {
                  parts: [{
                    text: JSON.stringify({
                      records: [{
                        status: 'incomplete',
                        vessel: { value: 'BRAM Atlas', message: 1, quote: 'BRAM Atlas' },
                        equipment: { value: 'MCP 1', message: 1, quote: 'MCP 1' },
                        fields: { axial_vertical: { value: '0.05 mm', message: 1, quote: '0.05 mm' } }
                      }]
                    })
                  }]
                }
              }]
            })
          };
        }
        order.push('finish-rapido');
        return {
          ok: true,
          json: async () => ({
            candidates: [{
              content: {
                parts: [{
                  text: JSON.stringify({
                    records: [{
                      status: 'incomplete',
                      vessel: { value: 'BRAM Breeze', message: 1, quote: 'BRAM Breeze' },
                      equipment: { value: 'MCP 2', message: 1, quote: 'MCP 2' },
                      fields: { axial_vertical: { value: '0.01 mm', message: 1, quote: '0.01 mm' } }
                    }]
                  })
                }]
              }
            }]
          })
        };
      }
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }) };
    }
  });

  try {
    const ts = Math.floor(Date.now() / 1000);
    await Promise.all([
      bot.handle({
        key: { remoteJid: 'grupo-a@g.us', id: 'a1', participant: 'ua@s.whatsapp.net' },
        messageTimestamp: ts,
        message: { extendedTextMessage: { text: '@bot Grupo Lento BRAM Atlas MCP 1 0.05 mm', contextInfo: { mentionedJid: ['5511999990000@s.whatsapp.net'] } } }
      }),
      bot.handle({
        key: { remoteJid: 'grupo-b@g.us', id: 'b1', participant: 'ub@s.whatsapp.net' },
        messageTimestamp: ts,
        message: { extendedTextMessage: { text: '@bot Grupo Rapido BRAM Breeze MCP 2 0.01 mm', contextInfo: { mentionedJid: ['5511999990000@s.whatsapp.net'] } } }
      })
    ]);
    assert.deepEqual(order, ['finish-rapido', 'finish-lento']);
    assert.equal(bot.rows.length, 4);
  } finally {
    bot.cleanup();
  }
});

test('E2E virtual: regressões (Glossário com Bordo, período de datas, verifyExtraction canônico, coluna A vazia, Baileys append)', async () => {
  // 1. Glossário com palavra-chave de alias nas linhas de dados não trunca resultados
  const glossaryRows = [
    ['Termo', 'Significado'],
    ['MCP', 'Motor de Combustão Principal'],
    ['DG', 'Diesel Generator'],
    ['Bordo', 'Lado da embarcação'],
    ['BB', 'Bombordo']
  ];
  const parsedGlossary = rowsAsObjects(glossaryRows, ['taxonomia', 'glossario', 'glossary', 'possiveis nomes', 'nomes possíveis', 'termo', 'term', 'nome alternativo', 'bordo']);
  assert.equal(parsedGlossary.length, 4);

  // 2. Período de datas desambigua linhas históricas + coluna A vazia não desloca colunas no append
  const { sheets, rows } = createVirtualSheets([
    ['', 'Drive Machine', '', 'Histórico', 'Reference'],
    ['', 'Vessel', 'Equipment / Tag', 'Data', 'Comments'],
    ['', 'BRAM Atlas', 'MCP 1', '01/05/2026 a 05/05/2026', 'session:antiga'],
    ['', 'BRAM Atlas', 'MCP 1', '06/08/2026 a 13/08/2026', 'session:alvo']
  ]);
  const found = await resolveRecordTarget(sheets, 'records-id', {
    vessel: 'BRAM Atlas',
    equipment: 'MCP 1',
    date: '06/08/2026 a 13/08/2026'
  }, 'nova-sessao');
  assert.equal(found.target.row, 4);

  const novoTarget = await resolveRecordTarget(sheets, 'records-id', {
    vessel: 'BRAM Breeze',
    equipment: 'DG 01',
    date: '10.11.2026'
  }, 'sess-breeze');
  assert.equal(novoTarget.target.row, null);
  const appended = await recordHistory(sheets, 'records-id', {
    vessel: 'BRAM Breeze',
    equipment: 'DG 01',
    date: '10.11.2026',
    groupJid: 'grupo-breeze@g.us',
    approvedBy: '5521977771111@s.whatsapp.net'
  }, 'sess-breeze', { target: novoTarget.target, confirmationId: 'conf-breeze' });
  assert.deepEqual(appended, { status: 'appended', row: 5 });
  assert.equal(rows[4][0], '');
  assert.equal(rows[4][1], 'BRAM Breeze');
  assert.equal(rows[4][2], 'DG 01');
  assert.equal(rows[4][3], '10.11.2026');

  // 3. verifyExtraction aceita valor canônico, vírgula vs ponto e fallback de Embarcação
  const verified = verifyExtraction({
    status: 'ready',
    vessel: { value: 'BRAM Atlas', message: 1, quote: 'alinhamento no Atlas hoje' },
    equipment: { value: 'Diesel Generator #1', message: 1, quote: 'DG1 alinhado' },
    fields: { axial_vertical: { value: '0.02 mm', message: 1, quote: 'axial vertical 0,02mm' } }
  }, [{ text: 'alinhamento no Atlas hoje, DG1 alinhado, axial vertical 0,02mm' }]);
  assert.equal(verified.vessel, 'BRAM Atlas');
  assert.equal(verified.equipment, 'Diesel Generator #1');
  assert.equal(verified.fields['Axial vertical'], '0.02 mm');

  // 4. Baileys virtual startBot: recupera type === 'append' recente e ignora antigo
  const bot = bootVirtualBot({
    fetchHandler: async (_url, options) => {
      const prompt = JSON.parse(options.body).contents[0].parts[0].text;
      if (prompt.includes('classifica mensagens')) {
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"decision":"unrelated"}' }] } }] }) };
      }
      if (prompt.includes('Extraia um registro')) {
        return {
          ok: true,
          json: async () => ({
            candidates: [{
              content: {
                parts: [{
                  text: JSON.stringify({
                    records: [{
                      status: 'ready',
                      vessel: { value: 'BRAM Atlas', message: 1, quote: 'BRAM Atlas' },
                      equipment: { value: 'MCP 1', message: 1, quote: 'MCP 1' },
                      fields: { axial_vertical: { value: '0.03 mm', message: 1, quote: '0.03 mm' } }
                    }]
                  })
                }]
              }
            }]
          })
        };
      }
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }) };
    }
  });
  try {
    await bot.startBot();
    const nowSec = Math.floor(Date.now() / 1000);
    await bot.events['messages.upsert']({
      type: 'append',
      messages: [
        {
          key: { remoteJid: 'grupo-atlas@g.us', id: 'old-append', participant: 'u@s.whatsapp.net' },
          messageTimestamp: nowSec - (3 * 60 * 60), // > 2h atrás: deve ignorar
          message: { extendedTextMessage: { text: '@bot BRAM Atlas antigo', contextInfo: { mentionedJid: ['5511999990000@s.whatsapp.net'] } } }
        },
        {
          key: { remoteJid: 'grupo-atlas@g.us', id: 'recent-append', participant: 'u@s.whatsapp.net' },
          messageTimestamp: nowSec - 60, // 1 min atrás durante deploy/queda: deve recuperar!
          message: { extendedTextMessage: { text: '@bot BRAM Atlas MCP 1 0.03 mm', contextInfo: { mentionedJid: ['5511999990000@s.whatsapp.net'] } } }
        }
      ]
    });
    await bot.tick();
    assert.equal(bot.sentMessages.length, 1);
    assert.equal(bot.rows.length, 3);
    assert.equal(bot.rows[2][6], '0.03 mm');
    assert.match(bot.sentMessages[0].text, /Dados recebidos gravados na nova linha 3/);
  } finally {
    bot.cleanup();
  }
});
