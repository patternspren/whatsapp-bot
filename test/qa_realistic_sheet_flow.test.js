const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { recordHistory } = require('../alignment_history');

const REALISTIC_GROUPS = [
  'Drive Machine', '', '', '', '',
  'Histórico', '', '', '', '', '', '', '', '',
  'Pés de fixação',
  'Tolerâncias', '', '',
  'Coupling',
  'Máquina Estacionária', '', '', '',
  'Reference'
];

const REALISTIC_HEADERS = [
  'Vessel', 'Equipment / Tag', 'Equipment Class', 'Maker', 'Model',
  'Data', 'Motivação', 'Executor', 'Método',
  'Axial Vertical', 'Axial Horizontal', 'Radial Vertical', 'Radial Horizontal', 'Coupling GAP',
  'Padrão',
  'Axial Tolerance', 'Radial Tolerance', 'Coupling GAP Tolerance',
  'Maker/Model',
  'Equipment Class', 'Maker', 'Model', 'Document',
  'Comments'
];

function createRealisticModelSheet(initialDataRows = []) {
  const rows = [
    [...REALISTIC_GROUPS],
    [...REALISTIC_HEADERS],
    ...initialDataRows.map(row => {
      const padded = [...row];
      while (padded.length < REALISTIC_HEADERS.length) padded.push('');
      return padded;
    })
  ];

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
    Taxonomia: [['Taxonomia'], ['Motor Diesel'], ['Propulsão'], ['Gerador']],
    Glossario: [['Termo', 'Significado'], ['MCP', 'Motor de Combustão Principal'], ['DG', 'Diesel Generator'], ['Bordo', 'Lado da embarcação']],
    'Configurações': [['Maquina a ser alinhada / Drive Machine'], ['Motor Diesel / Gerador']],
    masterlist: [['', 'Navio'], ['Nome', 'Operação'], ['BRAM Atlas', 'PSV'], ['BRAM Breeze', 'PSV']]
  };

  const state = {
    failNextAppend: null,
    corruptNextAppend: false,
    writes: []
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
            return { data: { values: (configTabs[tabName] || []).map(r => [...r]) } };
          }
          if (range.endsWith('!A1:ZZ2')) {
            return { data: { values: rows.slice(0, 2).map(r => [...r]) } };
          }
          return { data: { values: rows.map(r => [...r]) } };
        },
        append: async ({ range, valueInputOption, insertDataOption, requestBody }) => {
          assert.equal(valueInputOption, 'RAW');
          assert.equal(insertDataOption, 'INSERT_ROWS');
          if (state.failNextAppend) {
            const err = state.failNextAppend;
            state.failNextAppend = null;
            throw err;
          }
          const startColMatch = range.match(/!([A-Z]+)\d+/);
          const startCol = startColMatch ? colToIndex(startColMatch[1]) : 0;
          const newRow = Array(REALISTIC_HEADERS.length).fill('');
          const incoming = requestBody.values[0];
          for (let i = 0; i < incoming.length; i += 1) {
            newRow[startCol + i] = incoming[i];
          }
          if (state.corruptNextAppend) {
            state.corruptNextAppend = false;
            newRow[9] = 'VALOR_CORROMPIDO';
          }
          rows.push(newRow);
          state.writes.push({ type: 'append', row: rows.length });
          const startLetter = indexToCol(startCol);
          const endLetter = indexToCol(startCol + incoming.length - 1);
          return {
            data: {
              updates: {
                updatedRange: `'Modelo alinhamento'!${startLetter}${rows.length}:${endLetter}${rows.length}`
              }
            }
          };
        },
        batchUpdate: async ({ requestBody }) => {
          assert.equal(requestBody.valueInputOption, 'RAW');
          state.writes.push({ type: 'batchUpdate', count: requestBody.data.length });
          for (const item of requestBody.data) {
            const match = item.range.match(/!([A-Z]+)(\d+)$/);
            assert.ok(match, `Range inválido: ${item.range}`);
            const col = colToIndex(match[1]);
            const row = Number(match[2]) - 1;
            while (rows[row].length <= col) rows[row].push('');
            rows[row][col] = item.values[0][0];
          }
        }
      }
    }
  };

  return {
    sheets,
    rows,
    state,
    cell: (rowNum, colIndex) => rows[rowNum - 1]?.[colIndex]
  };
}

function bootRealisticBot({ env = {}, fetchHandler, sheetModel, downloadMediaMessageOverride = null }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpp-qa-'));
  const model = sheetModel || createRealisticModelSheet();
  const sentMessages = [];
  const consoleErrors = [];
  let seq = 0;
  const origFetch = global.fetch;
  global.fetch = fetchHandler;

  const sock = {
    user: { id: '5511999990000:1@s.whatsapp.net', lid: '999888777:2@lid' },
    groupMetadata: async (jid) => ({
      subject: jid.includes('breeze') ? 'BRAM Breeze' : 'BRAM Atlas'
    }),
    sendMessage: async (group, message) => {
      seq += 1;
      const id = `bot-msg-${seq}`;
      sentMessages.push({ group, id, ...message });
      return { key: { id, remoteJid: group } };
    },
    updateMediaMessage: async (msg) => msg
  };

  const fakeBaileys = {
    default: () => ({
      ...sock,
      ev: { on() {}, removeAllListeners() {} },
      end() {}
    }),
    useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => {} }),
    DisconnectReason: { loggedOut: 401 },
    downloadMediaMessage: downloadMediaMessageOverride || (async (msg) => Buffer.from(msg._mockBuffer || 'mock-media'))
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
            sheets: () => model.sheets
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
      const timer = setTimeout(fn, ms);
      timers.push(timer);
      return timer;
    },
    clearTimeout,
    Date
  };

  vm.runInNewContext(
    source.slice(0, cut) + '\nthis.handle = handleMessage; this.tracker = alignmentTracker; this.setSock = s => { activeSock = s; }; this.confirmations = confirmations;',
    context
  );
  context.setSock(sock);

  return {
    tmpDir,
    sock,
    sentMessages,
    consoleErrors,
    model,
    confirmations: context.confirmations,
    handle: (msg) => context.handle(sock, msg),
    tick: () => context.tracker.tick(),
    readPending: () => {
      const p = path.join(tmpDir, 'pending-alignment.jsonl');
      if (!fs.existsSync(p)) return [];
      return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    },
    cleanup: () => {
      global.fetch = origFetch;
      for (const timer of timers) clearTimeout(timer);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

const geminiJsonResponse = (obj) => ({
  ok: true,
  json: async () => ({
    candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }]
  })
});

test('QA realista 1: fluxo completo em 24 colunas com correção "Campo: valor", títulos repetidos, "confirmado" por participante e auditoria célula a célula', async () => {
  const group = 'grupo-atlas@g.us';
  const requester = '5521911112222@s.whatsapp.net';
  const isabela = '5521988887777@s.whatsapp.net';
  const model = createRealisticModelSheet();

  const bot = bootRealisticBot({
    env: { AUTHORIZED_APPROVERS: '5521988887777' },
    sheetModel: model,
    fetchHandler: async (_url, options) => {
      const prompt = JSON.parse(options.body).contents[0].parts[0].text;
      if (prompt.includes('classifica mensagens')) {
        return geminiJsonResponse({ decision: 'unrelated' });
      }
      if (prompt.includes('Extraia um registro')) {
        return geminiJsonResponse({
          records: [{
            status: 'ready',
            vessel: { value: 'BRAM Atlas', message: 1, quote: 'BRAM Atlas' },
            equipment: { value: 'MCP 1', message: 1, quote: 'MCP 1' },
            fields: {
              equipment_class: { value: 'Motor Diesel', message: 1, quote: 'Motor Diesel' },
              maker: { value: 'Wartsila', message: 1, quote: 'Wartsila' },
              stationary_equipment_class: { value: 'Propulsor', message: 1, quote: 'Propulsor' },
              stationary_maker: { value: 'Rolls-Royce', message: 1, quote: 'Rolls-Royce' },
              date: { value: '22/11/2026', message: 1, quote: '22/11/2026' },
              method: { value: 'Laser', message: 1, quote: 'Laser' },
              axial_vertical: { value: '-0,05 mm', message: 1, quote: '-0,05 mm' },
              radial_horizontal: { value: '+0.02 mm', message: 1, quote: '+0.02 mm' },
              coupling_gap: { value: '28,00 mm', message: 1, quote: '28,00 mm' }
            }
          }]
        });
      }
      return geminiJsonResponse({});
    }
  });

  try {
    const ts = Math.floor(Date.now() / 1000);
    await bot.handle({
      key: { remoteJid: group, id: 'msg-1', participant: requester },
      messageTimestamp: ts,
      message: {
        extendedTextMessage: {
          text: '@bot BRAM Atlas MCP 1 Motor Diesel Wartsila Propulsor Rolls-Royce 22/11/2026 Laser axial vertical -0,05 mm radial horizontal +0.02 mm coupling gap 28,00 mm',
          contextInfo: { mentionedJid: ['5511999990000@s.whatsapp.net'] }
        }
      }
    });

    await bot.tick();
    assert.equal(bot.sentMessages.length, 1);
    const firstProposal = bot.sentMessages[0];
    assert.match(firstProposal.text, /Destino: nova linha para este equipamento\./);
    assert.match(firstProposal.text, /Maker \(Drive Machine\): Wartsila/);
    assert.match(firstProposal.text, /Maker \(Máquina Estacionária\): Rolls-Royce/);

    // Participante autorizada envia correções no formato "Campo: valor"
    await bot.handle({
      key: { remoteJid: group, id: 'corr-1', participant: isabela },
      messageTimestamp: ts + 20,
      message: {
        extendedTextMessage: {
          text: [
            'Axial Vertical: -0,02 mm',
            'Maker (Drive Machine): WEG',
            'Maker (Máquina Estacionária): ABB',
            'Coupling GAP: 28,15 mm'
          ].join('\n'),
          contextInfo: { stanzaId: firstProposal.id }
        }
      }
    });

    assert.equal(model.rows.length, 2, 'Não deve gravar na planilha durante correção');
    assert.equal(bot.sentMessages.length, 2, 'Deve enviar exatamente a nova proposta completa');
    assert.equal(
      bot.sentMessages.some(m => m.text === 'Responda “confirmo” para validar todos os dados ou indique as correções no formato “Campo: valor”.'),
      false,
      'Não deve repetir mensagem genérica de orientação após correção válida'
    );

    const revisedProposal = bot.sentMessages[1];
    assert.match(revisedProposal.text, /Axial Vertical: -0\.02 mm/);
    assert.match(revisedProposal.text, /Maker \(Drive Machine\): WEG/);
    assert.match(revisedProposal.text, /Maker \(Máquina Estacionária\): ABB/);
    assert.match(revisedProposal.text, /Coupling GAP: 28,15 mm/);

    // Responder à proposta antiga já substituída não grava
    await bot.handle({
      key: { remoteJid: group, id: 'old-quote-attempt', participant: isabela },
      messageTimestamp: ts + 25,
      message: {
        extendedTextMessage: {
          text: 'confirmo',
          contextInfo: { stanzaId: firstProposal.id }
        }
      }
    });
    assert.equal(model.rows.length, 2);
    assert.match(bot.sentMessages[2].text, /Esta versão foi substituída/);

    // Participante responde "confirmado" citando a proposta corrigida
    await bot.handle({
      key: { remoteJid: group, id: 'conf-1', participant: isabela },
      messageTimestamp: ts + 30,
      message: {
        extendedTextMessage: {
          text: 'confirmado',
          contextInfo: { stanzaId: revisedProposal.id }
        }
      }
    });

    assert.equal(model.rows.length, 3);
    assert.match(bot.sentMessages[3].text, /Dados validados e gravados na linha 3 da planilha\./);

    // Auditoria célula a célula das 24 colunas da linha 3
    assert.equal(model.cell(3, 0), 'BRAM Atlas', 'Vessel');
    assert.equal(model.cell(3, 1), 'MCP 1', 'Equipment / Tag');
    assert.equal(model.cell(3, 2), 'Motor Diesel', 'Equipment Class (Drive)');
    assert.equal(model.cell(3, 3), 'WEG', 'Maker (Drive)');
    assert.equal(model.cell(3, 4), 'não informado', 'Model (Drive)');
    assert.equal(model.cell(3, 5), '22/11/2026', 'Data');
    assert.equal(model.cell(3, 6), 'não informado', 'Motivação');
    assert.equal(model.cell(3, 7), 'não informado', 'Executor');
    assert.equal(model.cell(3, 8), 'Laser', 'Método');
    assert.equal(model.cell(3, 9), '-0.02 mm', 'Axial Vertical');
    assert.equal(model.cell(3, 10), 'não informado', 'Axial Horizontal');
    assert.equal(model.cell(3, 11), 'não informado', 'Radial Vertical');
    assert.equal(model.cell(3, 12), '+0.02 mm', 'Radial Horizontal');
    assert.equal(model.cell(3, 13), '28,15 mm', 'Coupling GAP');
    assert.equal(model.cell(3, 14), 'não informado', 'Padrão');
    assert.equal(model.cell(3, 15), 'não informado', 'Axial Tolerance');
    assert.equal(model.cell(3, 16), 'não informado', 'Radial Tolerance');
    assert.equal(model.cell(3, 17), 'não informado', 'Coupling GAP Tolerance');
    assert.equal(model.cell(3, 18), '', 'Coluna não mapeada Coupling > Maker/Model deve permanecer vazia');
    assert.equal(model.cell(3, 19), 'Propulsor', 'Equipment Class (Estacionária)');
    assert.equal(model.cell(3, 20), 'ABB', 'Maker (Estacionária)');
    assert.equal(model.cell(3, 21), 'não informado', 'Model (Estacionária)');
    assert.equal(model.cell(3, 22), 'não informado', 'Document');
    assert.match(model.cell(3, 23), /session:/);
    assert.match(model.cell(3, 23), /confirmation:/);
    assert.match(model.cell(3, 23), /group:grupo-atlas@g\.us/);
    assert.match(model.cell(3, 23), /approved_by:5521988887777@s\.whatsapp\.net/);
    assert.match(model.cell(3, 23), /recorded_at:/);
  } finally {
    bot.cleanup();
  }
});

test('QA realista 2: atualização de linha existente preserva valores conhecidos, fórmula não mapeada e comentário humano, preenchendo vazios como "não informado"', async () => {
  const group = 'grupo-atlas@g.us';
  const user = '5521988887777@s.whatsapp.net';

  const existingRow = Array(24).fill('');
  existingRow[0] = 'BRAM Atlas';
  existingRow[1] = 'MCP 1';
  existingRow[3] = 'Caterpillar';
  existingRow[4] = '3516B';
  existingRow[8] = 'Relógio comparador';
  existingRow[18] = '=HYPERLINK("https://exemplo.local/laudo","Laudo")';
  existingRow[20] = 'Leroy-Somer';
  existingRow[23] = 'Nota histórica do cliente';

  const model = createRealisticModelSheet([existingRow]);
  const bot = bootRealisticBot({
    sheetModel: model,
    fetchHandler: async (_url, options) => {
      const prompt = JSON.parse(options.body).contents[0].parts[0].text;
      if (prompt.includes('classifica mensagens')) {
        return geminiJsonResponse({ decision: 'unrelated' });
      }
      if (prompt.includes('Extraia um registro')) {
        return geminiJsonResponse({
          records: [{
            status: 'ready',
            vessel: { value: 'BRAM Atlas', message: 1, quote: 'BRAM Atlas' },
            equipment: { value: 'MCP 1', message: 1, quote: 'MCP 1' },
            fields: {
              method: { value: 'Laser', message: 1, quote: 'Laser' },
              axial_vertical: { value: '+0.03 mm', message: 1, quote: '+0.03 mm' }
            }
          }]
        });
      }
      return geminiJsonResponse({});
    }
  });

  try {
    const ts = Math.floor(Date.now() / 1000);
    await bot.handle({
      key: { remoteJid: group, id: 'upd-msg-1', participant: user },
      messageTimestamp: ts,
      message: {
        extendedTextMessage: {
          text: '@bot BRAM Atlas MCP 1 método Laser Axial Vertical +0.03 mm',
          contextInfo: { mentionedJid: ['5511999990000@s.whatsapp.net'] }
        }
      }
    });

    await bot.tick();
    assert.equal(bot.sentMessages.length, 1);
    const prop1 = bot.sentMessages[0];
    assert.match(prop1.text, /Destino: linha 3 já existente\./);
    assert.match(prop1.text, /Maker \(Drive Machine\): Caterpillar \(mantido\)/);
    assert.match(prop1.text, /Maker \(Máquina Estacionária\): Leroy-Somer \(mantido\)/);
    assert.match(prop1.text, /Método: Laser \(anterior: Relógio comparador\)/);

    await bot.handle({
      key: { remoteJid: group, id: 'upd-corr-1', participant: user },
      messageTimestamp: ts + 10,
      message: {
        extendedTextMessage: {
          text: 'Executor: Equipe Bordo',
          contextInfo: { stanzaId: prop1.id }
        }
      }
    });

    assert.equal(bot.sentMessages.length, 2);
    const prop2 = bot.sentMessages[1];
    assert.match(prop2.text, /Executor: Equipe Bordo/);

    await bot.handle({
      key: { remoteJid: group, id: 'upd-conf-1', participant: user },
      messageTimestamp: ts + 20,
      message: {
        extendedTextMessage: {
          text: 'confirmo',
          contextInfo: { stanzaId: prop2.id }
        }
      }
    });

    assert.equal(model.rows.length, 3);
    assert.match(bot.sentMessages[2].text, /Dados validados e gravados na linha 3 da planilha\./);

    assert.equal(model.cell(3, 3), 'Caterpillar', 'Maker Drive preservado');
    assert.equal(model.cell(3, 4), '3516B', 'Model Drive preservado');
    assert.equal(model.cell(3, 7), 'Equipe Bordo', 'Executor atualizado pela correção');
    assert.equal(model.cell(3, 8), 'Laser', 'Método atualizado');
    assert.equal(model.cell(3, 9), '+0.03 mm', 'Axial Vertical com sinal preservado');
    assert.equal(model.cell(3, 10), 'não informado', 'Vazio em atualização vira não informado');
    assert.equal(model.cell(3, 18), '=HYPERLINK("https://exemplo.local/laudo","Laudo")', 'Fórmula não mapeada preservada');
    assert.equal(model.cell(3, 20), 'Leroy-Somer', 'Maker Estacionária preservado');
    assert.match(model.cell(3, 23), /^Nota histórica do cliente \| session:/, 'Comentário humano preservado');
  } finally {
    bot.cleanup();
  }
});

test('QA realista 3: imagem com legenda divergente bloqueia confirmação cega, aceita escolha via "Campo: valor" e grava valor escolhido', async () => {
  const group = 'grupo-atlas@g.us';
  const user = '5521988887777@s.whatsapp.net';
  const model = createRealisticModelSheet();

  const bot = bootRealisticBot({
    sheetModel: model,
    fetchHandler: async (_url, options) => {
      const prompt = JSON.parse(options.body).contents[0].parts[0].text;
      if (prompt.includes('Leia o documento inteiro')) {
        return geminiJsonResponse({
          records: [{
            vessel: 'BRAM Atlas',
            equipment: 'MCP 1',
            facts: [{ field: 'Data', value: '22/11/2026', evidence: 'Tela 22/11/2026' }]
          }]
        });
      }
      if (prompt.includes('Leia SOMENTE a imagem anexada')) {
        return geminiJsonResponse({
          compatible: true,
          unit: 'mm',
          values: { 'Axial Vertical': '-0.01' }
        });
      }
      if (prompt.includes('Extraia um registro')) {
        return geminiJsonResponse({
          records: [{
            status: 'ready',
            vessel: { value: 'BRAM Atlas', message: 1, quote: 'BRAM Atlas' },
            equipment: { value: 'MCP 1', message: 1, quote: 'MCP 1' },
            fields: {
              date: { value: '22/11/2026', message: 1, quote: '22/11/2026' }
            }
          }]
        });
      }
      return geminiJsonResponse({});
    }
  });

  try {
    const ts = Math.floor(Date.now() / 1000);
    await bot.handle({
      key: { remoteJid: group, id: 'img-msg-1', participant: user },
      messageTimestamp: ts,
      message: {
        imageMessage: {
          mimetype: 'image/jpeg',
          caption: '@bot BRAM Atlas MCP 1\nAxial Vertical: -0,05 mm',
          contextInfo: { mentionedJid: ['5511999990000@s.whatsapp.net'] }
        }
      }
    });

    await bot.tick();
    assert.equal(bot.sentMessages.length, 1);
    const prop1 = bot.sentMessages[0];
    assert.match(prop1.text, /Divergência Axial Vertical: legenda -0,05 mm; imagem -0\.01 mm\./);

    // Tentativa de confirmação cega antes de resolver divergência é bloqueada
    await bot.handle({
      key: { remoteJid: group, id: 'img-blind-conf', participant: user },
      messageTimestamp: ts + 10,
      message: { extendedTextMessage: { text: 'confirmo', contextInfo: { stanzaId: prop1.id } } }
    });
    assert.equal(model.rows.length, 2);
    assert.match(bot.sentMessages[1].text, /Ainda há divergências/);

    // Usuário escolhe valor correto no formato "Campo: valor"
    await bot.handle({
      key: { remoteJid: group, id: 'img-choice', participant: user },
      messageTimestamp: ts + 20,
      message: { extendedTextMessage: { text: 'Axial Vertical: -0,01 mm', contextInfo: { stanzaId: prop1.id } } }
    });
    assert.equal(bot.sentMessages.length, 3);
    const prop2 = bot.sentMessages[2];
    assert.doesNotMatch(prop2.text, /Divergência Axial Vertical/);
    assert.match(prop2.text, /Axial Vertical: -0\.01 mm/);

    // Confirmação final grava exatamente -0.01 mm
    await bot.handle({
      key: { remoteJid: group, id: 'img-conf-final', participant: user },
      messageTimestamp: ts + 30,
      message: { extendedTextMessage: { text: 'confirmado', contextInfo: { stanzaId: prop2.id } } }
    });

    assert.equal(model.rows.length, 3);
    assert.equal(model.cell(3, 9), '-0.01 mm');
    assert.equal(model.cell(3, 5), '22/11/2026');
  } finally {
    bot.cleanup();
  }
});

test('QA realista 4: falha de leitura do anexo registra pendência, avisa grupo e continua fluxo pela legenda até gravar', async () => {
  const group = 'grupo-atlas@g.us';
  const user = '5521988887777@s.whatsapp.net';
  const model = createRealisticModelSheet();

  const bot = bootRealisticBot({
    sheetModel: model,
    downloadMediaMessageOverride: async () => {
      throw new Error('Falha simulada de download Baileys');
    },
    fetchHandler: async (_url, options) => {
      const prompt = JSON.parse(options.body).contents[0].parts[0].text;
      if (prompt.includes('classifica mensagens')) {
        return geminiJsonResponse({ decision: 'unrelated' });
      }
      if (prompt.includes('Extraia um registro')) {
        return geminiJsonResponse({
          records: [{
            status: 'ready',
            vessel: { value: 'BRAM Atlas', message: 1, quote: 'BRAM Atlas' },
            equipment: { value: 'MCP 1', message: 1, quote: 'MCP 1' },
            fields: {
              date: { value: '22/11/2026', message: 1, quote: '22/11/2026' },
              axial_vertical: { value: '+0,04 mm', message: 1, quote: 'Axial Vertical: +0,04 mm' }
            }
          }]
        });
      }
      return geminiJsonResponse({});
    }
  });

  try {
    const ts = Math.floor(Date.now() / 1000);
    await bot.handle({
      key: { remoteJid: group, id: 'fail-doc-1', participant: user },
      messageTimestamp: ts,
      message: {
        documentMessage: {
          mimetype: 'application/pdf',
          fileName: 'relatorio.pdf',
          caption: '@bot BRAM Atlas MCP 1\nData: 22/11/2026\nAxial Vertical: +0,04 mm',
          contextInfo: { mentionedJid: ['5511999990000@s.whatsapp.net'] }
        }
      }
    });

    assert.equal(bot.sentMessages.length, 1);
    assert.match(bot.sentMessages[0].text, /Não consegui ler o anexo enviado/);

    const pending = bot.readPending();
    assert.ok(pending.some(item => String(item.reason || '').includes('não foi possível ler o anexo')));

    await bot.tick();
    assert.equal(bot.sentMessages.length, 2);
    const prop = bot.sentMessages[1];
    assert.match(prop.text, /A leitura do anexo falhou ou ficou incompleta/);
    assert.match(prop.text, /Axial Vertical: \+0,04 mm/);

    await bot.handle({
      key: { remoteJid: group, id: 'fail-doc-conf', participant: user },
      messageTimestamp: ts + 15,
      message: { extendedTextMessage: { text: 'confirmo', contextInfo: { stanzaId: prop.id } } }
    });

    assert.equal(model.rows.length, 3);
    assert.equal(model.cell(3, 0), 'BRAM Atlas');
    assert.equal(model.cell(3, 1), 'MCP 1');
    assert.equal(model.cell(3, 9), '+0,04 mm');
  } finally {
    bot.cleanup();
  }
});

test('QA realista 5: múltiplos equipamentos, mensagem duplicada, retomada após erro 503 no Sheets e bloqueio pós-gravação divergente', async () => {
  const group = 'grupo-breeze@g.us';
  const user = '5521988887777@s.whatsapp.net';
  const model = createRealisticModelSheet();
  let inspectCalls = 0;

  const bot = bootRealisticBot({
    sheetModel: model,
    fetchHandler: async (_url, options) => {
      const body = JSON.parse(options.body);
      const prompt = body.contents[0].parts[0].text;
      if (body.contents[0].parts.length > 1 && prompt.includes('Leia o documento inteiro')) {
        inspectCalls += 1;
        return geminiJsonResponse({
          records: [
            {
              vessel: 'BRAM Breeze',
              equipment: 'Diesel Generator #1',
              facts: [{ field: 'Coupling GAP', value: '21,10 mm', evidence: 'DG1 Coupling GAP: 21,10 mm' }]
            },
            {
              vessel: 'BRAM Breeze',
              equipment: 'Diesel Generator #2',
              facts: [{ field: 'Coupling GAP', value: '22,20 mm', evidence: 'DG2 Coupling GAP: 22,20 mm' }]
            }
          ]
        });
      }
      if (prompt.includes('período geral') || prompt.includes('distância final do GAP')) {
        return geminiJsonResponse({});
      }
      if (prompt.includes('Extraia um registro')) {
        return geminiJsonResponse({
          records: [
            {
              status: 'ready',
              vessel: { value: 'BRAM Breeze', message: 1, quote: 'BRAM Breeze' },
              equipment: { value: 'Diesel Generator #1', message: 1, quote: 'Diesel Generator #1' },
              fields: { coupling_gap: { value: '21,10 mm', message: 1, quote: '21,10 mm' } }
            },
            {
              status: 'ready',
              vessel: { value: 'BRAM Breeze', message: 1, quote: 'BRAM Breeze' },
              equipment: { value: 'Diesel Generator #2', message: 1, quote: 'Diesel Generator #2' },
              fields: { coupling_gap: { value: '22,20 mm', message: 1, quote: '22,20 mm' } }
            }
          ]
        });
      }
      return geminiJsonResponse({});
    }
  });

  try {
    const ts = Math.floor(Date.now() / 1000);
    const pdfMsg = {
      key: { remoteJid: group, id: 'dup-pdf-1', participant: user },
      messageTimestamp: ts,
      message: {
        documentMessage: {
          mimetype: 'application/pdf',
          fileName: 'relatorio-dgs.pdf',
          caption: '@bot relatório dos DGs da BRAM Breeze',
          contextInfo: { mentionedJid: ['5511999990000@s.whatsapp.net'] }
        }
      }
    };

    await bot.handle(pdfMsg);
    // Entrega repetida do mesmo messageId não deve reprocessar nem chamar inspectAttachment novamente
    await bot.handle(pdfMsg);
    assert.equal(inspectCalls, 1);

    await bot.tick();
    assert.equal(bot.sentMessages.length, 2);
    const dg1Prop = bot.sentMessages.find(m => m.text.includes('Diesel Generator #1'));
    const dg2Prop = bot.sentMessages.find(m => m.text.includes('Diesel Generator #2'));
    assert.ok(dg1Prop && dg2Prop);

    // Simula falha transitória 503 do Google Sheets na primeira tentativa de confirmação do DG #1
    model.state.failNextAppend = Object.assign(new Error('Service Unavailable'), { code: 503 });
    await bot.handle({
      key: { remoteJid: group, id: 'dg1-conf-fail', participant: user },
      messageTimestamp: ts + 10,
      message: { extendedTextMessage: { text: 'confirmo', contextInfo: { stanzaId: dg1Prop.id } } }
    });
    assert.equal(model.rows.length, 2, 'Erro transitório não pode gravar parcialmente');
    assert.match(bot.sentMessages[2].text, /Não consegui concluir a confirmação com o Google Sheets/);

    // Retomada: novo "confirmo" grava DG #1 na linha 3
    await bot.handle({
      key: { remoteJid: group, id: 'dg1-conf-retry', participant: user },
      messageTimestamp: ts + 20,
      message: { extendedTextMessage: { text: 'confirmo', contextInfo: { stanzaId: dg1Prop.id } } }
    });
    assert.equal(model.rows.length, 3);
    assert.equal(model.cell(3, 1), 'Diesel Generator #1');
    assert.equal(model.cell(3, 13), '21,10 mm');

    // DG #2 grava em sequência na linha 4
    await bot.handle({
      key: { remoteJid: group, id: 'dg2-conf-ok', participant: user },
      messageTimestamp: ts + 30,
      message: { extendedTextMessage: { text: 'confirmado', contextInfo: { stanzaId: dg2Prop.id } } }
    });
    assert.equal(model.rows.length, 4);
    assert.equal(model.cell(4, 1), 'Diesel Generator #2');
    assert.equal(model.cell(4, 13), '22,20 mm');

    // Reconfirmar DG #1 já respondido avisa e não duplica linha
    await bot.handle({
      key: { remoteJid: group, id: 'dg1-conf-dup', participant: user },
      messageTimestamp: ts + 40,
      message: { extendedTextMessage: { text: 'confirmo', contextInfo: { stanzaId: dg1Prop.id } } }
    });
    assert.equal(model.rows.length, 4);
    assert.match(bot.sentMessages[5].text, /já foi validada e gravada/);

    // Verificação pós-gravação detecta divergência caso a planilha retorne dado diferente do escrito
    model.state.corruptNextAppend = true;
    await assert.rejects(
      () => recordHistory(model.sheets, 'records-id', {
        vessel: 'BRAM Breeze',
        equipment: 'Diesel Generator #3',
        axial_vertical: '0.01 mm'
      }, 'sess-dg3', { target: { row: null, revision: model.rows.length >= 2 ? require('node:crypto').createHash('sha256').update(JSON.stringify(['bram breeze', 'dg3', REALISTIC_GROUPS, REALISTIC_HEADERS, undefined, {}])).digest('hex') : 'x', current: {} }, confirmationId: 'conf-dg3' }),
      /Gravação não verificada na planilha/
    );
  } finally {
    bot.cleanup();
  }
});

test('QA realista 6: caracterização de cenários que geram repetição de aviso ou não gravação (evidência sem presumir causa)', async () => {
  const group = 'grupo-atlas@g.us';
  const requester = '5521911112222@s.whatsapp.net';
  const isabela = '5521988887777@s.whatsapp.net';

  // (a) Sem AUTHORIZED_APPROVERS, outro participante recebe repetidamente bloqueio de autorização
  const modelA = createRealisticModelSheet();
  const botA = bootRealisticBot({
    sheetModel: modelA,
    fetchHandler: async (_url, options) => {
      const prompt = JSON.parse(options.body).contents[0].parts[0].text;
      if (prompt.includes('classifica mensagens')) {
        return geminiJsonResponse({ decision: 'unrelated' });
      }
      if (prompt.includes('Extraia um registro')) {
        return geminiJsonResponse({
          records: [{
            status: 'ready',
            vessel: { value: 'BRAM Atlas', message: 1, quote: 'BRAM Atlas' },
            equipment: { value: 'MCP 1', message: 1, quote: 'MCP 1' },
            fields: { axial_vertical: { value: '-0.02 mm', message: 1, quote: '-0.02 mm' } }
          }]
        });
      }
      return geminiJsonResponse({});
    }
  });
  try {
    const ts = Math.floor(Date.now() / 1000);
    await botA.handle({
      key: { remoteJid: group, id: 'a-1', participant: requester },
      messageTimestamp: ts,
      message: { extendedTextMessage: { text: '@bot BRAM Atlas MCP 1 -0.02 mm', contextInfo: { mentionedJid: ['5511999990000@s.whatsapp.net'] } } }
    });
    await botA.tick();
    const propA = botA.sentMessages[0];

    await botA.handle({
      key: { remoteJid: group, id: 'a-2', participant: isabela },
      messageTimestamp: ts + 5,
      message: { extendedTextMessage: { text: 'confirmo', contextInfo: { stanzaId: propA.id } } }
    });
    await botA.handle({
      key: { remoteJid: group, id: 'a-3', participant: isabela },
      messageTimestamp: ts + 10,
      message: { extendedTextMessage: { text: 'Axial Vertical: -0,01 mm', contextInfo: { stanzaId: propA.id } } }
    });
    assert.equal(modelA.rows.length, 2);
    assert.match(botA.sentMessages[1].text, /Somente a pessoa que solicitou/);
    assert.match(botA.sentMessages[2].text, /Somente a pessoa que solicitou/);
  } finally {
    botA.cleanup();
  }

  // (b) e (c) Com participante autorizada: aspas, @bot junto ao confirmo ou envio sem responder/citar (stanzaId ausente)
  const modelB = createRealisticModelSheet();
  const botB = bootRealisticBot({
    env: { AUTHORIZED_APPROVERS: '5521988887777' },
    sheetModel: modelB,
    fetchHandler: async (_url, options) => {
      const prompt = JSON.parse(options.body).contents[0].parts[0].text;
      if (prompt.includes('classifica mensagens')) {
        return geminiJsonResponse({ decision: 'unrelated' });
      }
      if (prompt.includes('Extraia um registro')) {
        return geminiJsonResponse({
          records: [{
            status: 'ready',
            vessel: { value: 'BRAM Atlas', message: 1, quote: 'BRAM Atlas' },
            equipment: { value: 'MCP 1', message: 1, quote: 'MCP 1' },
            fields: { axial_vertical: { value: '-0.02 mm', message: 1, quote: '-0.02 mm' } }
          }]
        });
      }
      return geminiJsonResponse({});
    }
  });
  try {
    const ts = Math.floor(Date.now() / 1000);
    await botB.handle({
      key: { remoteJid: group, id: 'b-1', participant: requester },
      messageTimestamp: ts,
      message: { extendedTextMessage: { text: '@bot BRAM Atlas MCP 1 -0.02 mm', contextInfo: { mentionedJid: ['5511999990000@s.whatsapp.net'] } } }
    });
    await botB.tick();
    const propB = botB.sentMessages[0];

    // Aspas envolvendo "Campo: valor" ou "@bot confirmo" falham no parser e acionam mensagens repetidas de orientação
    await botB.handle({
      key: { remoteJid: group, id: 'b-2', participant: isabela },
      messageTimestamp: ts + 5,
      message: { extendedTextMessage: { text: '“Axial Vertical: -0,01 mm”', contextInfo: { stanzaId: propB.id } } }
    });
    await botB.handle({
      key: { remoteJid: group, id: 'b-2b', participant: isabela },
      messageTimestamp: ts + 8,
      message: { extendedTextMessage: { text: '“Maker: WEG”', contextInfo: { stanzaId: propB.id } } }
    });
    await botB.handle({
      key: { remoteJid: group, id: 'b-3', participant: isabela },
      messageTimestamp: ts + 10,
      message: { extendedTextMessage: { text: '@bot confirmo', contextInfo: { stanzaId: propB.id } } }
    });
    assert.equal(
      botB.sentMessages[1].text,
      'Informe a unidade da medição (ex.: “Axial Vertical: -0,01 mm”).'
    );
    assert.equal(
      botB.sentMessages[2].text,
      'Responda “confirmo” para validar todos os dados ou indique as correções no formato “Campo: valor”.'
    );
    assert.equal(
      botB.sentMessages[3].text,
      'Responda “confirmo” para validar todos os dados ou indique as correções no formato “Campo: valor”.'
    );

    // Envio de "confirmo" sem citar a mensagem de conferência (sem stanzaId) não aciona gravação
    await botB.handle({
      key: { remoteJid: group, id: 'b-4', participant: isabela },
      messageTimestamp: ts + 15,
      message: { conversation: 'confirmo' }
    });
    await botB.tick();
    assert.equal(modelB.rows.length, 2);
  } finally {
    botB.cleanup();
  }
});
