const fs = require('fs');
const crypto = require('crypto');

const FIELDS = {
  'vessel':'vessel', 'embarcação':'vessel', 'embarcacao':'vessel', 'navio':'vessel',
  'equipment':'equipment', 'equipment / tag':'equipment', 'equipment/tag':'equipment',
  'tag do equipamento':'equipment', 'equipment id':'equipment', 'equipamento':'equipment',
  'axial vertical':'axial_vertical', 'axial horizontal':'axial_horizontal',
  'radial vertical':'radial_vertical', 'radial horizontal':'radial_horizontal',
  'equipment class':'class', 'classe do equipamento':'class',
  'maker':'maker', 'fabricante':'maker', 'model':'model', 'modelo':'model',
  'stationary equipment class':'stationary_class', 'stationary maker':'stationary_maker',
  'stationary model':'stationary_model', 'data':'date', 'date':'date',
  'motivacao':'motivation', 'motivation':'motivation', 'motivo':'motivation',
  'executor':'executor', 'responsavel':'executor', 'método':'method', 'metodo':'method',
  'method':'method', 'coupling gap':'coupling_gap', 'gap':'coupling_gap',
  'padrão':'standard', 'padrao':'standard', 'standard':'standard',
  'axial tolerance':'axial_tolerance', 'radial tolerance':'radial_tolerance',
  'coupling gap tolerance':'gap_tolerance', 'document':'document', 'documento':'document',
  'comments':'observations', 'observações':'observations', 'observacoes':'observations', 'observação':'observations', 'observacao':'observations'
};

const fold = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const FIELD_KEYS = Object.fromEntries(Object.entries(FIELDS).map(([label, key]) => [fold(label), key]));

function createConfirmations(file) {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  function prune() {
    const keys = Object.keys(state);
    if (keys.length <= 500) return;
    const removable = keys
      .filter(k => state[k]?.status === 'superseded')
      .sort((a, b) => (state[a]?.createdAt || 0) - (state[b]?.createdAt || 0));
    while (Object.keys(state).length > 500 && removable.length) {
      delete state[removable.shift()];
    }
  }
  function save() {
    prune();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), {mode:0o600});
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  }
  return {
    prepare(group, sessionId, proposal) {
      const canonical = JSON.stringify({group, sessionId, kind:proposal.kind, tabs:proposal.tabs, data:proposal.data, conflicts:proposal.conflicts,
        target:proposal.target?.revision, parentKey:proposal.parentKey, text:proposal.text});
      const key = crypto.createHash('sha256').update(canonical).digest('hex');
      if (Object.values(state).some(item => item.status === 'sent' && item.group === group && item.sessionId === sessionId &&
        JSON.stringify([item.data,item.conflicts,item.target?.revision,item.text]) === JSON.stringify([proposal.data,proposal.conflicts,proposal.target?.revision,proposal.text]))) return null;
      if (state[key]?.status === 'sent') return null;
      if (state[key]?.status === 'answered') return null;
      if (!proposal.parentKey && proposal.sourceVersion && Object.values(state).some(item =>
        item.group === group && item.sessionId === sessionId && item.sourceVersion === proposal.sourceVersion &&
        (item.status === 'answered' || (item.parentKey && item.status === 'sent')))) return null;
      state[key] = {...proposal, group, sessionId, status:'prepared', createdAt: proposal.createdAt || Date.now()};
      save();
      return {key, text:proposal.text};
    },
    sent(key, messageId) {
      const proposal = state[key];
      for (const [otherKey, item] of Object.entries(state)) {
        if (otherKey !== key && item.group === proposal.group && item.sessionId === proposal.sessionId && ['sent', 'answered'].includes(item.status)) {
          item.status = 'superseded';
        }
      }
      proposal.messageIds = Array.isArray(messageId) ? messageId : [messageId];
      proposal.messageId = proposal.messageIds[proposal.messageIds.length - 1];
      proposal.status = 'sent';
      save();
    },
    lookup(group, quotedId) {
      return Object.entries(state).find(([,v]) => v.group===group && (v.messageId===quotedId || v.messageIds?.includes(quotedId)) && ['sent','selected','answered','superseded'].includes(v.status)) || null;
    },
    selection(group, sessionId) {
      return Object.entries(state).filter(([,v]) => v.group === group && v.sessionId === sessionId && v.kind === 'tab-selection' && v.status !== 'superseded')
        .sort((a,b) => (b[1].createdAt || 0) - (a[1].createdAt || 0))[0] || null;
    },
    get(key) { return state[key] || null; },
    invalidateSelection(key) {
      if (state[key]?.kind === 'tab-selection') { state[key].status = 'superseded'; save(); }
    },
    refreshSelection(key, proposal) {
      if (state[key]?.kind !== 'tab-selection' || state[key].status !== 'sent') return;
      Object.assign(state[key], proposal);
      save();
    },
    choose(key, tabTitle) {
      if (!state[key] || state[key].kind !== 'tab-selection' || state[key].status !== 'sent' || !state[key].tabs.includes(tabTitle)) return false;
      state[key].tabTitle = tabTitle;
      state[key].status = 'selected';
      save();
      return true;
    },
    latestOpen(group) {
      return Object.values(state).filter(v => v.group === group && v.kind !== 'tab-selection' && v.status === 'sent' &&
        (!v.createdAt || Date.now() - v.createdAt <= 24 * 60 * 60 * 1000)).sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0));
    },
    openSelections(group) {
      return Object.entries(state).filter(([,v]) => v.group === group && v.kind === 'tab-selection' && v.status === 'sent' &&
        (!v.createdAt || Date.now() - v.createdAt <= 24 * 60 * 60 * 1000)).sort((a,b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
    },
    done(key, responseId, status='answered', approvedBy='') {
      if (!state[key]) return;
      state[key].status=status;
      state[key].responseId=responseId;
      if (approvedBy) state[key].approvedBy = approvedBy;
      state[key].answeredAt = Date.now();
      save();
    }
  };
}

const stripMentions = text => String(text || '').replace(/@\d+\b/g, '').trim();

function parseCorrection(text, conflicts = [], data = {}) {
  const corrections = [];
  const unknownFields = [];
  const invalidFields = [];
  const source = stripMentions(text);
  const labels = [...new Set(Object.keys(FIELDS).sort((a,b) => b.length-a.length))];
  for (const line of source.split(/\r?\n/)) {
    const match = line.trim().match(/^([^:=]+)\s*[:=]\s*(.+?)\s*$/);
    if (!match) continue;
    const label = fold(match[1]);
    const baseLabel = label.replace(/\s+\([^)]*\)$/, '');
    const group = label.match(/\(([^)]*)\)$/)?.[1] || '';
    let key = FIELD_KEYS[label] || FIELD_KEYS[baseLabel];
    if (/stationary|estacionaria/.test(group)) {
      key = ({class:'stationary_class',maker:'stationary_maker',model:'stationary_model'})[key] || key;
    }
    if (!key) unknownFields.push(match[1].trim());
    if (key) {
      let value = match[2].trim();
      if (['axial_vertical','axial_horizontal','radial_vertical','radial_horizontal'].includes(key)) {
        const measured = value.match(/^([+-]?\d+(?:[.,]\d+)?)\s*(mm|cm|µm|μm|um|mils?|in|pol)?$/i);
        if (!measured) { invalidFields.push(match[1].trim()); continue; }
        let unit = measured[2];
        if (!unit) {
          const evidence = [data[key], ...conflicts.filter(c => FIELD_KEYS[fold(c.field)] === key).flatMap(c => [c.caption,c.visual])];
          const units = [...new Set(evidence.flatMap(v => {
            const m = String(v || '').match(/[+-]?\d+(?:[.,]\d+)?\s*(mm|cm|µm|μm|um|mils?|in|pol)\b/i);
            return m ? [m[1].toLowerCase().replace('μ','µ')] : [];
          }))];
          if (units.length === 1) [unit] = units;
        }
        if (!unit) { invalidFields.push(match[1].trim()); continue; }
        value = `${measured[1].replace(',', '.')} ${unit.toLowerCase()}`;
      }
      corrections.push({key, value});
    }
  }
  for (const conflict of conflicts) {
    const key = FIELD_KEYS[fold(conflict.field)];
    if (!key || corrections.some(change => change.key === key)) continue;
    const label = labels.find(item => FIELD_KEYS[fold(item)] === key);
    if (!label) continue;
    const pattern = new RegExp(`\\b${label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s+([+-]?\\d+(?:[.,]\\d+)?)\\s*mm\\b`, 'i');
    const match = source.match(pattern);
    if (match) corrections.push({key, value:match[1].replace(',', '.') + ' mm'});
  }
  if (!corrections.length && conflicts.length === 1) {
    const key = FIELD_KEYS[fold(conflicts[0].field)];
    const bare = source.trim().match(/^(?:é|e|o correto é|correto é|valor correto é|fica em)?\s*([+-]?\d+(?:[.,]\d+)?)\s*mm[.!]?$/i);
    if (key && bare) corrections.push({key, value:bare[1].replace(',', '.') + ' mm'});
  }
  const seen = new Set();
  const result = corrections.filter(change => {
    if (seen.has(change.key)) return false;
    seen.add(change.key);
    return true;
  });
  Object.defineProperty(result, 'unknownFields', {value:unknownFields});
  Object.defineProperty(result, 'invalidFields', {value:invalidFields});
  return result;
}

function isApproval(text) {
  text = stripMentions(text);
  if (/\?|\bn[aã]o\b/i.test(String(text || ''))) return false;
  if (/^confirm(?:o|ad[oa])\s+(?:os\s+)?dados[.!\s]*$/i.test(String(text || '').trim())) return true;
  return /^(?:(?:sim|ok|confirmo|confirmado|correto|corretos|certo|certa|aprovado|aprovada)(?:[,;:\s]+(?:sim|ok|confirmo|confirmado|correto|corretos|certo|certa|está correto|esta correto|está certo|esta certo|pode registrar|pode gravar|aprovado|aprovada))?|está correto|esta correto|está certo|esta certo|tudo certo|pode registrar|pode gravar)[.!\s]*$/i.test(String(text || '').trim());
}

module.exports = {createConfirmations, parseCorrection, isApproval, fold, FIELD_KEYS};
