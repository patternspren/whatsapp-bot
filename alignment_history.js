const { createHash } = require('node:crypto');

const cache = new WeakMap();
const quoteTab = title => "'" + title.replace(/'/g, "''") + "'";
async function listTabs(sheets, spreadsheetId) {
  let entries = cache.get(sheets); if (!entries) { entries = new Map(); cache.set(sheets, entries); }
  const saved = entries.get(spreadsheetId); if (saved && Date.now() - saved.at < 300000) return saved.titles;
  const {data} = await sheets.spreadsheets.get({spreadsheetId, fields:'sheets.properties(sheetId,title)'});
  const titles = (data.sheets || []).map(s => s.properties.title); entries.set(spreadsheetId, {titles, at:Date.now()}); return titles;
}
async function readRange(sheets, spreadsheetId, range, options = {}) {
  try { return await sheets.spreadsheets.values.get({spreadsheetId, range, ...options}); }
  catch (error) { if (/unable to parse range/i.test(error.message || '')) cache.get(sheets)?.delete(spreadsheetId); throw error; }
}
const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
const isKnown = value => !['', 'nao informado', 'desconhecido'].includes(normalize(value));
const equipmentIdentity = value => normalize(value)
  .replace(/\b(?:diesel generator|diesel gerador|gerador diesel|grupo gerador|genset|dg)\s*#?\s*0*(\d+)\b/g, 'dg$1')
  .replace(/\b(?:motor de combustao principal|motor principal|main engine|mcp)(?:\s*#?\s*0*(\d+))?\b/g, (_, num) => num ? `mcp${num}` : 'mcp')
  .replace(/\b(?:gerador de eixo|shaft generator|shaft gen)(?:\s*(?:no\.?\s*)?0*(\d+))?\b/g, (_, num) => num ? `shaftgen${num}` : 'shaftgen').replace(/\b(?:caixa redutora|redutora|gearbox)\b/g, 'gearbox').replace(/(shaftgen\d*)\s*\/\s*gearbox/g, '$1').replace(/\b(?:motor de propulsao(?: principal)?|propulsion engine)(?:\s*(?:no\.?\s*)?#?\s*0*(\d+))?\b/g, (_, num) => num ? `mcp${num}` : 'mcp')
  .replace(/\b(?:bombordo|portside|port)\b/g, 'bb')
  .replace(/\b(?:boreste|starboard|stbd)\b/g, 'be')
  .replace(/[^a-z0-9]/g, '');
const sameEquipment = (first, second) =>
  normalize(first.vessel) === normalize(second.vessel) && equipmentIdentity(first.equipment) === equipmentIdentity(second.equipment);

// Preserva dados conhecidos e retorna conflitos para revisão humana.
function mergeKnownFields(existing, incoming) {
  const result = { ...existing };
  const conflicts = [];
  const missing = value => value == null || String(value).trim() === '' || normalize(value) === 'nao informado';
  for (const [key, value] of Object.entries(incoming)) {
    if (missing(value)) continue;
    if (missing(result[key])) result[key] = value;
    else if (normalize(result[key]) !== normalize(value)) conflicts.push(key);
  }
  return { fields: result, conflicts };
}

const HEADER_KEYS = {
  vessel: ['vessel', 'embarcacao', 'navio'], equipment: ['equipment / tag', 'equipment/tag', 'tag do equipamento', 'equipment id'],
  class: ['equipment class', 'classe do equipamento'], maker: ['maker', 'fabricante'], model: ['model', 'modelo'],
  stationary_class: ['equipment class'], stationary_maker: ['maker'], stationary_model: ['model'],
  date: ['data', 'date'], motivation: ['motivacao', 'motivation', 'motivo'], executor: ['executor', 'responsavel'],
  method: ['metodo', 'method'], axial_vertical: ['axial vertical'], axial_horizontal: ['axial horizontal'],
  radial_vertical: ['radial vertical'], radial_horizontal: ['radial horizontal'], comments: ['comments', 'observacoes', 'observações'],
  coupling_gap: ['coupling gap'], standard: ['padrao', 'padrão'], document: ['document', 'documento'],
  axial_tolerance: ['axial tolerance'], radial_tolerance: ['radial tolerance'], gap_tolerance: ['coupling gap tolerance']
};

function mapHeaders(rows) {
  const groups = rows[0] || [];
  const headers = rows[1] || [];
  const groupAt = [];
  let activeGroup = '';
  for (let i = 0; i < headers.length; i++) {
    const value = groups[i];
    if (String(value || '').trim()) activeGroup = normalize(value);
    groupAt[i] = activeGroup;
  }
  const cols = {};
  for (const [key, aliases] of Object.entries(HEADER_KEYS)) {
    const matches = headers.map((h, i) => aliases.includes(normalize(h)) ? i : -1).filter(i => i >= 0);
    if (matches.length === 1 && ['stationary_class','stationary_maker','stationary_model'].includes(key)) {
      if ((groupAt[matches[0]] || '').includes('maquina estacionaria')) cols[key] = matches[0];
    } else if (matches.length === 1) {
      if (!['maker', 'model', 'class'].includes(key) || !groupAt[matches[0]]?.includes('maquina estacionaria')) cols[key] = matches[0];
    }
    else if (matches.length > 1 && ['maker', 'model', 'class'].includes(key)) {
      const drive = matches.filter(i => groupAt[i]?.includes('drive machine'));
      if (drive.length === 1) cols[key] = drive[0];
    } else if (matches.length > 1 && ['stationary_class','stationary_maker','stationary_model'].includes(key)) {
      const stationary = matches.filter(i => groupAt[i]?.includes('maquina estacionaria'));
      if (stationary.length === 1) cols[key] = stationary[0];
    }
  }
  return { groups, headers, cols };
}

async function getRecordSchema(sheets, spreadsheetId, tabTitle) {
  for (const title of tabTitle === undefined ? await listTabs(sheets, spreadsheetId) : [tabTitle]) {
    const {data} = await readRange(sheets, spreadsheetId, quoteTab(title) + '!A1:ZZ2');
    const {groups, headers, cols} = mapHeaders(data.values || []);
    if (['vessel','equipment','comments'].every(key => cols[key] !== undefined)) return describeColumns(groups, headers, cols);
  }
  throw new Error('Cabeçalhos necessários da planilha ausentes ou ambíguos');
}

function describeColumns(groups, headers, cols) {
  let group = '';
  return headers.map((title, index) => {
    if (groups[index]) group = groups[index];
    return { group, title, mappedAs: Object.keys(cols).filter(key => cols[key] === index) };
  }).filter(column => column.title);
}


const markerParts = value => String(value ?? '').split(/\s*\|\s*/).filter(Boolean);
const userComments = value => markerParts(value).filter(part => !/^(?:session|confirmation|group|recorded_at|approved_by):/i.test(part)).join(' | ');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function singleDateIdentity(value) {
  const text = String(value ?? '').trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  if (iso) return iso.slice(1).join('-');
  const local = text.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
  return local ? [local[3], local[2].padStart(2, '0'), local[1].padStart(2, '0')].join('-') : '';
}

function dateIdentity(value) {
  const text = String(value ?? '').trim();
  const single = singleDateIdentity(text);
  if (single) return single;
  const dates = text.match(/\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4})\b/g);
  if (dates?.length === 2) {
    const start = singleDateIdentity(dates[0]);
    const end = singleDateIdentity(dates[1]);
    if (start && end) return `${start}..${end}`;
  }
  return '';
}

async function readHistory(sheets, spreadsheetId, tabTitle, unformatted = false) {
  const { data } = await readRange(sheets, spreadsheetId, quoteTab(tabTitle) + '!A1:ZZ', unformatted ? {valueRenderOption:'UNFORMATTED_VALUE'} : {});
  const rows = data.values || [];
  const schema = mapHeaders(rows);
  const { cols } = schema;
  if (['vessel', 'equipment', 'comments'].some(key => cols[key] === undefined)) {
    throw new Error('Cabeçalhos necessários ausentes ou ambíguos');
  }
  return { rows, ...schema };
}

function selectRecordTarget(history, data, sessionId, tabTitle) {
  const { rows, cols, headers, groups } = history;
  const vessel = normalize(data.vessel);
  const equipment = equipmentIdentity(data.equipment);
  if (!isKnown(data.vessel) || !isKnown(data.equipment) || !equipment) return { status: 'identity_missing' };
  const candidates = [];
  const sessions = [];
  const unidentified = [];
  for (let index = 2; index < rows.length; index++) {
    const row = rows[index];
    const parts = markerParts(row[cols.comments]);
    if (normalize(row[cols.vessel]) === vessel) {
      if (equipmentIdentity(row[cols.equipment]) === equipment) candidates.push(index);
      if (!isKnown(row[cols.equipment])) unidentified.push(index);
    }
    if (parts.includes(`session:${sessionId}`)) sessions.push(index);
  }

  let index;
  if (sessions.length > 1) return { status: 'ambiguous_target', rows: sessions.map(i => i + 1) };
  if (sessions.length === 1) {
    if (!candidates.includes(sessions[0])) return { status: 'identity_changed' };
    [index] = sessions;
  } else if (candidates.length) {
    const date = dateIdentity(data.date);
    if (date) {
      const matches = candidates.filter(i => dateIdentity(rows[i][cols.date]) === date);
      if (matches.length > 1) return {status:'ambiguous_target', rows:matches.map(i => i + 1)};
      if (matches.length === 1) [index] = matches;
    } else {
      const partial = String(data.date || '').trim().match(/^(\d{1,2})[/.\-](\d{1,2})$/);
      const matches = candidates.filter(i => {
        const existing = String(rows[i][cols.date] || '').trim();
        if (!isKnown(existing)) return true;
        const full = partial && singleDateIdentity(existing);
        return full && full.slice(5) === partial[2].padStart(2,'0') + '-' + partial[1].padStart(2,'0');
      });
      if (candidates.length !== 1 || matches.length !== 1) return {status:'ambiguous_target', rows:candidates.map(i => i + 1)};
      [index] = matches;
    }
  }
  if (index === undefined && unidentified.length) {
    return {status: 'ambiguous_target', rows: unidentified.map(i => i + 1)};
  }

  const current = index === undefined ? {} : Object.fromEntries(
    Object.entries(cols).map(([key, column]) => [key, rows[index][column] ?? ''])
  );
  return {
    status: 'ready',
    target: {
      row: index === undefined ? null : index + 1,
      revision: digest([tabTitle, vessel, equipment, groups, headers, index, current]),
      current
    }
  };
}

async function resolveRecordTarget(sheets, spreadsheetId, data, sessionId, tabTitle) {
  if (tabTitle === undefined) { const tabs = await listTabs(sheets, spreadsheetId); if (tabs.length !== 1) return {status:'ambiguous_tab', tabs}; [tabTitle] = tabs; }
  const history = await readHistory(sheets, spreadsheetId, tabTitle);
  const schema = describeColumns(history.groups, history.headers, history.cols);
  const selected = selectRecordTarget(history, data, sessionId, tabTitle);
  if (selected.target) selected.target.tabTitle = tabTitle;
  return { ...selected, schema };
}

async function recordHistory(sheets, spreadsheetId, data, sessionId, { target, confirmationId } = {}) {
  if (!target?.revision || !confirmationId) return { status: 'confirmation_required' };
  const tabTitle = target.tabTitle;
  if (!tabTitle) return {status:'tab_not_found'};
  const history = await readHistory(sheets, spreadsheetId, tabTitle);
  const { rows, cols, headers } = history;
  const marker = `confirmation:${confirmationId}`;
  const writtenRows = rows.flatMap((row, index) => index >= 2 && markerParts(row[cols.comments]).includes(marker) ? [index + 1] : []);
  if (writtenRows.length === 1) return { status: 'unchanged', row: writtenRows[0] };
  if (writtenRows.length > 1) return { status: 'ambiguous_target', rows: writtenRows };

  const selected = selectRecordTarget(history, data, sessionId, tabTitle);
  if (selected.status !== 'ready') return selected;
  if (selected.target.revision !== target.revision || selected.target.row !== target.row) {
    return { status: 'target_changed' };
  }
  const { row, current } = selected.target;
  const commentParts = markerParts(current.comments);
  const observations = String(data.observations || '').replaceAll('|', '¦').trim();
  for (const part of [
    observations && `Observações: ${observations}`,
    `session:${sessionId}`,
    marker,
    data.groupJid && `group:${data.groupJid}`,
    data.approvedBy && `approved_by:${data.approvedBy}`
  ]) {
    if (part && !commentParts.includes(part)) commentParts.push(part);
  }
  if (row === null) commentParts.push(`recorded_at:${new Date().toISOString()}`);
  const values = Object.entries(cols).flatMap(([key, column]) => {
    const value = key === 'comments' ? commentParts.join(' | ') : data[key];
    if (row === null) {
      return [{ column, value: String(isKnown(value) ? value : 'não informado') }];
    }
    if (!isKnown(value)) {
      if (isKnown(current[key]) || normalize(current[key]) === 'nao informado') return [];
      return [{ column, value: 'não informado' }];
    }
    if (String(current[key]) === String(value)) return [];
    return [{ column, value: String(value) }];
  });

  if (row === null) {
    const newValues = Array(headers.length).fill('');
    for (const { column, value } of values) newValues[column] = value;
    const mappedCols = Object.values(cols);
    const firstCol = mappedCols.length ? Math.min(...mappedCols) : 0;
    const { data: appended } = await sheets.spreadsheets.values.append({
      spreadsheetId, range: `${quoteTab(tabTitle)}!${columnLetter(firstCol + 1)}2:${columnLetter(headers.length)}`,
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [newValues.slice(firstCol)] }
    });
    const updatedRange = appended.updates?.updatedRange;
    const rowNumber = Number(updatedRange?.match(/!\$?[A-Z]+\$?(\d+)/)?.[1]) || undefined;
    const verified = await readHistory(sheets, spreadsheetId, tabTitle, true);
    const actual = rowNumber && verified.rows[rowNumber - 1];
    if (!actual || values.some(({column, value}) => String(actual[column] ?? '') !== String(value))) throw new Error('Gravação não verificada na planilha');
    return { status: 'appended', row: rowNumber };
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: values.map(({ column, value }) => ({
        range: `${quoteTab(tabTitle)}!${columnLetter(column + 1)}${row}`, values: [[value]]
      }))
    }
  });
  const verified = await readHistory(sheets, spreadsheetId, tabTitle, true);
  const actual = verified.rows[row - 1];
  if (!actual || values.some(({column, value}) => String(actual[column] ?? '') !== String(value))) throw new Error('Gravação não verificada na planilha');
  return { status: 'updated', row };
}

function columnLetter(number) {
  let value = number;
  let result = '';
  while (value > 0) { const remainder = (value - 1) % 26; result = String.fromCharCode(65 + remainder) + result; value = Math.floor((value - 1) / 26); }
  return result;
}

module.exports = { listTabs, mapHeaders, getRecordSchema, resolveRecordTarget, recordHistory, isKnown, equipmentIdentity, sameEquipment, userComments, mergeKnownFields };


