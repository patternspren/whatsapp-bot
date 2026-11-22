const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapHeaders, recordHistory, resolveRecordTarget } = require('../alignment_history');

const heads = [
  ['Drive Machine', '', '', 'Histórico', '', 'Reference'],
  ['Vessel', 'Equipment / Tag', 'Maker', 'Data', 'Axial Vertical', 'Comments', 'Extra']
];
function fakeSheet(...records) {
  const rows = [...heads, ...records];
  const writes = [];
  const sheets = { spreadsheets: { values: {
    get: async () => ({ data: { values: rows } }),
    batchUpdate: async ({ requestBody }) => {
      writes.push({ type: 'update', ranges: requestBody.data.map(item => item.range) });
      for (const { range, values } of requestBody.data) {
        const [, col, row] = range.match(/!([A-G])(\d+)$/);
        rows[Number(row) - 1][col.charCodeAt(0) - 65] = values[0][0];
      }
    },
    append: async ({ requestBody, insertDataOption }) => {
      assert.equal(insertDataOption, 'INSERT_ROWS');
      writes.push({ type: 'append' });
      rows.push(requestBody.values[0]);
      return { data: { updates: { updatedRange: `'Modelo alinhamento'!A${rows.length}:G${rows.length}` } } };
    }
  } } };
  const find = (data, session) => resolveRecordTarget(sheets, 'test', data, session);
  const write = (data, session, target, confirmationId = 'validado') =>
    recordHistory(sheets, 'test', data, session, { target, confirmationId });
  return { rows, writes, find, write, sheets };
}

test('não declara sucesso quando a leitura posterior diverge da gravação', async () => {
  const h = fakeSheet(['BRAM Atlas', 'DG 1', '', '', '0.3 mm', '']);
  const data = {vessel:'BRAM Atlas', equipment:'DG 1', axial_vertical:'-0.01 mm'};
  const {target} = await h.find(data, 'sessao');
  h.sheets.spreadsheets.values.batchUpdate = async () => ({});
  await assert.rejects(h.write(data, 'sessao', target), /não verificada/);
});

test('linha da embarcação sem identificação do equipamento impede destino automático', async () => {
  const h = fakeSheet(['Joe Griffin', '', 'cat', '', '', '']);
  const result = await h.find({vessel:'Joe Griffin', equipment:'MCP x shaftline'}, 'sessao');
  assert.equal(result.status, 'ambiguous_target');
  assert.deepEqual(result.rows, [3]);
  assert.equal(h.writes.length, 0);
});

test('atualiza a linha existente do mesmo equipamento mesmo depois de várias horas', async () => {
  const h = fakeSheet(['BRAM Atlas', 'DG 1', 'WEG', '18/11/2026', '0.3 mm', 'Nota anterior', '=1+2']);
  const data = { vessel:'BRAM Atlas', equipment:'Diesel Generator #1', axial_vertical:'-0.01 mm', observations:'Unidade em mm' };
  const { target } = await h.find(data, 'nova-sessao');
  assert.equal(target.row, 3);
  assert.equal(target.current.maker, 'WEG');
  const result = await h.write(data, 'nova-sessao', target);
  assert.deepEqual(result, { status:'updated', row:3 });
  assert.equal(h.rows.length, 3);
  assert.deepEqual(h.writes[0].ranges, ["'Modelo alinhamento'!B3", "'Modelo alinhamento'!E3", "'Modelo alinhamento'!F3"]);
  assert.equal(h.rows[2][6], '=1+2');
  assert.match(h.rows[2][5], /Nota anterior \| Observações: Unidade em mm/);
});

test('só cria linha depois da confirmação de outro equipamento e evita duplicar no retry', async () => {
  const h = fakeSheet(['BRAM Atlas', 'DG 1', '', '', '', 'session:old | recorded_at:2020-01-01T12:00:00Z']);
  const data = { vessel:'BRAM Atlas', equipment:'DG 2', axial_vertical:'0' };
  const { target } = await h.find(data, 'novo');
  assert.equal(target.row, null);
  assert.equal((await h.write(data, 'novo')).status, 'confirmation_required');
  assert.equal(h.writes.length, 0);
  assert.deepEqual(await h.write(data, 'novo', target), {status:'appended', row:4});
  assert.equal(h.rows[3][4], '0');
  assert.deepEqual(await h.write(data, 'novo', target), {status:'unchanged', row:4});
  assert.equal(h.writes.length, 1);
});

test('equipamento diferente na mesma embarcação pode ser registrado imediatamente', async () => {
  const h = fakeSheet(['BRAM Atlas', 'DG 1', '', '', '', `recorded_at:${new Date().toISOString()}`]);
  const vessel = 'BRAM Atlas';
  assert.equal((await h.find({vessel, equipment:'DG 2'}, 'outra')).target.row, null);
  assert.equal((await h.find({vessel, equipment:'DG 1'}, 'atual')).target.row, 3);
  assert.equal((await h.find({vessel:'BRAM Brasil', equipment:'DG 2'}, 'outra')).target.row, null);
  assert.equal(h.writes.length, 0);
});

test('não cria linha se o destino original sumir ou mudar após a conferência', async () => {
  const h = fakeSheet(['BRAM Atlas', 'MCP 1', 'WEG', '', '0.03 mm']);
  const data = {vessel:'BRAM Atlas', equipment:'MCP 1', axial_vertical:'0.02 mm'};
  const { target } = await h.find(data, 'sessao');
  h.rows[2][4] = '0.04 mm';
  assert.equal((await h.write(data, 'sessao', target)).status, 'target_changed');
  h.rows.pop();
  assert.equal((await h.write(data, 'sessao', target)).status, 'target_changed');
  assert.equal(h.writes.length, 0);
});

test('não cria outra linha se o equipamento passou a existir depois da proposta', async () => {
  const h = fakeSheet();
  const data = {vessel:'BRAM Atlas', equipment:'MCP 1'};
  const { target } = await h.find(data, 'sessao');
  h.rows.push(['BRAM Atlas', 'MCP 1', 'WEG', '', '0.04 mm']);
  assert.equal((await h.write(data, 'sessao', target)).status, 'target_changed');
  assert.equal(h.writes.length, 0);
});

test('linhas históricas duplicadas exigem data completa e única', async () => {
  const h = fakeSheet(['BRAM Atlas', 'MCP 1', '', '17/11/2026'],
    ['BRAM Atlas', 'MCP 1', '', '18/11/2026']);
  const data = {vessel:'BRAM Atlas', equipment:'MCP 1'};
  assert.equal((await h.find(data, 'sessao')).status, 'ambiguous_target');
  assert.equal((await h.find({...data, date:'2026-11-18'}, 'sessao')).target.row, 4);
  assert.equal((await h.find({...data, date:'18/11'}, 'sessao')).status, 'ambiguous_target');
  assert.equal(h.writes.length, 0);
});

test('mapeia títulos por nomes e distingue colunas repetidas pelo grupo', () => {
  const mapped = mapHeaders([
    ['Drive Machine', '', '', '', '', 'Histórico', '', '', '', '', '', '', '', '', 'Pés de fixação', 'Tolerâncias', '', '', 'Coupling', 'Máquina Estacionária', '', '', '', 'Reference'],
    ['Vessel', 'Equipment / Tag', 'Equipment Class', 'Maker', 'Model', 'Data', 'Motivação', 'Executor', 'Método', 'Axial Vertical', 'Axial Horizontal', 'Radial Vertical', 'Radial Horizontal', 'Coupling GAP', 'Padrão', 'Axial Tolerance', 'Radial Tolerance', 'Coupling GAP Tolerance', 'Maker/Model', 'Equipment Class', 'Maker', 'Model', 'Document', 'Comments']
  ]);
  assert.equal(mapped.cols.vessel, 0);
  assert.equal(mapped.cols.maker, 3);
  assert.equal(mapped.cols.stationary_maker, 20);
  assert.equal(mapped.cols.comments, 23);
  const onlyStationary = mapHeaders([['Máquina Estacionária'], ['Maker']]);
  assert.deepEqual(onlyStationary.cols, {stationary_maker:0});
});
