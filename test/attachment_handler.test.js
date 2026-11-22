const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('recebe PDF no grupo e entrega o conteúdo ao rastreador', async () => {
  let inspected;
  let tracked;
  let download = async () => Buffer.from('pdf');
  const gemini = { inspectAttachment: async input => { inspected = input; return 'DG1 resultado 0,02 mm'; } };
  const mocks = {
    '@whiskeysockets/baileys': { downloadMediaMessage: (...args) => download(...args) },
    'qrcode-terminal': {}, pino: () => ({}),
    googleapis: { google: { options() {}, auth: { GoogleAuth: class {} }, sheets: () => ({}) } },
    fs: { readFileSync() { throw new Error('no state'); }, writeFileSync() {}, appendFileSync() {}, chmodSync() {} },
    './gemini_conversation': {
      createTracker: () => ({ process: async msg => { tracked = msg; return 'aberta'; } }),
      fileStore: () => ({ load() {}, save() {} }), makeGeminiFunctions: () => gemini
    },
    './confirmations': {createConfirmations: () => ({lookup: () => null}), parseCorrection: () => []},
    './alignment_config': { loadAlignmentConfig: async () => ({}) },
    './alignment_history': {}
  };
  const source = fs.readFileSync(require.resolve('../index.js'), 'utf8');
  const start = source.indexOf("process.on('SIGINT'");
  assert.ok(start > 0);
  const context = { require: name => mocks[name] || require(name), __dirname: '/tmp', Buffer,
    process: { env: { SPREADSHEET_ID: 'test', CONFIG_SPREADSHEET_ID: 'test', GEMINI_API_KEY: 'test', GEMINI_CONVERSATION_ENABLED: 'true' } },
    console, fetch, setInterval: () => ({ unref() {} }), setTimeout, Date };
  vm.runInNewContext(source.slice(0, start) + '\nthis.handle = handleMessage;', context);
  await context.handle({ user:{id:'12345@s.whatsapp.net'}, groupMetadata: async () => ({ subject: 'BRAM Breeze' }) }, {
    key: { remoteJid: 'grupo@g.us', id: 'test' },
    message: { documentMessage: { mimetype: 'application/pdf', fileName: 'relatorio.pdf', contextInfo:{mentionedJid:['12345@s.whatsapp.net']} } }
  });
  assert.equal(inspected.fileName, 'relatorio.pdf');
  assert.equal(inspected.groupName, 'BRAM Breeze');
  assert.match(tracked.text, /DG1 resultado 0,02 mm/);

  let archived;
  let pending;
  gemini.inspectAttachment = async () => '';
  mocks.fs.mkdirSync = () => {};
  mocks.fs.chmodSync = () => {};
  mocks.fs.appendFileSync = (_file, line) => { pending = JSON.parse(line); };
  mocks.fs.writeFileSync = (file, data) => { if (file.endsWith('.pdf')) archived = data; };
  await context.handle({ user:{id:'12345@s.whatsapp.net'}, groupMetadata: async () => ({ subject: 'BRAM Breeze' }) }, {
    key: { remoteJid: 'grupo@g.us', id: 'test2' },
    message: { documentMessage: { mimetype: 'application/pdf', fileName: 'relatorio.pdf', caption: 'Segue relatório final' } }
  });
  assert.equal(pending.reason, 'Gemini retornou resumo vazio para o anexo');
  assert.equal(archived.toString(), 'pdf');
  assert.doesNotMatch(tracked.text, /Conteúdo lido do anexo/);

  const caption = 'Embarcação: Joe Griffin\nConjunto: MCP x shaftline\nData: 17/11\nAxial vertical: -0.015\nRadial vertical: -0.35\nAxial horizontal: -0.02\nRadial horizontal: -0.02';
  await context.handle({ user:{id:'12345@s.whatsapp.net'}, groupMetadata: async () => ({ subject: 'Joe Griffin' }) }, {
    key: { remoteJid: 'grupo@g.us', id: 'image-empty', participant:'isabela@s.whatsapp.net' },
    message: { imageMessage: { mimetype:'image/jpeg', caption } }
  });
  assert.match(tracked.text, /Axial vertical: -0\.015/);
  assert.match(tracked.text, /Leitura do anexo indisponível/);
  assert.equal(tracked.originalText, caption);

  download = async () => { throw new Error('download falhou'); };
  await context.handle({ user:{id:'12345@s.whatsapp.net'}, groupMetadata: async () => ({ subject: 'Joe Griffin' }) }, {
    key: { remoteJid: 'grupo@g.us', id: 'image-error', participant:'isabela@s.whatsapp.net' },
    message: { imageMessage: { mimetype:'image/jpeg', caption } }
  });
  assert.match(tracked.text, /Axial vertical: -0\.015/);
  assert.match(tracked.text, /Leitura do anexo indisponível/);
});
