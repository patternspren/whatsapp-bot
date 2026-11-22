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
  if (!entry.authorizedSender) return false;
  return senders.some(sender => jidDigits(sender) === jidDigits(entry.authorizedSender));
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

async function publishReview(sock, group, sessionId, proposal) {
  const { data, conflicts } = proposal;
  const { target: resolved, status, schema } = await history.resolveRecordTarget(sheets, spreadsheetId, data, sessionId);
  const lostExistingRow = proposal.requireExisting && !resolved?.row;
  const target = lostExistingRow ? null : resolved;
  const displayLines = schema.filter(column => column.mappedAs?.length).flatMap(column =>
    column.mappedAs.map(key => {
      const repeated = schema.filter(item => item.title === column.title && item.mappedAs?.length).length > 1;
      const title = repeated ? `${column.title} (${column.group})` : column.title;
      const value = key === 'comments'
        ? [history.userComments(target?.current.comments), data.observations].filter(Boolean).join(' | ')
        : data[key];
      const previous = target?.current[key];
      const changedExisting = key !== 'comments' && history.isKnown(value) && history.isKnown(previous) && foldText(value) !== foldText(previous);
      const shown = history.isKnown(value)
        ? (changedExisting ? `${value} (anterior: ${previous})` : value)
        : history.isKnown(previous) ? `${previous} (mantido)` : 'não informado';
      return `${title}: ${shown}`;
    })
  );
  if (data.observations && !schema.some(column => column.mappedAs?.includes('comments'))) {
    displayLines.push(`Observações: ${data.observations}`);
  }
  const destination = target?.row ? `Destino: linha ${target.row} já existente.`
    : target ? 'Destino: nova linha para este equipamento.'
    : lostExistingRow ? 'A linha existente deixou de ser identificável. Confira a embarcação, o equipamento e a data antes de prosseguir.'
    : status === 'too_recent' ? 'A última gravação de equipamento nesta embarcação foi há menos de duas horas. Depois desse intervalo, marque o bot para uma nova conferência.'
    : status === 'identity_missing' ? 'Informe a embarcação e o equipamento para identificar a linha.'
    : 'A linha ainda não foi identificada com segurança. Confira a embarcação, o equipamento e a data completa.';
  const text = [
    'Confira todos os dados do alinhamento antes de gravar na planilha:',
    destination,
    ...displayLines,
    proposal.attachmentPending ? 'A leitura do anexo falhou ou ficou incompleta; os dados da legenda precisam ser conferidos.' : '',
    ...conflicts.map(conflict => `Divergência ${conflict.field}: legenda ${conflict.caption || 'não informada'}; imagem ${conflict.visual || 'não legível'}.`),
    conflicts.length ? 'Escolha o valor correto de cada divergência informando o campo e o valor antes de confirmar.' : '',
    target ? 'Responda diretamente com “confirmo” para validar todos os dados acima.' : '',
    'Para corrigir ou completar algum dado, responda no formato “Campo: valor”. O bot enviará todos os dados para nova confirmação.'
  ].filter(Boolean).join('\n');
  const prompt = confirmations.prepare(group, sessionId, { ...proposal, target: target ?? null, text });
  if (!prompt) return true;
  if (!sock) return false;
  try {
    const sent = await sock.sendMessage(group, { text: prompt.text });
    if (!sent?.key?.id) throw new Error('Mensagem sem identificador');
    confirmations.sent(prompt.key, sent.key.id);
    console.log('Conferência enviada:', group, sessionId, sent.key.id);
    return true;
  } catch {
    appendPending({groupJid:group, sessionId, reason:'proposta pendente: confirmação não enviada'});
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
        const conflicts = [];
        let currentEquipment = '';
        for (const msg of session.messages) for (const line of String(msg.text || '').split('\n')) {
          const equipmentMatch = line.match(/^Equipamento:\s*(.+)$/i);
          if (equipmentMatch) currentEquipment = equipmentMatch[1].trim();
          if (!line.startsWith('DIVERGENCIA_MEDICAO: ')) continue;
          try {
            const conflict = JSON.parse(line.slice('DIVERGENCIA_MEDICAO: '.length));
            if ((history.equipmentIdentity(currentEquipment) === equipmentKey || checkedRecords.length === 1) &&
                !conflicts.some(item => foldText(item.field) === foldText(conflict.field))) conflicts.push(conflict);
          } catch {}
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
  const reply = async text => {
    try { await sock.sendMessage(groupJid, { text, quoted: msg }); } catch {}
  };
  if (!isAuthorizedForConfirmation(msg, entry)) {
    await reply(authorizedApprovers.length
      ? 'Somente uma pessoa autorizada pode responder a esta conferência.'
      : 'Somente a pessoa que solicitou esta conferência pode respondê-la. Se necessário, marque o bot para iniciar outra solicitação.');
    return true;
  }
  if (entry.status === 'superseded') {
    await reply('Responda à última mensagem de conferência do bot. Esta versão foi substituída.');
    return true;
  }
  if (entry.status === 'answered') {
    await reply('Esta conferência já foi validada e gravada na planilha. Marque o bot novamente para iniciar uma nova conferência.');
    return true;
  }
  if (entry.createdAt && Date.now() - entry.createdAt > PROPOSAL_TTL_MS) {
    await reply('Esta proposta de conferência expirou. Marque o bot novamente para gerar uma nova conferência.');
    return true;
  }

  const corrections = parseCorrection(text, entry.conflicts || []);
  const approved = isApproval(text);
  if (!corrections.length && !approved) {
    if (/\b(?:axial|radial)\s+(?:vertical|horizontal)\s*[:=]?\s*[+-]?\d/i.test(text)) {
      await reply('Informe a unidade da medição (ex.: “Axial Vertical: -0,01 mm”).');
    } else {
      await reply('Responda “confirmo” para validar todos os dados ou indique as correções no formato “Campo: valor”.');
    }
    return true;
  }

  const data = { ...entry.data };
  const sessionId = entry.sessionId;
  const approverId = [msg.key.participant, msg.key.participantAlt].map(jidDigits).find(Boolean) || '';
  const makeReview = (conflicts = entry.conflicts || []) => publishReview(sock, groupJid, sessionId, {
    data, conflicts, sourceVersion: entry.sourceVersion, startedAt: entry.startedAt, parentKey: key,
    authorizedSender: entry.authorizedSender, attachmentPending: entry.attachmentPending,
    requireExisting: Boolean(entry.target?.row || entry.requireExisting) && history.sameEquipment(data, entry.data)
  });
  if (!sessionId) {
    await reply('Esta proposta antiga não pode ser validada. Marque o bot para gerar uma nova conferência.');
    return true;
  }

  try {
    if (corrections.length) {
      const schema = await history.getRecordSchema(sheets, spreadsheetId);
      const allowed = new Set(schema.flatMap(column => column.mappedAs || []));
      if (corrections.some(({ key }) => !allowed.has(key === 'observations' ? 'comments' : key))) {
        await reply('Uma das correções aponta para um campo sem coluna reconhecida. Confira os nomes apresentados na proposta.');
        return true;
      }
      for (const { key, value } of corrections) data[key] = value;
      const conflicts = (entry.conflicts || []).filter(conflict =>
        !corrections.some(change => change.key === parseCorrection(`${conflict.field}: 0 mm`)[0]?.key)
      );
      if (await makeReview(conflicts)) {
        if (messageId) { markSeen(groupJid, messageId); saveSeenIds(); }
      } else {
        await reply('Não consegui enviar a proposta corrigida. Responda novamente com as correções para tentar de novo.');
      }
      return true;
    }

    if ((entry.conflicts || []).length) {
      await reply('Ainda há divergências. Informe o campo e o valor escolhido para receber uma nova conferência.');
      return true;
    }
    if (!entry.target) {
      if (entry.target === null) {
        await reply('Ainda preciso identificar o destino. Confira os dados solicitados na mensagem de conferência.');
      } else {
        await makeReview();
      }
      return true;
    }

    const conflictNotes = (entry.conflicts || []).map(item =>
      `${item.field}: legenda ${item.caption || 'não informada'}; imagem ${item.visual || 'não legível'}`
    ).join('; ');
    const result = await history.recordHistory(sheets, spreadsheetId, {
      ...data,
      observations: [data.observations, conflictNotes].filter(Boolean).join('; '),
      groupJid,
      approvedBy: approverId
    }, sessionId, { target: entry.target, confirmationId: key });
    if (!['appended', 'updated', 'unchanged'].includes(result.status)) {
      appendPending({ groupJid, messageId, sessionId, reason: result.status });
      await reply('A planilha mudou ou o destino ficou indefinido. Confira os dados na nova proposta para liberar a gravação.');
      if (!await makeReview()) await reply('Não consegui enviar a nova conferência. Tente confirmar novamente.');
      return true;
    }
    confirmations.done(key, messageId, 'answered', approverId);
    console.log('Gravação verificada:', groupJid, sessionId, result.row || 'linha desconhecida');
    if (messageId) { markSeen(groupJid, messageId); saveSeenIds(); }
    await reply(result.row ? `Dados validados e gravados na linha ${result.row} da planilha.`
      : 'Dados validados e gravados na planilha.');
  } catch (error) {
    console.error('Falha ao processar confirmação de alinhamento.', error.code || error.status || '');
    appendPending({ groupJid, messageId, sessionId, reason: 'falha ao processar confirmação' });
    await reply('Não consegui concluir a confirmação com o Google Sheets. Responda novamente à mensagem de conferência para tentar de novo.');
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
