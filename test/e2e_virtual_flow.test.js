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

test('E2E virtual: texto pré-anexo + PDF octet-stream + menção -> proposta -> bloqueio 3o -> aprovação e auditoria no Sheets', async () => {
  const geminiRequests = [];
  const bot = bootVirtualBot({
    env: {RESTRICT_CONFIRMATION_TO_REQUESTER:'true'},
    fetchHandler: async (_url, options) => {
      const body = JSON.parse(options.body);
      const prompt = body.contents[0].parts[0].text;
      geminiRequests.push({ prompt, parts: body.contents[0].parts });

      if (body.contents[0].parts.length > 1 && prompt.includes('Leia o documento inteiro')) {
        return {
          ok: true,
          json: async () => ({
            candidates: [{
              content: {
                parts: [{
                  text: JSON.stringify({
                    records: [{
                      vessel: 'BRAM Atlas',
                      equipment: 'MCP 1',
                      facts: [
                        { field: 'Axial Vertical', value: '-0.02 mm', evidence: 'Tela final: -0.02 mm' },
                        { field: 'Coupling GAP', value: '28,10 mm', evidence: 'Coupling GAP: 28,10 mm' }
                      ]
                    }]
                  })
                }]
              }
            }]
          })
        };
      }
      if (prompt.includes('período geral')) {
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"period":null}' }] } }] }) };
      }
      if (prompt.includes('classifica mensagens')) {
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"decision":"related"}' }] } }] }) };
      }
      if (prompt.includes('Extraia um registro de alinhamento')) {
        return {
          ok: true,
          json: async () => ({
            candidates: [{
              content: {
                parts: [{
                  text: JSON.stringify({
                    records: [{
                      status: 'ready',
                      vessel: { value: 'BRAM Atlas', message: 1, quote: 'alinhamento no Atlas hoje' },
                      equipment: { value: 'MCP 1', message: 2, quote: 'Equipamento: MCP 1' },
                      fields: {
                        motivation: { value: 'troca de mancal', message: 1, quote: 'motivo troca de mancal' },
                        executor: { value: 'João', message: 1, quote: 'executor João' },
                        date: { value: '22/11/2026', message: 1, quote: 'data 22/11/2026' },
                        axial_vertical: { value: '-0.02 mm', message: 2, quote: 'Axial Vertical: -0.02 mm' },
                        coupling_gap: { value: '28,10 mm', message: 2, quote: 'Coupling GAP: 28,10 mm' }
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
    const ts = Math.floor(Date.now() / 1000);

    // 1. Mensagem anterior ao anexo com contexto técnico relevante (antes da menção)
    await bot.handle({
      key: { remoteJid: group, id: 'm1', participant: '5521988880001@s.whatsapp.net' },
      messageTimestamp: ts - 60,
      pushName: 'Tecnico',
      message: { conversation: 'alinhamento no Atlas hoje, motivo troca de mancal, executor João, data 22/11/2026' }
    });
    assert.equal(bot.sentMessages.length, 0);

    // 2. PDF enviado como application/octet-stream com menção ao bot (@lid)
    await bot.handle({
      key: { remoteJid: group, id: 'm2', participant: '5521988880001@s.whatsapp.net' },
      messageTimestamp: ts,
      pushName: 'Tecnico',
      _mockBuffer: '%PDF-1.4 fake',
      message: {
        documentMessage: {
          mimetype: 'application/octet-stream',
          fileName: 'relatorio_mcp1.pdf',
          caption: '@bot segue o relatório',
          contextInfo: { mentionedJid: ['999888777@lid'] }
        }
      }
    });

    // Verifica que o PDF foi convertido para application/pdf ao enviar ao Gemini
    const attachCall = geminiRequests.find(r => r.parts.length > 1);
    assert.equal(attachCall.parts[1].inline_data.mime_type, 'application/pdf');

    // 3. Executa tick periódico -> deve preservar mensagem pré-anexo + enviar conferência
    await bot.tick();
    assert.equal(bot.sentMessages.length, 1);
    const reviewMsg = bot.sentMessages[0];
    assert.match(reviewMsg.text, /Vessel: BRAM Atlas/);
    assert.match(reviewMsg.text, /Equipment \/ Tag: MCP 1/);
    assert.match(reviewMsg.text, /Motivação: troca de mancal/);
    assert.match(reviewMsg.text, /Executor: João/);
    assert.match(reviewMsg.text, /Axial Vertical: -0\.02 mm/);
    assert.match(reviewMsg.text, /Coupling GAP: 28,10 mm/);
    assert.equal(bot.rows.length, 2); // Ainda não gravou!

    // 4. Outro participante tenta aprovar -> bloqueado!
    await bot.handle({
      key: { remoteJid: group, id: 'm3', participant: '5521999999999@s.whatsapp.net' },
      messageTimestamp: ts + 10,
      message: { conversation: 'confirmo' }
    });
    assert.equal(bot.rows.length, 2);
    assert.match(bot.sentMessages[1].text, /Somente a pessoa que solicitou/);

    // 5. Solicitante aprova -> grava na linha 3 com auditoria em Comments
    await bot.handle({
      key: { remoteJid: group, id: 'm4', participant: '5521988880001@s.whatsapp.net' },
      messageTimestamp: ts + 20,
      message: { extendedTextMessage: { text: 'confirmo', contextInfo: { stanzaId: reviewMsg.id } } }
    });
    assert.equal(bot.rows.length, 3);
    assert.equal(bot.rows[2][0], 'BRAM Atlas');
    assert.equal(bot.rows[2][1], 'MCP 1');
    assert.equal(bot.rows[2][5], 'João');
    assert.equal(bot.rows[2][6], '-0.02 mm');
    assert.match(bot.rows[2][11], /group:grupo-atlas@g\.us/);
    assert.match(bot.rows[2][11], /approved_by:5521988880001@s\.whatsapp\.net/);
    assert.match(bot.sentMessages[2].text, /gravados na linha 3/);

    // 6. Tentativa de alterar após já respondida -> bloqueado
    await bot.handle({
      key: { remoteJid: group, id: 'm5', participant: '5521988880001@s.whatsapp.net' },
      messageTimestamp: ts + 30,
      message: { extendedTextMessage: { text: 'Axial Vertical: 9.99 mm', contextInfo: { stanzaId: reviewMsg.id } } }
    });
    assert.equal(bot.rows[2][6], '-0.02 mm');
    assert.match(bot.sentMessages[3].text, /já foi validada/);
  } finally {
    bot.cleanup();
  }
});

test('E2E virtual: AUTHORIZED_APPROVERS e ALLOWED_GROUP_JIDS restringem quem aprova e quais grupos o bot escuta', async () => {
  const bot = bootVirtualBot({
    env: {
      AUTHORIZED_APPROVERS: '5521977771111',
      ALLOWED_GROUP_JIDS: 'grupo-permitido@g.us'
    },
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
                      equipment: { value: 'DG #1', message: 1, quote: 'DG #1' },
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
    // Grupo não permitido é ignorado mesmo com menção
    await bot.handle({
      key: { remoteJid: 'grupo-intruso@g.us', id: 'm-ignored', participant: '5521977771111@s.whatsapp.net' },
      messageTimestamp: ts,
      message: { extendedTextMessage: { text: '@bot BRAM Atlas DG #1 0.01 mm', contextInfo: { mentionedJid: ['5511999990000@s.whatsapp.net'] } } }
    });
    await bot.tick();
    assert.equal(bot.sentMessages.length, 0);

    // Operador menciona no grupo permitido
    await bot.handle({
      key: { remoteJid: 'grupo-permitido@g.us', id: 'm-op', participant: '5521900002222@s.whatsapp.net' },
      messageTimestamp: ts,
      message: { extendedTextMessage: { text: '@bot BRAM Atlas DG #1 0.01 mm', contextInfo: { mentionedJid: ['5511999990000@s.whatsapp.net'] } } }
    });
    await bot.tick();
    assert.equal(bot.sentMessages.length, 1);
    const reviewId = bot.sentMessages[0].id;

    // Mesmo tendo mencionado o bot, operador fora da allowlist não aprova
    await bot.handle({
      key: { remoteJid: 'grupo-permitido@g.us', id: 'm-deny', participant: '5521900002222@s.whatsapp.net' },
      messageTimestamp: ts + 5,
      message: { extendedTextMessage: { text: 'confirmo', contextInfo: { stanzaId: reviewId } } }
    });
    assert.equal(bot.rows.length, 2);
    assert.match(bot.sentMessages[1].text, /Somente uma pessoa autorizada/);

    // Supervisor da allowlist (com @lid + participantAlt) aprova e grava
    await bot.handle({
      key: {
        remoteJid: 'grupo-permitido@g.us',
        id: 'm-allow',
        participant: '123456@lid',
        participantAlt: '5521977771111@s.whatsapp.net'
      },
      messageTimestamp: ts + 10,
      message: { extendedTextMessage: { text: 'confirmo', contextInfo: { stanzaId: reviewId } } }
    });
    assert.equal(bot.rows.length, 3);
    assert.match(bot.rows[2][11], /approved_by:123456@lid/);
  } finally {
    bot.cleanup();
  }
});

test('E2E virtual: divergência PRUFTECHNIK (fieldKeys) bloqueia confirmação cega, aceita escolha e grava valor corrigido', async () => {
  const bot = bootVirtualBot({
    fetchHandler: async (_url, options) => {
      const body = JSON.parse(options.body);
      const prompt = body.contents[0].parts[0].text;
      if (prompt.includes('Leia o documento inteiro')) {
        return {
          ok: true,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ records: [{ vessel: 'BRAM Atlas', equipment: 'MCP 1', facts: [] }] }) }] } }]
          })
        };
      }
      if (prompt.includes('Leia SOMENTE a imagem anexada')) {
        return {
          ok: true,
          json: async () => ({
            candidates: [{
              content: {
                parts: [{
                  text: JSON.stringify({
                    compatible: true,
                    unit: 'mm',
                    values: {
                      'Axial Vertical': '-0.01',
                      'Radial Vertical': '-0.35',
                      'Axial Horizontal': '-0.02',
                      'Radial Horizontal': '-0.02'
                    }
                  })
                }]
              }
            }]
          })
        };
      }
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
                      status: 'incomplete',
                      vessel: { value: 'BRAM Atlas', message: 1, quote: 'BRAM Atlas' },
                      equipment: { value: 'MCP 1', message: 1, quote: 'Equipamento: MCP 1' },
                      fields: {}
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
    const group = 'grupo-img@g.us';
    const user = '5521988881234@s.whatsapp.net';
    const ts = Math.floor(Date.now() / 1000);
    await bot.handle({
      key: { remoteJid: group, id: 'img1', participant: user },
      messageTimestamp: ts,
      message: {
        imageMessage: {
          mimetype: 'image/jpeg',
          caption: '@bot axial vertical: -0.1\nradial vertical: -0.35\naxial horizontal: -0.02\nradial horizontal: -0.02',
          contextInfo: { mentionedJid: ['5511999990000@s.whatsapp.net'] }
        }
      }
    });
    await bot.tick();
    assert.equal(bot.sentMessages.length, 1);
    const review1 = bot.sentMessages[0];
    // Prova correção do bug fieldKeys['Axial Vertical']
    assert.match(review1.text, /Axial Vertical: usuário passou informação divergente/);
    assert.match(review1.text, /Divergência Axial Vertical: legenda -0\.1 mm; imagem -0\.01 mm/);
    assert.match(review1.text, /Radial Vertical: -0\.35 mm/);

    // Tentar confirmar sem escolher valor divergente é bloqueado
    await bot.handle({
      key: { remoteJid: group, id: 'c1', participant: user },
      messageTimestamp: ts + 5,
      message: { extendedTextMessage: { text: 'confirmo', contextInfo: { stanzaId: review1.id } } }
    });
    assert.equal(bot.rows.length, 2);
    assert.match(bot.sentMessages[1].text, /Ainda há divergências/);

    // Mensagens paralelas com ":" sem quote (link ou horário) não interrompem com erro de campo desconhecido
    await bot.handle({
      key: { remoteJid: group, id: 'chat-url', participant: user },
      messageTimestamp: ts + 6,
      message: { conversation: 'https://docs.google.com/spreadsheets/d/123' }
    });
    await bot.handle({
      key: { remoteJid: group, id: 'chat-hora', participant: user },
      messageTimestamp: ts + 6,
      message: { conversation: 'Horário: 15h' }
    });
    assert.equal(bot.sentMessages.length, 2);

    // Correção sem unidade herda mm da divergência e inclui o executor.
    await bot.handle({
      key: { remoteJid: group, id: 'c3', participant: user },
      messageTimestamp: ts + 7,
      message: { conversation: '@999888777\naxial vertical: -0.01\nexecutor: navship' }
    });
    const review2 = bot.sentMessages[2];
    assert.match(review2.text, /Axial Vertical: -0\.01 mm/);
    assert.match(review2.text, /Executor: navship/);
    assert.doesNotMatch(review2.text, /Divergência Axial Vertical/);

    await bot.handle({
      key: { remoteJid: group, id: 'c4', participant: user },
      messageTimestamp: ts + 8,
      message: { conversation: '@999888777 confirmado' }
    });
    assert.equal(bot.rows.length, 3);
    assert.equal(bot.rows[2][6], '-0.01 mm');
    assert.equal(bot.rows[2][5], 'navship');
    assert.equal(bot.rows[2][8], '-0.35 mm');
  } finally {
    bot.cleanup();
  }
});

test('E2E virtual: 4 geradores novos no mesmo relatório gravam em sequência sem bloqueio de 2h e atualizações exibem valor anterior', async () => {
  const bot = bootVirtualBot({
    fetchHandler: async (_url, options) => {
      const prompt = JSON.parse(options.body).contents[0].parts[0].text;
      if (prompt.includes('Leia o documento inteiro')) {
        return {
          ok: true,
          json: async () => ({
            candidates: [{
              content: {
                parts: [{
                  text: JSON.stringify({
                    records: [1, 2, 3, 4].map(n => ({
                      vessel: 'BRAM Breeze',
                      equipment: `Diesel Generator #${n}`,
                      facts: [{ field: 'Coupling GAP', value: `2${n},00 mm`, evidence: `GAP #${n}: 2${n},00 mm` }]
                    }))
                  })
                }]
              }
            }]
          })
        };
      }
      if (prompt.includes('período geral') || prompt.includes('GAP do acoplamento')) {
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }) };
      }
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
                    records: [1, 2, 3, 4].map(n => ({
                      status: 'ready',
                      vessel: { value: 'BRAM Breeze', message: 1, quote: 'BRAM Breeze' },
                      equipment: { value: `Diesel Generator #${n}`, message: 1, quote: `Equipamento: Diesel Generator #${n}` },
                      fields: { coupling_gap: { value: `2${n},00 mm`, message: 1, quote: `Coupling GAP: 2${n},00 mm` } }
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
    const group = 'grupo-breeze@g.us';
    const user = '5521988883333@s.whatsapp.net';
    const ts = Math.floor(Date.now() / 1000);
    await bot.handle({
      key: { remoteJid: group, id: 'pdf4', participant: user },
      messageTimestamp: ts,
      message: {
        documentMessage: {
          mimetype: 'application/pdf',
          fileName: 'breeze_dgs.pdf',
          caption: '@bot segue relatório dos 4 DGs',
          contextInfo: { mentionedJid: ['5511999990000@s.whatsapp.net'] }
        }
      }
    });
    await bot.tick();
    assert.equal(bot.sentMessages.length, 4);

    // Confirma os 4 geradores em sequência imediata
    for (let i = 0; i < 4; i++) {
      await bot.handle({
        key: { remoteJid: group, id: `ok-${i}`, participant: user },
        messageTimestamp: ts + 10 + i,
        message: { extendedTextMessage: { text: 'confirmo', contextInfo: { stanzaId: bot.sentMessages[i].id } } }
      });
    }
    assert.equal(bot.rows.length, 6); // 2 linhas de cabeçalho + 4 DGs
    assert.deepEqual(bot.rows.slice(2).map(r => [r[1], r[10]]), [
      ['Diesel Generator #1', '21,00 mm'],
      ['Diesel Generator #2', '22,00 mm'],
      ['Diesel Generator #3', '23,00 mm'],
      ['Diesel Generator #4', '24,00 mm']
    ]);

    // Nova atualização para DG #1 alterando Coupling GAP deve mostrar valor anterior antes de gravar
    const bot2 = bootVirtualBot({
      initialRows: bot.rows,
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
                        vessel: { value: 'BRAM Breeze', message: 1, quote: 'BRAM Breeze' },
                        equipment: { value: 'Diesel Generator #1', message: 1, quote: 'DG #1' },
                        fields: { coupling_gap: { value: '25,50 mm', message: 1, quote: '25,50 mm' } }
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
      await bot2.handle({
        key: { remoteJid: group, id: 'upd-dg1', participant: user },
        messageTimestamp: ts + 120,
        message: {
          extendedTextMessage: {
            text: '@bot BRAM Breeze DG #1 25,50 mm',
            contextInfo: { mentionedJid: ['5511999990000@s.whatsapp.net'] }
          }
        }
      });
      await bot2.tick();
      assert.equal(bot2.sentMessages.length, 1);
      assert.match(bot2.sentMessages[0].text, /Destino: linha 3 já existente/);
      assert.match(bot2.sentMessages[0].text, /Coupling GAP: 25,50 mm \(anterior: 21,00 mm\)/);
    } finally {
      bot2.cleanup();
    }
  } finally {
    bot.cleanup();
  }
});

test('E2E virtual: grupos concorrentes não bloqueiam nem vazam estado entre si', async () => {
  const order = [];
  const bot = bootVirtualBot({
    fetchHandler: async (_url, options) => {
      const prompt = JSON.parse(options.body).contents[0].parts[0].text;
      if (prompt.includes('classifica mensagens')) {
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"decision":"unrelated"}' }] } }] }) };
      }
      if (prompt.includes('Extraia um registro')) {
        if (prompt.includes('Grupo Lento')) {
          await new Promise(resolve => setTimeout(resolve, 140));
          order.push('finish-lento');
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
                      status: 'ready',
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
    bot.sock.groupMetadata = async (jid) => ({ subject: jid === 'grupo-a@g.us' ? 'Grupo Lento' : 'Grupo Rapido' });

    await bot.handle({
      key: { remoteJid: 'grupo-a@g.us', id: 'shared-msg-id', participant: 'userA@s.whatsapp.net' },
      messageTimestamp: ts,
      message: { extendedTextMessage: { text: '@bot BRAM Atlas MCP 1 0.05 mm', contextInfo: { mentionedJid: ['5511999990000@s.whatsapp.net'] } } }
    });
    await bot.handle({
      key: { remoteJid: 'grupo-b@g.us', id: 'shared-msg-id', participant: 'userB@s.whatsapp.net' },
      messageTimestamp: ts,
      message: { extendedTextMessage: { text: '@bot BRAM Breeze MCP 2 0.01 mm', contextInfo: { mentionedJid: ['5511999990000@s.whatsapp.net'] } } }
    });

    const tickPromise = bot.tick();
    await new Promise(resolve => setTimeout(resolve, 40));
    const msgB = bot.sentMessages.find(m => m.group === 'grupo-b@g.us');
    assert.ok(msgB, 'Grupo B deveria receber proposta sem aguardar Grupo A');

    // Grupo B confirma e grava no Sheets antes mesmo do Grupo A terminar
    await bot.handle({
      key: { remoteJid: 'grupo-b@g.us', id: 'confirm-b', participant: 'userB@s.whatsapp.net' },
      messageTimestamp: ts + 3,
      message: { extendedTextMessage: { text: 'confirmo', contextInfo: { stanzaId: msgB.id } } }
    });
    assert.equal(bot.rows.length, 3);
    assert.equal(bot.rows[2][0], 'BRAM Breeze');

    await tickPromise;
    assert.deepEqual(order, ['finish-rapido', 'finish-lento']);
    const msgA = bot.sentMessages.find(m => m.group === 'grupo-a@g.us');
    assert.ok(msgA);

    // Responder com quote a uma mensagem que NÃO é a conferência do grupo (colega ou outro grupo) NÃO pode confirmar acidentalmente
    await bot.handle({
      key: { remoteJid: 'grupo-a@g.us', id: 'cross-group', participant: 'userB@s.whatsapp.net' },
      messageTimestamp: ts + 5,
      message: { extendedTextMessage: { text: 'confirmo', contextInfo: { stanzaId: msgB.id } } }
    });
    await bot.handle({
      key: { remoteJid: 'grupo-a@g.us', id: 'quote-colega', participant: 'userA@s.whatsapp.net' },
      messageTimestamp: ts + 6,
      message: { extendedTextMessage: { text: 'ok', contextInfo: { stanzaId: 'msg-de-colega' } } }
    });
    assert.equal(bot.rows.length, 3);

    // Sem quote, aprovação explícita no próprio grupo confirma a única proposta aberta
    await bot.handle({
      key: { remoteJid: 'grupo-a@g.us', id: 'direct-confirm-a', participant: 'userA@s.whatsapp.net' },
      messageTimestamp: ts + 7,
      message: { conversation: 'confirmo' }
    });
    assert.equal(bot.rows.length, 4);
    assert.equal(bot.rows[3][0], 'BRAM Atlas');
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
    assert.match(bot.sentMessages[0].text, /Axial Vertical: 0\.03 mm/);
  } finally {
    bot.cleanup();
  }
});
