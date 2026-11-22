const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const extraction = require('../gemini_conversation');
const history = require('../alignment_history');

test('relatório com quatro geradores grava imediatamente e cobra campos faltantes', async () => {
  let onExtract;
  const writes = [];
  const proposals = [];
  const mocks = {
    '@whiskeysockets/baileys': {}, 'qrcode-terminal': {}, pino: () => ({}),
    googleapis: { google: { options() {}, auth: { GoogleAuth: class {} }, sheets: () => ({}) } },
    fs: { readFileSync() { throw new Error('sem estado'); }, appendFileSync() {}, chmodSync() {} },
    './gemini_conversation': {
      ...extraction, createTracker: () => ({}),
      fileStore: () => ({ load() {}, save() {} }),
      makeGeminiFunctions: args => { onExtract = args.onExtract; return {}; }
    },
    './confirmations': {createConfirmations: () => ({lookup: () => null, prepare: (group,sessionId,proposal) => {
      proposals.push({group,sessionId,proposal}); return {key:String(proposals.length),text:proposal.text};
    }}), parseCorrection: () => [], isApproval: () => false},
    './alignment_config': { loadAlignmentConfig: async () => ({}) },
    './alignment_history': {
      ...history,
      resolveRecordTarget: async (_sheets, _id, _data, sessionId) => ({status:'ready', target:{row:3, revision:sessionId, current:{}}, schema:[
        {title:'Vessel',group:'',mappedAs:['vessel']},
        {title:'Equipment / Tag',group:'',mappedAs:['equipment']},
        {title:'Data',group:'History',mappedAs:['date']},
        {title:'Maker',group:'Drive Machine',mappedAs:['maker']},
        {title:'Maker',group:'Máquina Estacionária',mappedAs:['stationary_maker']},
        {title:'Axial Vertical',group:'History',mappedAs:['axial_vertical']}
      ]}),
      recordHistory: async (_sheets, _id, data, sessionId) => { writes.push({data,sessionId}); return {status:'appended'}; }
    }
  };
  const source = fs.readFileSync(require.resolve('../index.js'), 'utf8');
  const start = source.indexOf("process.on('SIGINT'");
  vm.runInNewContext(source.slice(0, start), {
    require: name => mocks[name] || require(name), __dirname:'/tmp', Buffer,
    process: {env:{SPREADSHEET_ID:'test', CONFIG_SPREADSHEET_ID:'test', GEMINI_API_KEY:'test', GEMINI_CONVERSATION_ENABLED:'true'}},
    console, fetch, setInterval:() => ({unref() {}}), setTimeout, Date
  });

  const text = '[Grupo: BRAM Breeze]\nEquipamento: Diesel Generator #1\nEquipamento: Diesel Generator #2\nEquipamento: Diesel Generator #3\nCoupling GAP: 31,00 mm\nEquipamento: Diesel Generator #4';
  const item = value => ({value, message:1, quote:text});
  const records = [1,2,3,4].map(n => ({status:'incomplete', vessel:item('BRAM Breeze'),
    equipment:item(`Diesel Generator #${n}`), fields:n === 3 ? {coupling_gap:item('31,00 mm')} : {}}));
  const session = {group:'group@g.us', startedAt:'2026-11-14T23:29:36Z', messages:[{text}]};
  const outcome = await onExtract(session, 'sincronização periódica', {records}, [{text}]);

  assert.equal(outcome.proposed, 4);
  assert.equal(outcome.pending, 0);
  assert.equal(writes.length, 4);
  assert.equal(proposals.length, 4);
  assert.equal(new Set(proposals.map(row => row.sessionId)).size, 4);
  assert.deepEqual(proposals.map(row => row.proposal.data.equipment),
    ['Diesel Generator #1', 'Diesel Generator #2', 'Diesel Generator #3', 'Diesel Generator #4']);
  assert.equal(proposals[2].proposal.data.coupling_gap, '31,00 mm');
  assert.match(proposals[0].proposal.text,/Ainda faltam estas informações/);
  assert.match(proposals[0].proposal.text,/- Axial Vertical/);
  assert.match(proposals[0].proposal.text,/- Coupling GAP/);

  await onExtract(session, 'sincronização periódica', {records}, [{text}]);
  assert.equal(writes.length, 8);

  const oldPhoto = 'Conteúdo lido do anexo: Equipamento: MCP 1\nDIVERGENCIA_MEDICAO: {"field":"Axial Vertical","caption":"-0.015 mm","visual":"-0.01 mm"}';
  const newPhoto = 'Conteúdo lido do anexo: Equipamento: MCP 1\nAxial Vertical: -0.01 mm (fonte: tela -0.01 mm)';
  const latest = {group:'group@g.us',startedAt:session.startedAt,messages:[{text:oldPhoto},{text:newPhoto}]};
  const record = {status:'incomplete',vessel:{value:'BRAM Atlas',message:1,quote:'BRAM Atlas'},equipment:{value:'MCP 1',message:2,quote:'Equipamento: MCP 1'},fields:{axial_vertical:{value:'-0.01 mm',message:2,quote:'-0.01 mm'}}};
  await onExtract(latest,'teste',{records:[record]},[{text:'BRAM Atlas'}, {text:newPhoto}]);
  assert.equal(proposals.at(-1).proposal.conflicts.length,0);
  assert.equal(proposals.at(-1).proposal.data.axial_vertical,'-0.01 mm');

  const multiFirst = 'Conteúdo lido do anexo: Equipamento: Diesel Generator #1\nDIVERGENCIA_MEDICAO: {"field":"Axial Vertical","caption":"-0.1 mm","visual":"-0.01 mm"}\n\n--- OUTRO EQUIPAMENTO ---\n\nEquipamento: Diesel Generator #2\nRadial Vertical: 0.02 mm (fonte: tela 0.02 mm)';
  const multiFixed = 'Conteúdo lido do anexo: Equipamento: Diesel Generator #1\nAxial Vertical: -0.01 mm (fonte: tela -0.01 mm)';
  const multiRecords = [
    {status:'incomplete',vessel:{value:'BRAM Atlas',message:1,quote:'BRAM Atlas'},equipment:{value:'Diesel Generator #1',message:1,quote:'Diesel Generator #1'},fields:{}},
    {status:'incomplete',vessel:{value:'BRAM Atlas',message:1,quote:'BRAM Atlas'},equipment:{value:'Diesel Generator #2',message:1,quote:'Diesel Generator #2'},fields:{radial_vertical:{value:'0.02 mm',message:1,quote:'0.02 mm'}}}
  ];
  await onExtract({group:'group-m@g.us',startedAt:'2026-11-22T10:00:00Z',messages:[{text:multiFirst}]},'teste',{records:multiRecords},[{text:'BRAM Atlas\n' + multiFirst}]);
  const dg1Conflict = proposals.findLast(p => p.group === 'group-m@g.us' && p.proposal.data.equipment === 'Diesel Generator #1');
  assert.equal(dg1Conflict.proposal.conflicts.length, 1);
  assert.equal(dg1Conflict.proposal.data.axial_vertical, undefined);
  assert.match(dg1Conflict.proposal.text, /Divergência em Axial Vertical/);
  await onExtract({group:'group-m@g.us',startedAt:'2026-11-22T10:00:01Z',messages:[{text:multiFirst},{text:multiFixed}]},'teste',{records:[{...multiRecords[0],fields:{axial_vertical:{value:'-0.01 mm',message:2,quote:'-0.01 mm'}}}]},[{text:multiFirst},{text:'BRAM Atlas\n' + multiFixed}]);
  const dg1Fixed = proposals.findLast(p => p.group === 'group-m@g.us' && p.proposal.data.equipment === 'Diesel Generator #1');
  assert.equal(dg1Fixed.proposal.conflicts.length, 0);
  assert.equal(dg1Fixed.proposal.data.axial_vertical, '-0.01 mm');
});
