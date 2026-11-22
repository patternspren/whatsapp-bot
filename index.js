const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { google } = require('googleapis');
google.options({ fetchImplementation: fetch });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('pino');

const spreadsheetId = process.env.SPREADSHEET_ID;
const geminiEnabled = process.env.GEMINI_CONVERSATION_ENABLED === 'true';

if (!spreadsheetId) {
  throw new Error('Configure SPREADSHEET_ID no ambiente antes de iniciar.');
}
if (geminiEnabled && !process.env.GEMINI_API_KEY) {
  throw new Error('GEMINI_CONVERSATION_ENABLED requer GEMINI_API_KEY.');
}
if (geminiEnabled && !process.env.CONFIG_SPREADSHEET_ID) {
  throw new Error('GEMINI_CONVERSATION_ENABLED requer CONFIG_SPREADSHEET_ID.');
}
if (geminiEnabled) {
  console.log('Gemini aguardará menção explícita antes de processar uma conversa do grupo.');
}

// ADC uses the VM's attached service account on Compute Engine.
// No downloaded service-account private key is needed.
const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });

const seenFile = path.join(__dirname, 'processed-message-ids.json');
const sessionsFile = path.join(__dirname, 'alignment-sessions.json');
const pendingFile = path.join(__dirname, 'pending-alignment.jsonl');
const failedAttachmentsDir = path.join(__dirname, 'failed-attachments');
let seenIds = new Set();
try {
  seenIds = new Set(JSON.parse(fs.readFileSync(seenFile, 'utf8')));
} catch {
  // Primeira execução: ainda não há IDs processados.
}

function hasSeen(groupJid, messageId) {
  return Boolean(messageId) && (seenIds.has(`${groupJid}:${messageId}`) || seenIds.has(messageId));
}

function markSeen(groupJid, messageId) {
  if (!messageId) return;
  seenIds.add(groupJid ? `${groupJid}:${messageId}` : messageId);
}

function saveSeenIds() {
  const payload = JSON.stringify([...seenIds].slice(-10000), null, 2);
  if (typeof fs.renameSync === 'function') {
    const tmp = seenFile + '.tmp';
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    fs.chmodSync?.(tmp, 0o600);
    fs.renameSync(tmp, seenFile);
    fs.chmodSync?.(seenFile, 0o600);
    return;
  }
  fs.writeFileSync(seenFile, payload);
}

function appendPending(entry) {
  fs.appendFileSync(pendingFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
  fs.chmodSync?.(pendingFile, 0o600);
}

function archiveFailedAttachment(groupJid, messageId, mimeType, data) {
  if (!Buffer.isBuffer(data) || !data.length) return null;
  const key = crypto.createHash('sha256').update(`${groupJid}|${messageId || Date.now()}`).digest('hex').slice(0, 24);
  const extension = mimeType === 'application/pdf' ? '.pdf' : mimeType === 'image/png' ? '.png' :
    mimeType === 'image/webp' ? '.webp' : '.jpg';
  fs.mkdirSync(failedAttachmentsDir, { recursive: true, mode: 0o700 });
  fs.chmodSync?.(failedAttachmentsDir, 0o700);
  const file = path.join(failedAttachmentsDir, key + extension);
  fs.writeFileSync(file, data, { mode: 0o600 });
  fs.chmodSync?.(file, 0o600);
  return path.relative(__dirname, file);
}

function unwrapMessage(message) {
  let current = message;
  while (current?.ephemeralMessage?.message || current?.viewOnceMessage?.message ||
         current?.viewOnceMessageV2?.message || current?.viewOnceMessageV2Extension?.message ||
         current?.documentWithCaptionMessage?.message || current?.editedMessage?.message) {
    current = current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.viewOnceMessageV2Extension?.message ||
      current.documentWithCaptionMessage?.message ||
      current.editedMessage?.message;
  }
  return current || {};
}

function getMessageText(message) {
  const content = unwrapMessage(message);
  return content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    '';
}

let alignmentTracker = null;
let gemini = null;
let activeSock = null;
let alignmentConfigPromise = null;
let alignmentConfigLoadedAt = 0;
let getAlignmentConfig = async () => ({});
const CONFIG_TTL_MS = 30 * 60 * 1000;
const groupTitleCache = new Map();
const {createConfirmations, parseCorrection, isApproval} = require('./confirmations');
const history = require('./alignment_history');
const confirmations = createConfirmations(path.join(__dirname, 'alignment-confirmations.json'));
const confirmationQueues = new Map();
const groupMessageQueues = new Map();
const foldText = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const parseEnvList = value => String(value || '').split(/[,;]/).map(item => item.trim()).filter(Boolean);
const authorizedApprovers = parseEnvList(process.env.AUTHORIZED_APPROVERS);
const allowedGroupJids = new Set(parseEnvList(process.env.ALLOWED_GROUP_JIDS).map(item => item.toLowerCase()));
const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

function enqueueByGroup(queueMap, group, operation) {
  const key = group || '__default__';
  const prev = queueMap.get(key) || Promise.resolve();
  const result = prev.then(operation);
  const settled = result.catch(() => {});
  queueMap.set(key, settled);
  settled.finally(() => {
    if (queueMap.get(key) === settled) queueMap.delete(key);
  });
  return result;
}

function serializeConfirmations(group, operation) {
  if (typeof group === 'function') {
    operation = group;
    group = '__extract__';
  }
  return enqueueByGroup(confirmationQueues, group, operation);
}

function serializeGroup(group, operation) {
  return enqueueByGroup(groupMessageQueues, group, operation);
}

const preMentionMessages = new Map();
const armedGroups = new Map();
const GROUP_ARM_WINDOW_MS = 2 * 60 * 60 * 1000;

function messageContextInfo(content) {
  return content.extendedTextMessage?.contextInfo || content.imageMessage?.contextInfo ||
    content.documentMessage?.contextInfo || content.videoMessage?.contextInfo || {};
}

function jidDigits(value) {
  const [user, domain] = String(value || '').toLowerCase().split('@');
  return user && domain ? `${user.split(':')[0]}@${domain}` : '';
}

function approverMatches(candidate, allowed) {
  if (!candidate || !allowed) return false;
  if (allowed.includes('@')) return jidDigits(candidate) === jidDigits(allowed);
  const allowedDigits = allowed.replace(/\D/g, '');
  const [user, domain] = String(candidate).toLowerCase().split('@');
  const candidateDigits = String(user || '').split(':')[0].replace(/\D/g, '');
  return Boolean(allowedDigits) && domain !== 'lid' && candidateDigits === allowedDigits;
}

function isAuthorizedForConfirmation(msg, entry) {
  const senders = [msg.key?.participant, msg.key?.participantAlt].filter(Boolean);
  if (!senders.length) return false;
  if (authorizedApprovers.length) {
    return senders.some(sender => authorizedApprovers.some(allowed => approverMatches(sender, allowed)));
  }
  if (process.env.RESTRICT_CONFIRMATION_TO_REQUESTER === 'true') return !!entry.authorizedSender && senders.some(sender => jidDigits(sender) === jidDigits(entry.authorizedSender));
  return true;
}

function explicitlyMentionsBot(sock, content) {
  const botIds = new Set([sock.user?.id, sock.user?.lid].map(jidDigits).filter(Boolean));
  const mentions = messageContextInfo(content).mentionedJid || [];
  return mentions.some(jid => botIds.has(jidDigits(jid)));
}

function cacheBeforeMention(group, msg) {
  const now = Date.now();
  const messages = (preMentionMessages.get(group) || []).filter(item => now - item.time < GROUP_ARM_WINDOW_MS);
  messages.push({time:now, msg});
  preMentionMessages.set(group, messages.slice(-60));
}

const REQUIRED_ALIGNMENT_FIELDS = [
  { key: 'date', label: 'Data' },
  { key: 'motivation', label: 'Motivação' },
  { key: 'executor', label: 'Executor' },
  { key: 'method', label: 'Método' },
  { key: 'axial_vertical', label: 'Axial Vertical' },
  { key: 'axial_horizontal', label: 'Axial Horizontal' },
  { key: 'radial_vertical', label: 'Radial Vertical' },
  { key: 'radial_horizontal', label: 'Radial Horizontal' },
  { key: 'coupling_gap', label: 'Coupling GAP' }
];

function stripMentions(text) {
  return String(text || '')
    .split('\n')
    .map(line => line.replace(/(?:^|\s)@\S+/g, ' ').replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function getMissingRequiredFields(effectiveData, conflicts = []) {
  const conflictLabels = new Set(conflicts.map(c => foldText(c.field)));
  return REQUIRED_ALIGNMENT_FIELDS.filter(({ key, label }) => {
    const val = effectiveData[key];
    return !history.isKnown(val) ||
      foldText(val) === 'usuario passou informacao divergente' ||
      conflictLabels.has(foldText(label));
  });
}

async function publishReview(sock, group, sessionId, proposal, options = {}) {
  const { data, conflicts = [] } = proposal;
  const { target: resolved, status, schema } = await history.resolveRecordTarget(sheets, spreadsheetId, data, sessionId);
  const lostExistingRow = proposal.requireExisting && !resolved?.row;
  const target = lostExistingRow ? null : resolved;

  const conflictKeys = new Set(conflicts.map(c => foldText(c.field)));
  const fieldKeyByLabel = {
    'axial vertical': 'axial_vertical',
    'axial horizontal': 'axial_horizontal',
    'radial vertical': 'radial_vertical',
    'radial horizontal': 'radial_horizontal',
    'coupling gap': 'coupling_gap'
  };
  const dataToWrite = { ...data };
  for (const conflict of conflicts) {
    const k = fieldKeyByLabel[foldText(conflict.field)];
    if (k) delete dataToWrite[k];
  }

  let writeResult = null;
  let nextTarget = target;
  const mergedCurrent = { ...(target?.current || {}) };
  for (const [k, v] of Object.entries(dataToWrite)) {
    if (history.isKnown(v)) mergedCurrent[k] = v;
  }

  if (target) {
    const writeId = options.confirmationId || crypto.createHash('sha256')
      .update(JSON.stringify({ sessionId, dataToWrite, row: target.row })).digest('hex').slice(0, 16);
    writeResult = await history.recordHistory(sheets, spreadsheetId, {
      ...dataToWrite,
      groupJid: group,
      approvedBy: options.senderId || proposal.authorizedSender || ''
    }, sessionId, { target, confirmationId: writeId });

    if (!['appended', 'updated', 'unchanged'].includes(writeResult.status)) {
      appendPending({ groupJid: group, sessionId, reason: writeResult.status });
      if (!sock) return false;
      try {
        await sock.sendMessage(group, { text: 'A planilha mudou durante a gravação. Reenvie ou mencione o bot para tentar novamente.' });
      } catch {}
      return false;
    }

    const row = writeResult.row || target.row;
    try {
      const refreshed = await history.resolveRecordTarget(sheets, spreadsheetId, {
        ...mergedCurrent,
        vessel: mergedCurrent.vessel || data.vessel,
        equipment: mergedCurrent.equipment || data.equipment
      }, sessionId);
      nextTarget = refreshed.target || { ...target, row, current: mergedCurrent };
    } catch {
      nextTarget = { ...target, row, current: mergedCurrent };
    }
    if (nextTarget?.current) {
      for (const [k, v] of Object.entries(nextTarget.current)) {
        if (history.isKnown(v)) mergedCurrent[k] = v;
      }
    }
    console.log('Gravação verificada:', group, sessionId, row || 'linha desconhecida');
  }

  const missing = getMissingRequiredFields(mergedCurrent, conflicts);
  const row = writeResult?.row || nextTarget?.row;
  const identityLabel = [mergedCurrent.vessel || data.vessel, mergedCurrent.equipment || data.equipment]
    .filter(v => history.isKnown(v)).join(' — ');

  let text;
  if (!target) {
    const destination = lostExistingRow
      ? 'A linha existente deixou de ser identificável. Informe a embarcação, o equipamento e a data.'
      : status === 'identity_missing'
        ? 'Não consegui identificar a linha ainda. Informe a embarcação e o equipamento (ex.: “Vessel: Joe Griffin” e “Equipment / Tag: MCP”).'
        : 'A linha ainda não foi identificada com segurança. Informe a embarcação, o equipamento e a data completa.';
    text = [
      destination,
      missing.length ? 'Campos obrigatórios ainda pendentes:\n' + missing.map(f => `- ${f.label}`).join('\n') : '',
      'Responda esta mensagem ou mencione o bot com os dados no formato “Campo: valor”.'
    ].filter(Boolean).join('\n');
  } else if (missing.length === 0 && conflicts.length === 0) {
    const header = writeResult.status === 'appended'
      ? `Dados gravados na nova linha ${row} da planilha${identityLabel ? ` (${identityLabel})` : ''}.`
      : `Dados atualizados na linha ${row} da planilha${identityLabel ? ` (${identityLabel})` : ''}.`;
    text = `${header}\nTodos os campos obrigatórios foram preenchidos!`;
  } else {
    const header = writeResult.status === 'appended'
      ? `Dados recebidos gravados na nova linha ${row} da planilha${identityLabel ? ` (${identityLabel})` : ''}.`
      : writeResult.status === 'updated'
        ? `Dados atualizados na linha ${row} da planilha${identityLabel ? ` (${identityLabel})` : ''}.`
        : `Linha ${row} conferida${identityLabel ? ` (${identityLabel})` : ''}.`;
    text = [
      header,
      proposal.attachmentPending ? 'A leitura do anexo falhou ou ficou incompleta; os dados da legenda foram gravados.' : '',
      ...conflicts.map(c => `Divergência em ${c.field}: legenda ${c.caption || 'não informada'}; imagem ${c.visual || 'não legível'}.`),
      missing.length ? `Ainda faltam estas informações para completar a linha ${row}:\n` + missing.map(f => `- ${f.label}`).join('\n') : '',
      'Responda esta mensagem ou mencione o bot informando o que falta (ex.: “Executor: Navship” ou “Coupling GAP: 25 mm”). Vou preencher automaticamente na mesma linha.'
    ].filter(Boolean).join('\n');
  }

  const prompt = confirmations.prepare(group, sessionId, {
    ...proposal,
    data: mergedCurrent,
    conflicts,
    target: nextTarget ?? null,
    requireExisting: Boolean(row),
    text
  });
  if (!prompt) return true;
  if (!sock) return false;
  try {
    const sent = await sock.sendMessage(group, { text: prompt.text });
    if (!sent?.key?.id) throw new Error('Mensagem sem identificador');
    confirmations.sent(prompt.key, sent.key.id);
    if (target && missing.length === 0 && conflicts.length === 0) {
      confirmations.done(prompt.key, sent.key.id, 'answered', options.senderId || '');
    }
    console.log('Atualização enviada:', group, sessionId, sent.key.id);
    return true;
  } catch {
    appendPending({ groupJid: group, sessionId, reason: 'notificação não enviada após gravação' });
    return false;
  }
}

if (geminiEnabled) {
  const { createTracker, fileStore, makeGeminiFunctions, verifyExtractions } = require('./gemini_conversation');
  const { loadAlignmentConfig } = require('./alignment_config');
  const store = fileStore(sessionsFile);
  getAlignmentConfig = () => {
    if (!alignmentConfigPromise || Date.now() - alignmentConfigLoadedAt > CONFIG_TTL_MS) {
      alignmentConfigLoadedAt = Date.now();
      alignmentConfigPromise = loadAlignmentConfig(sheets, process.env.CONFIG_SPREADSHEET_ID).catch(error => {
        alignmentConfigPromise = null;
        throw error;
      });
    }
    return alignmentConfigPromise;
  };
  alignmentConfigPromise = getAlignmentConfig();
  gemini = makeGeminiFunctions({
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
    config: getAlignmentConfig,
    getRecordSchema: () => history.getRecordSchema(sheets, spreadsheetId),
    onExtract: (session, reason, extraction, transcript) => serializeConfirmations(session.group, async () => {
      const checkedRecords = verifyExtractions(extraction, transcript);
      const proposed = new Set();
      let pending = 0;
      let deliveryFailed = false;
      const sourceVersion = crypto.createHash('sha256')
        .update(JSON.stringify(session.messages.map(({id, text}) => [id, text]))).digest('hex');
      const fieldKeys = Object.fromEntries(Object.entries({
        'Equipment Class':'class', Maker:'maker', Model:'model',
        'Stationary Equipment Class':'stationary_class', 'Stationary Maker':'stationary_maker',
        'Stationary Model':'stationary_model', Document:'document', Data:'date', Date:'date',
        Motivacao:'motivation', Motivation:'motivation', Motivo:'motivation',
        Executor:'executor', Responsavel:'executor', Metodo:'method', Method:'method',
        'Axial vertical':'axial_vertical', 'Axial horizontal':'axial_horizontal',
        'Radial vertical':'radial_vertical', 'Radial horizontal':'radial_horizontal',
        'Coupling gap':'coupling_gap', 'Padrão':'standard', Standard:'standard',
        'Axial tolerance':'axial_tolerance', 'Radial tolerance':'radial_tolerance',
        'Coupling gap tolerance':'gap_tolerance'
      }).map(([label, key]) => [foldText(label), key]));
      for (const checked of checkedRecords) {
        if (!checked.ok) {
          pending += 1;
          appendPending({ groupJid: session.group, startedAt: session.startedAt,
            closedAt: new Date().toISOString(), reason: checked.reason, messages: session.messages });
          console.log('Alinhamento mantido para revisão:', checked.reason);
          continue;
        }
        const equipmentKey = history.equipmentIdentity(checked.equipment);
        if (proposed.has(equipmentKey)) {
          pending += 1;
          appendPending({ groupJid: session.group, startedAt: session.startedAt,
            reason: `equipamento duplicado na extração: ${checked.equipment}`, messages: session.messages });
          continue;
        }
        proposed.add(equipmentKey);
        const sessionId = crypto.createHash('sha256')
          .update(`${session.group}|${session.startedAt}|${equipmentKey}`).digest('hex').slice(0, 24);
        const extracted = checked.fields || {};
        const data = {
          vessel: checked.vessel, equipment: checked.equipment,
          class: extracted['Equipment Class'], maker: extracted.Maker, model: extracted.Model,
          stationary_class: extracted['Stationary Equipment Class'], stationary_maker: extracted['Stationary Maker'],
          stationary_model: extracted['Stationary Model'], document: extracted.Document,
          date: extracted.Data, motivation: extracted.Motivacao || extracted.Motivation,
          executor: extracted.Executor, method: extracted.Metodo || extracted.Method,
          axial_vertical: extracted['Axial vertical'], axial_horizontal: extracted['Axial horizontal'],
          radial_vertical: extracted['Radial vertical'], radial_horizontal: extracted['Radial horizontal'],
          coupling_gap: extracted['Coupling gap'], standard: extracted['Padrão'],
          axial_tolerance: extracted['Axial tolerance'], radial_tolerance: extracted['Radial tolerance'],
          gap_tolerance: extracted['Coupling gap tolerance'],
          observations: Object.entries(extracted).filter(([key]) => /antes do ajuste|unidade das medições/i.test(key))
            .map(([key, value]) => `${key}: ${value}`).join('; ')
        };
        let conflicts = [];
        for (const msg of session.messages) {
          const text = String(msg.text || '');
          if (!text.includes('Conteúdo lido do anexo:')) continue;
          for (const rawSection of text.slice(text.indexOf('Conteúdo lido do anexo:') + 'Conteúdo lido do anexo:'.length).split(/--- OUTRO EQUIPAMENTO ---/i)) {
            const section = rawSection.trim();
            if (!section) continue;
            let currentEquipment = section.match(/^\s*Equipamento:\s*(.+)$/im)?.[1]?.trim() || '';
            if (!(history.equipmentIdentity(currentEquipment) === equipmentKey || (!currentEquipment && checkedRecords.length === 1))) continue;
            const currentConflicts = [];
            for (const rawLine of section.split('\n')) {
              const line = rawLine.trim();
              const equipmentMatch = line.match(/^Equipamento:\s*(.+)$/i);
              if (equipmentMatch) currentEquipment = equipmentMatch[1].trim();
              if (!line.startsWith('DIVERGENCIA_MEDICAO: ')) continue;
              try {
                const conflict = JSON.parse(line.slice('DIVERGENCIA_MEDICAO: '.length));
                if ((history.equipmentIdentity(currentEquipment) === equipmentKey || checkedRecords.length === 1) &&
                    !currentConflicts.some(item => foldText(item.field) === foldText(conflict.field))) currentConflicts.push(conflict);
              } catch {}
            }
            const validatedFields = new Set(section.split('\n').flatMap(line => {
              const match = line.match(/^\s*([^:]+):\s*([+-]?\d+(?:[.,]\d+)?)\s*(?:mm|cm|µm|μm|um|mil|mils|in|pol)\s*\(fonte:/i);
              return match ? [foldText(match[1])] : [];
            }));
            conflicts = conflicts.filter(item => !validatedFields.has(foldText(item.field)) &&
              !currentConflicts.some(next => foldText(next.field) === foldText(item.field)));
            conflicts.push(...currentConflicts);
          }
        }
        for (const conflict of conflicts) {
          const key = fieldKeys[foldText(conflict.field)];
          if (key) data[key] = 'usuário passou informação divergente';
        }
        const sent = await publishReview(activeSock, session.group, sessionId, {
          data, conflicts, sourceVersion, startedAt:session.startedAt,
          attachmentPending: session.messages.some(m => /\[Leitura do anexo indisponível/.test(m.text)),
          authorizedSender: session.authorizedSender || session.messages.find(m => m.explicitMention && m.senderJid)?.senderJid || ''
        });
        if (!sent) deliveryFailed = true;
      }
      return {proposed:proposed.size, pending, deliveryFailed};
    })
  });

  alignmentTracker = createTracker({
    detect: async (msg, context) => {
      try { return await gemini.detect(msg, context); }
      catch { console.error('Falha ao identificar atividade com Gemini.'); return false; }
    },
    classify: async (previous, current) => {
      try {
        return await gemini.classify(previous, current);
      } catch (error) {
        console.error('Falha de classificação Gemini; mantendo mensagem pendente.');
        return 'uncertain';
      }
    },
    // Analisa a cada cinco minutos e só propõe a gravação depois de uma menção explícita.
    onMessage: async () => {},
    onTick: async (session) => {
      if (!session.activatedByMention) return true;
      try {
        const result = await gemini.finish(session, 'sincronização periódica');
        return result?.deliveryFailed ? false : true;
      }
      catch (error) { console.error('Falha ao sincronizar dados de alinhamento:', error.message); return false; }
    },
    finish: async (session, reason) => {
      if (!session.activatedByMention) return;
      try {
        const result = await gemini.finish(session, reason);
        if (result?.deliveryFailed) {
          appendPending({
            groupJid: session.group,
            startedAt: session.startedAt,
            closedAt: new Date().toISOString(),
            reason: 'falha ao entregar proposta ao fechar sessão',
            messages: session.messages
          });
        }
      } catch (error) {
        appendPending({
          groupJid: session.group,
          startedAt: session.startedAt,
          closedAt: new Date().toISOString(),
          reason: 'falha ao finalizar com Gemini',
          messages: session.messages
        });
        console.error('Sessão salva para revisão após falha do Gemini.');
      }
    },
    save: (state) => store.save(state),
    load: () => store.load(),
    timeoutMs: 2 * 60 * 60 * 1000,
    maxMessages: 5000
  });

  setInterval(() => {
    alignmentTracker.tick().catch((error) => {
      console.error('Falha ao sincronizar sessões de alinhamento:', error.message);
    });
  }, 5 * 60 * 1000).unref();
}

async function handleConfirmation(sock, msg, text, quotedId) {
  const groupJid = msg.key.remoteJid;
  const messageId = msg.key.id;
  const confirmation = confirmations.lookup(groupJid, quotedId);
  if (!confirmation) return false;

  const [key, entry] = confirmation;
  console.log('Resposta de conferência recebida:', groupJid, entry.sessionId, messageId);
  const reply = async text => {
    try { await sock.sendMessage(groupJid, { text, quoted: msg }); } catch {}
  };
  if (!isAuthorizedForConfirmation(msg, entry)) {
    console.log('Resposta rejeitada: remetente não autorizado', groupJid, entry.sessionId);
    await reply(authorizedApprovers.length
      ? 'Somente uma pessoa autorizada pode responder a esta conferência.'
      : 'Somente a pessoa que solicitou esta conferência pode respondê-la. Se necessário, marque o bot para iniciar outra solicitação.');
    return true;
  }
  if (entry.status === 'superseded') {
    console.log('Resposta rejeitada: proposta substituída', groupJid, entry.sessionId);
    await reply('Responda à última mensagem de conferência do bot. Esta versão foi substituída.');
    return true;
  }
  if (entry.status === 'answered') {
    console.log('Resposta rejeitada: proposta já respondida', groupJid, entry.sessionId);
    await reply('Esta conferência já foi validada e gravada na planilha. Marque o bot novamente para iniciar uma nova conferência.');
    return true;
  }
  if (entry.createdAt && Date.now() - entry.createdAt > PROPOSAL_TTL_MS) {
    console.log('Resposta rejeitada: proposta expirada', groupJid, entry.sessionId);
    await reply('Esta proposta de conferência expirou. Marque o bot novamente para gerar uma nova conferência.');
    return true;
  }

  const cleanText = stripMentions(text);
  const corrections = parseCorrection(cleanText, entry.conflicts || [], entry.data || {});
  if (corrections.unknownFields?.length) {
    await reply(`Campo não reconhecido: ${corrections.unknownFields.join(', ')}. Use os nomes dos campos solicitados.`);
    return true;
  }
  if (corrections.invalidFields?.length) {
    await reply(`Informe um valor válido e a unidade para: ${corrections.invalidFields.join(', ')}.`);
    return true;
  }
  if (!corrections.length) {
    if (/\b(?:axial|radial)\s+(?:vertical|horizontal)\s*[:=]?\s*[+-]?\d/i.test(cleanText)) {
      await reply('Informe a unidade da medição (ex.: “Axial Vertical: -0,01 mm”).');
      return true;
    }
    return false;
  }

  const data = { ...entry.data };
  const sessionId = entry.sessionId;
  const approverId = [msg.key.participant, msg.key.participantAlt].map(jidDigits).find(Boolean) || '';
  if (!sessionId) {
    await reply('Esta sessão antiga não pode ser atualizada. Marque o bot para iniciar outra.');
    return true;
  }

  try {
    console.log('Atualização incremental recebida:', groupJid, sessionId, corrections.map(c => c.key).join(','));
    const schema = await history.getRecordSchema(sheets, spreadsheetId);
    const allowed = new Set(schema.flatMap(column => column.mappedAs || []));
    if (corrections.some(({ key }) => !allowed.has(key === 'observations' ? 'comments' : key))) {
      await reply('Um dos campos informados não tem coluna reconhecida na planilha.');
      return true;
    }
    for (const { key, value } of corrections) data[key] = value;
    const conflicts = (entry.conflicts || []).filter(conflict =>
      !corrections.some(change => change.key === parseCorrection(`${conflict.field}: 0 mm`)[0]?.key)
    );
    const saved = await publishReview(sock, groupJid, sessionId, {
      data, conflicts, sourceVersion: entry.sourceVersion, startedAt: entry.startedAt, parentKey: key,
      authorizedSender: entry.authorizedSender, attachmentPending: entry.attachmentPending,
      requireExisting: Boolean(entry.target?.row || entry.requireExisting) && history.sameEquipment(data, entry.data)
    }, { senderId: approverId, confirmationId: key });
    if (saved) {
      if (messageId) { markSeen(groupJid, messageId); saveSeenIds(); }
    } else {
      await reply('Não consegui gravar a atualização agora. Reenvie os dados para tentar novamente.');
    }
  } catch (error) {
    console.error('Falha ao atualizar alinhamento na planilha.', error.message, error.code || error.status || '');
    appendPending({ groupJid, messageId, sessionId, reason: 'falha ao gravar atualização incremental' });
    await reply('Não consegui concluir a gravação no Google Sheets. Reenvie os dados para tentar novamente.');
  }
  return true;
}

async function handleMessageInternal(sock, msg, options = {}) {
  const groupJid = msg.key.remoteJid || '';
  if (!groupJid.endsWith('@g.us') || msg.key.fromMe) return;
  if (allowedGroupJids.size && !allowedGroupJids.has(groupJid.toLowerCase())) return;

  let text = getMessageText(msg.message).trim();
  const content = unwrapMessage(msg.message);
  const image = content.imageMessage;
  const document = content.documentMessage;
  const attachment = image || document;
  if (!text && !attachment) return;

  const messageId = msg.key.id;
  if (hasSeen(groupJid, messageId)) return;

  if (geminiEnabled) {
    const contextInfo = messageContextInfo(content);

    if (contextInfo.stanzaId && await serializeConfirmations(groupJid, () =>
      handleConfirmation(sock, msg, text, contextInfo.stanzaId))) return;

    if (!attachment && !options.replay && !contextInfo.stanzaId) {
      const handled = await serializeConfirmations(groupJid, async () => {
        const open = confirmations.latestOpen?.(groupJid) || [];
        if (!open.length) return false;
        const cleanText = stripMentions(text);
        const correction = parseCorrection(cleanText, open.length === 1 ? open[0].conflicts || [] : [], open.length === 1 ? open[0].data || {} : {});
        if (!correction.length && !correction.invalidFields?.length) return false;
        if (open.length === 1) return handleConfirmation(sock, msg, text, open[0].messageId);
        await sock.sendMessage(groupJid, {text:'Há mais de um alinhamento em aberto. Use “Responder” na mensagem do equipamento específico.', quoted:msg});
        return true;
      });
      if (handled) return;
    }

    const mentioned = explicitlyMentionsBot(sock, content);
    const activeSession = alignmentTracker?.snapshot?.()[groupJid];
    const active = armedGroups.get(groupJid) > Date.now() || activeSession?.activatedByMention === true;
    if (!options.replay && !mentioned && !active) {
      cacheBeforeMention(groupJid, msg);
      return;
    }
    if (mentioned && !options.replay) {
      const buffered = (preMentionMessages.get(groupJid) || []).filter(item => Date.now() - item.time < GROUP_ARM_WINDOW_MS);
      preMentionMessages.delete(groupJid);
      armedGroups.set(groupJid, Date.now() + GROUP_ARM_WINDOW_MS);
      if (activeSession && !activeSession.activatedByMention) await alignmentTracker.clearGroup?.(groupJid);
      for (const item of buffered) await handleMessageInternal(sock, item.msg, {replay:true, activated:true});
      return handleMessageInternal(sock, msg, {replay:true, activated:true, explicitMention:true});
    }
    if (active || options.activated) armedGroups.set(groupJid, Date.now() + GROUP_ARM_WINDOW_MS);

    if (!attachment && /\b(?:relat[oó]rio|report)\b/i.test(text)) {
      console.log('Mensagem sobre relatório sem anexo reconhecido:', groupJid, messageId);
    }

    const cachedGroup = groupTitleCache.get(groupJid);
    let groupName = cachedGroup?.name || '';
    if (!groupName || Date.now() - cachedGroup.time > 60 * 60 * 1000) {
      try {
        groupName = (await sock.groupMetadata(groupJid)).subject || '';
        groupTitleCache.set(groupJid, { name: groupName, time: Date.now() });
      } catch { /* nome do grupo pode não estar disponível temporariamente */ }
    }
    if (attachment) {
      const mimeType = image?.mimetype || document?.mimetype || '';
      const fileName = document?.fileName || '';
      const isOctetPdf = /^application\/octet-stream$/i.test(mimeType) && /\.pdf$/i.test(fileName);
      const effectiveMimeType = isOctetPdf ? 'application/pdf' : mimeType;
      appendPending({stage:'recebida', messageId, groupJid, senderJid:msg.key.participant || '',
        timestamp:msg.messageTimestamp ? String(msg.messageTimestamp) : '', caption:text, mimeType:effectiveMimeType, fileName});
      console.log('Anexo recebido:', groupJid, messageId, effectiveMimeType, fileName);
      if (!/^image\/(jpeg|png|webp)$|^application\/pdf$/i.test(effectiveMimeType)) {
        appendPending({ messageId, groupJid, groupName, fileName, mimeType:effectiveMimeType, reason: 'formato de anexo não suportado' });
        text += `\n[Leitura do anexo indisponível: formato ${fileName || mimeType || 'não identificado'} não suportado.]`;
      } else {
        let data;
        try {
          data = await downloadMediaMessage(
            msg,
            'buffer',
            {},
            {
              logger: P({ level: 'silent' }),
              ...(sock?.updateMediaMessage ? { reuploadRequest: sock.updateMediaMessage } : {})
            }
          );
          if (data.length > 20 * 1024 * 1024) throw new Error('Anexo excede 20 MB');
          const summary = await gemini.inspectAttachment({ caption: text, groupName, fileName, mimeType: effectiveMimeType, data });
          if (summary && image && /\b(?:axial|radial)\s+(?:vertical|horizontal)\s*:\s*[+-]?\d/i.test(text)) {
            const originalCaption = text;
            const labels = [...originalCaption.matchAll(/\b(axial|radial)\s+(vertical|horizontal)\s*:\s*([+-]?\d+(?:[.,]\d+)?)/gi)];
            const safeSummary = String(summary || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
            for (const item of labels) {
              const field = (item[1] + ' ' + item[2]).toLowerCase();
              const value = item[3];
              if (!safeSummary.includes(field + ': ' + value.toLowerCase())) {
                appendPending({ messageId, groupJid, groupName, reason: 'medição da legenda sem confirmação visual', field, value });
              }
            }
            text = text.replace(/\b(axial|radial)\s+(vertical|horizontal)\s*:\s*[+-]?\d+(?:[.,]\d+)?(?:\s*(?:mm|cm|µm|μm|um|mils?|in|pol))?/gi,
              '$1 $2: verificação visual no resumo do anexo');
          }
          if (!summary) {
            const savedAs = archiveFailedAttachment(groupJid, messageId, effectiveMimeType, data);
            appendPending({ messageId, groupJid, groupName, fileName, mimeType:effectiveMimeType, savedAs,
              reason: 'Gemini retornou resumo vazio para o anexo' });
            console.error('Anexo sem dados extraídos:', groupJid, messageId, effectiveMimeType);
            text += '\n[Leitura do anexo indisponível; confira os valores informados na legenda.]';
            if (!text) return;
          } else {
            console.log('Anexo interpretado:', groupJid, messageId, summary.length);
            text = [text, `Conteúdo lido do anexo: ${summary}`].filter(Boolean).join('\n');
          }
        } catch (error) {
          let savedAs = null;
          try { if (data?.length <= 20 * 1024 * 1024) savedAs = archiveFailedAttachment(groupJid, messageId, effectiveMimeType, data); }
          catch (archiveError) { console.error('Falha ao preservar anexo:', archiveError.message); }
          appendPending({ messageId, groupJid, groupName, fileName, mimeType:effectiveMimeType, savedAs,
            reason: `não foi possível ler o anexo: ${error.message}` });
          console.error('Não foi possível ler um anexo da conversa:', error.message);
          text += '\n[Leitura do anexo indisponível; confira os valores informados na legenda.]';
          if (typeof sock?.sendMessage === 'function') {
            try { await sock.sendMessage(groupJid, { text: 'Não consegui ler o anexo enviado; registrei para revisão e vou usar o que estiver informado no texto.', quoted: msg }); } catch {}
          }
        }
      }
    }
    if (!text.trim()) return;
    const timestamp = msg.messageTimestamp
      ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
      : new Date().toISOString();
    const outcome = await alignmentTracker.process({
      group: groupJid,
      id: messageId || '',
      timestamp,
      sender: msg.pushName || '',
      senderJid: msg.key.participant || msg.key.participantAlt || '',
      explicitMention: options.explicitMention === true,
      originalText: getMessageText(msg.message),
      groupName,
      activatedByMention: options.activated === true || active,
      text: groupName ? `[Grupo: ${groupName}]\n${text}` : text
    });
    if (outcome !== 'ignorada' && messageId) {
      markSeen(groupJid, messageId);
      saveSeenIds();
    }
    if (outcome !== 'ignorada') console.log('Coleta de alinhamento:', outcome, groupJid);
    if ((!options.replay || options.explicitMention) && outcome !== 'ignorada' && typeof alignmentTracker?.tick === 'function') {
      await alignmentTracker.tick(groupJid).catch((error) => {
        console.error('Falha ao sincronizar sessão imediatamente:', error.message);
      });
    }
    return;
  }

  if (/\b(?:alinhamento|alignment)\b/i.test(text)) {
    appendPending({ messageId, groupJid, text, reason: 'modo Gemini desativado; coleta conversacional indisponível' });
    console.log('Mensagem de alinhamento colocada para revisão; Gemini está desativado.');
  }
}

async function handleMessage(sock, msg, options = {}) {
  const groupJid = msg?.key?.remoteJid || '';
  if (!groupJid.endsWith('@g.us') || msg.key.fromMe) return;
  if (allowedGroupJids.size && !allowedGroupJids.has(groupJid.toLowerCase())) return;
  if (options.replay) return handleMessageInternal(sock, msg, options);
  return serializeGroup(groupJid, () => handleMessageInternal(sock, msg, options));
}

let reconnectTimer = null;
let reconnectAttempt = 0;
let shuttingDown = false;

async function startBot() {
  if (shuttingDown) return;
  if (geminiEnabled) await getAlignmentConfig();
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info_baileys'));
  const sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
    browser: ['Alignment Collector', 'Chrome', '1.0.0'],
    syncFullHistory: false
  });
  activeSock = sock;

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('Escaneie o QR Code com o WhatsApp que ficará conectado ao grupo:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      reconnectAttempt = 0;
      console.log(geminiEnabled
        ? 'Coletor conectado; aguardando menção explícita em um grupo.'
        : 'Coletor conectado em modo silencioso.');
    }
    if (connection === 'close') {
      if (activeSock === sock) activeSock = null;
      try { sock.ev.removeAllListeners?.(); } catch {}
      const shouldReconnect = !shuttingDown && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        if (!reconnectTimer) {
          const delay = Math.min(3000 * Math.pow(2, reconnectAttempt), 30000);
          reconnectAttempt += 1;
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            startBot().catch(error => console.error('Falha ao reconectar ao WhatsApp:', error.message));
          }, delay);
        }
      } else if (!shuttingDown) {
        console.error('Sessão desconectada. Reinicie e escaneie um novo QR Code.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    const now = Date.now();
    for (const msg of messages) {
      if (!msg.message) continue;
      if (type === 'append') {
        const tsMs = Number(msg.messageTimestamp) * 1000;
        if (!Number.isFinite(tsMs) || now - tsMs > GROUP_ARM_WINDOW_MS) continue;
      }
      try {
        await handleMessage(sock, msg);
      } catch (error) {
        console.error('Falha ao registrar mensagem:', error.message);
      }
    }
  });
}

async function recoverAttachment(savedAs) {
  if (!geminiEnabled) throw new Error('Recuperação requer Gemini ativo.');
  const resolved = path.resolve(__dirname, String(savedAs || ''));
  if (!resolved.startsWith(path.resolve(failedAttachmentsDir) + path.sep)) {
    throw new Error('Arquivo de recuperação deve estar em failed-attachments/.');
  }
  const entries = fs.readFileSync(pendingFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const entry = entries.find(item => item.savedAs === path.relative(__dirname, resolved) && item.groupJid && item.mimeType);
  if (!entry) throw new Error('Anexo não encontrado no registro de pendências.');
  const data = fs.readFileSync(resolved);
  await getAlignmentConfig();
  const summary = await gemini.inspectAttachment({
    caption:'', groupName:entry.groupName, fileName:entry.fileName, mimeType:entry.mimeType, data
  });
  if (!summary) throw new Error('Gemini ainda retornou extração vazia; arquivo mantido para revisão.');
  const store = require('./gemini_conversation').fileStore(sessionsFile);
  const sessions = store.load();
  const timestamp = fs.statSync(resolved).mtime.toISOString();
  const session = sessions[entry.groupJid] || {
    group:entry.groupJid, startedAt:timestamp, lastRelated:Date.now(), messages:[]
  };
  const messageText = `[Grupo: ${entry.groupName || ''}]\nConteúdo lido do anexo: ${summary}`;
  const existingMessage = session.messages.find(message => message.id === entry.messageId);
  if (existingMessage) existingMessage.text = messageText;
  else session.messages.push({group:entry.groupJid, id:entry.messageId, timestamp,
    sender:'', groupName:entry.groupName, text:messageText});
  session.lastRelated = Date.now();
  session.activatedByMention = true;
  delete session.lastAnalyzedMessageCount;
  sessions[entry.groupJid] = session;
  store.save(sessions);
  if (entry.messageId) { markSeen(entry.groupJid, entry.messageId); saveSeenIds(); }
  appendPending({messageId:entry.messageId, savedAs:entry.savedAs,
    recoveredAt:new Date().toISOString(), reason:'anexo recuperado para conferência no WhatsApp'});
  console.log('Anexo recuperado. A instância do bot deve carregar a sessão para enviar a conferência.');
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const pending = [
    ...Array.from(groupMessageQueues.values()),
    ...Array.from(confirmationQueues.values())
  ];
  await Promise.race([
    Promise.allSettled(pending),
    new Promise(resolve => setTimeout(resolve, 10000).unref())
  ]);
  try { activeSock?.end?.(new Error(signal)); } catch {}
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log('Iniciando coletor silencioso de mensagens de alinhamento...');
const operation = process.argv[2] === '--recover-attachment'
  ? recoverAttachment(process.argv[3]) : startBot();
operation.catch((error) => {
  console.error('Não foi possível iniciar o coletor:', error.message);
  process.exit(1);
});
