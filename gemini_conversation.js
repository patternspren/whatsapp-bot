const fs = require('fs');

const DECISIONS = new Set(['related', 'unrelated', 'new_activity', 'uncertain']);
const FIELD_LABELS = {
  equipment_class: 'Equipment Class',
  maker: 'Maker',
  model: 'Model',
  stationary_equipment_class: 'Stationary Equipment Class',
  stationary_maker: 'Stationary Maker',
  stationary_model: 'Stationary Model',
  date: 'Data',
  motivation: 'Motivacao',
  executor: 'Executor',
  method: 'Metodo',
  axial_vertical: 'Axial vertical',
  axial_horizontal: 'Axial horizontal',
  radial_vertical: 'Radial vertical',
  radial_horizontal: 'Radial horizontal',
  coupling_gap: 'Coupling gap',
  standard: 'Padrão',
  document: 'Document',
  axial_tolerance: 'Axial tolerance',
  radial_tolerance: 'Radial tolerance',
  coupling_gap_tolerance: 'Coupling gap tolerance',
  measurement_unit: 'Unidade das medições',
  axial_vertical_before: 'Axial vertical antes do ajuste',
  axial_horizontal_before: 'Axial horizontal antes do ajuste',
  radial_vertical_before: 'Radial vertical antes do ajuste',
  radial_horizontal_before: 'Radial horizontal antes do ajuste'
};

function createTracker({
  classify,
  detect = async msg => /\b(?:alinhamento|alignment)\b/i.test(msg.text),
  finish,
  onMessage = async () => {},
  onTick = async () => {},
  save,
  load = () => ({}),
  now = Date.now,
  timeoutMs = 15 * 60 * 1000,
  maxMessages = 80
}) {
  let sessions = load() || {};
  const recentContext = {};
  const groupQueues = new Map();
  let persistQueue = Promise.resolve();

  const enqueueGroup = (group, fn) => {
    const prev = groupQueues.get(group) || Promise.resolve();
    const next = prev.then(fn);
    const settled = next.catch(() => {});
    groupQueues.set(group, settled);
    settled.finally(() => {
      if (groupQueues.get(group) === settled) groupQueues.delete(group);
    });
    return next;
  };

  async function persist() {
    if (!save) return;
    const snapshot = JSON.parse(JSON.stringify(sessions));
    const next = persistQueue.then(() => save(snapshot));
    persistQueue = next.catch(() => {});
    return next;
  }

  async function close(group, reason) {
    const session = sessions[group];
    if (!session) return;
    await finish(session, reason);
    delete sessions[group];
    await persist();
  }

  async function expireGroup(group, t) {
    const session = sessions[group];
    if (session && t - session.lastRelated >= timeoutMs) {
      await close(group, 'inatividade');
    }
  }

  function newSession(msg, t) {
    return {
      group: msg.group,
      startedAt: msg.timestamp || new Date(t).toISOString(),
      lastRelated: t,
      activatedByMention: msg.activatedByMention === true,
      authorizedSender: msg.explicitMention ? msg.senderJid : '',
      messages: [msg]
    };
  }

  return {
    process: (msg) => {
      if (!msg?.group || !String(msg.text || '').trim()) return Promise.resolve('ignorada');
      return enqueueGroup(msg.group, async () => {
        const t = now();
        await expireGroup(msg.group, t);

        const session = sessions[msg.group];
        if (!session) {
          const context = recentContext[msg.group] || [];
          const detected = msg.explicitMention === true || await detect(msg, context);
          recentContext[msg.group] = [...context, msg].slice(-20);
          if (!detected) return 'ignorada';
          sessions[msg.group] = newSession(msg, t);
          sessions[msg.group].messages = [...context, msg];
          delete recentContext[msg.group];
          await onMessage(sessions[msg.group]);
          await persist();
          return 'aberta';
        }

        if (msg.id && session.messages.some((item) => item.id === msg.id)) return 'duplicada';
        if (msg.activatedByMention === true) session.activatedByMention = true;
        if (msg.explicitMention && msg.senderJid) session.authorizedSender = msg.senderJid;
        if (session.messages.length >= maxMessages) {
          await close(msg.group, 'limite de mensagens');
          if (msg.explicitMention === true || await detect(msg)) {
            sessions[msg.group] = newSession(msg, t);
            await onMessage(sessions[msg.group]);
            await persist();
            return 'aberta';
          }
          return 'limite atingido';
        }

        let decision = await classify(session.messages, msg);
        if (msg.explicitMention === true && decision === 'unrelated') decision = 'uncertain';
        if (!DECISIONS.has(decision)) throw new Error('Classificação inválida do Gemini');
        if (decision === 'unrelated') return decision;

        if (decision === 'new_activity') {
          const authorizedSender = session.authorizedSender;
          await close(msg.group, 'novo equipamento');
          sessions[msg.group] = newSession(msg, t);
          sessions[msg.group].authorizedSender ||= authorizedSender;
        } else {
          session.messages.push(msg);
          if (decision === 'related') session.lastRelated = t;
        }
        if (decision !== 'unrelated') await onMessage(sessions[msg.group]);
        await persist();
        return decision;
      });
    },
    tick: async (targetGroup = null) => {
      const groups = targetGroup ? (sessions[targetGroup] ? [targetGroup] : []) : Object.keys(sessions);
      await Promise.all(groups.map(group => enqueueGroup(group, async () => {
        await expireGroup(group, now());
        const session = sessions[group];
        if (!session || session.lastAnalyzedMessageCount === session.messages.length) return;
        const synced = await onTick(session);
        if (synced !== false) {
          session.lastAnalyzedMessageCount = session.messages.length;
          await persist();
        }
      })));
    },
    clearGroup: (group) => enqueueGroup(group, async () => {
      delete sessions[group];
      delete recentContext[group];
      await persist();
    }),
    snapshot: () => JSON.parse(JSON.stringify(sessions))
  };
}

function fileStore(file) {
  return {
    load: () => {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
      }
    },
    save: (state) => {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, file);
      fs.chmodSync(file, 0o600);
    }
  };
}

async function geminiJson(apiKey, prompt, model = 'gemini-3.1-flash-lite', media = []) {
  if (!apiKey) throw new Error('GEMINI_API_KEY ausente');

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model) + ':generateContent';
  const timeoutMs = 50000;
  const maxAttempts = 3;
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }, ...media.map(item => ({
            inline_data: { mime_type: item.mimeType, data: Buffer.from(item.data).toString('base64') }
          }))] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0 }
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const error = new Error('Gemini HTTP ' + response.status);
        error.status = response.status;
        throw error;
      }

      const json = await response.json();
      const candidate = json.candidates?.[0];
      const rawText = candidate?.content?.parts?.map((part) => part.text || '').join('');
      if (!rawText) {
        const reason = candidate?.finishReason ? ` (${candidate.finishReason})` : '';
        throw new Error('Gemini retornou resposta vazia' + reason);
      }
      const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      return JSON.parse(cleaned);
    } catch (error) {
      lastError = error.name === 'AbortError'
        ? new Error('Tempo limite do Gemini após ' + Math.round(timeoutMs / 1000) + ' segundos')
        : error;
      const retryable = error.name === 'AbortError' ||
        error.name === 'TypeError' ||
        error instanceof SyntaxError ||
        [408, 429, 500, 502, 503, 504].includes(error.status);

      if (!retryable || attempt + 1 >= maxAttempts) throw lastError;
    } finally {
      clearTimeout(timer);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
  }

  throw lastError;
}

function makeGeminiFunctions({ apiKey, model, onExtract, config, getRecordSchema = async () => ({}) }) {
  const configContext = async () => JSON.stringify((typeof config === 'function' ? await config() : await config) || {});
  async function detect(message, context = []) {
    const result = await geminiJson(apiKey, [
      'Identifique pelo contexto se a conversa descreve uma atividade de alinhamento de máquinas ou eixos, mesmo sem usar a palavra alinhamento.',
      'Considere português, inglês, flexões, sinônimos e contexto técnico; não inicie coleta por conversa genérica ou ambígua.',
      'Use o nome do grupo como contexto possível da embarcação, mas não conclua atividade de alinhamento apenas pelo título.',
      'GRUPO: ' + JSON.stringify(message.groupName || ''),
      'MENSAGENS RECENTES DO GRUPO: ' + JSON.stringify(context.map(item => ({sender:item.sender,text:item.text}))),
      'Responda somente JSON: {"alignment":true|false}.',
      'MENSAGEM: ' + JSON.stringify(message.text)
    ].join('\n'), model);
    return result?.alignment === true;
  }
  async function inspectAttachment({ caption, groupName, fileName, mimeType, data }) {
    if (/\b(?:procedimento|instru[cç][aã]o|manual)\b/i.test(fileName || '') &&
        /alinhamento|alignment/i.test(fileName || '') && !caption?.trim()) return 'Documento de referência sobre procedimento de alinhamento; nenhuma atividade ou medição reportada.';
    const schema = await getRecordSchema();
    const result = await geminiJson(apiKey, [
      'Leia o documento inteiro. Primeiro identifique cada equipamento distinto que teve alinhamento. Um relatório com quatro geradores exige quatro registros separados, mesmo quando faltam medições.',
      'Retorne JSON {"records":[{"vessel":"nome literal ou null","equipment":"tag literal","facts":[{"field":"título da coluna","value":"valor literal","evidence":"trecho literal ou identificação da figura e página"}]}]}. Se não houver atividade de alinhamento, retorne records vazio.',
      'Para cada equipamento, compare com os cabeçalhos e use exatamente o título da coluna em field. Extraia GAP final, data e resultados finais quando legíveis; se um campo não estiver claro, omita esse fato. Preserve unidades, números e sinais.',
      'Não confunda folga de virabrequim com Coupling GAP. Não confunda medições antes/depois, tolerâncias e resultados. Não atribua executor pelo autor do documento. Não misture números de equipamentos diferentes.',
      'Referência do procedimento de coleta: na tela PRUFTECHNIK compatível, leia somente o quadro final inferior direito. V superior = axial vertical; V inferior = radial vertical; H superior = axial horizontal; H inferior = radial horizontal. A tabela pequena acima contém amostras e não é resultado final.',
      'Associe cada foto ao equipamento e bordo pelo título imediatamente abaixo dela: port/portside = bombordo; stbd/starboard = boreste. Texto que diga apenas que port e starboard foram checados não fornece números de ambos. Método laser só se explicitamente indicado para aquele equipamento.',
      'A data de emissão da docagem não é a data da medição. Não use data exibida em foto se não for inequívoco que corresponde ao resultado final daquele equipamento. Um procedimento explicativo é referência, não uma atividade de alinhamento.',
      'Se resultados estiverem em fotos de tela, leia-os quando inequívocos e identifique figura/página; caso contrário, omita-os. A falta de alguns campos nunca elimina os demais registros.',
      'NOME DO GRUPO: ' + JSON.stringify(groupName || ''),
      'ARQUIVO: ' + JSON.stringify(fileName || ''),
      'LEGENDA: ' + JSON.stringify(caption || ''),
      'CABEÇALHOS DA PLANILHA: ' + JSON.stringify(schema)
    ].join('\n'), model, [{ mimeType, data }]);
    const records = Array.isArray(result) && result.length === 1 && Array.isArray(result[0]?.records)
      ? result[0].records : Array.isArray(result) ? result : result?.records;
    if (!Array.isArray(records)) return typeof result?.summary === 'string' ? result.summary.trim() : '';
    const fold = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    const mappedColumns = schema.filter(col => col.mappedAs?.length);
    const titleCounts = new Map();
    for (const col of mappedColumns) {
      const base = fold(col.title);
      titleCounts.set(base, (titleCounts.get(base) || 0) + 1);
    }
    const validTitles = new Map();
    for (const col of mappedColumns) {
      const base = fold(col.title);
      const count = titleCounts.get(base) || 0;
      const displayTitle = count > 1 && col.group ? `${col.title} (${col.group})` : col.title;
      if (count > 1 && col.group) {
        validTitles.set(fold(`${col.title} (${col.group})`), displayTitle);
      }
      if (!validTitles.has(base)) validTitles.set(base, col.title);
    }
    // A legenda da pessoa e a tela são fontes independentes. Em caso de divergência,
    // preserve o registro parcial e sinalize o campo em vez de gravar um número incerto.
    if (/^image\//i.test(mimeType) && caption) {
      const names = { 'axial vertical':'Axial Vertical', 'radial vertical':'Radial Vertical',
        'axial horizontal':'Axial Horizontal', 'radial horizontal':'Radial Horizontal' };
      const normUnit = unit => {
        const u = String(unit || '').trim().toLowerCase().replace('μm', 'µm');
        if (u === 'um') return 'µm';
        if (u === 'mil') return 'mils';
        return u;
      };
      const SUPPORTED_UNITS = new Set(['mm', 'cm', 'µm', 'mils', 'in', 'pol']);
      const labeled = new Map();
      const disagreements = [];
      for (const match of caption.matchAll(/\b(axial|radial)\s+(vertical|horizontal)\s*:\s*([+-]?\d+(?:[.,]\d+)?)(?:\s*(mm|cm|µm|μm|um|mils?|in|pol))?/gi)) {
        labeled.set(names[fold(match[1] + ' ' + match[2])], {
          raw: match[3],
          unit: match[4] ? normUnit(match[4]) : ''
        });
      }
      if (labeled.size) {
        const pictureFields = new Set(Object.keys(names).map(fold));
        for (const record of records) {
          record.facts = (Array.isArray(record.facts) ? record.facts : [])
            .filter(fact => !pictureFields.has(fold(fact.field)));
        }
        try {
          const reading = await geminiJson(apiKey, [
            'Leia SOMENTE a imagem anexada, sem receber a legenda textual. Se houver tela PRUFTECHNIK com quadro de resultados finais no canto inferior direito, transcreva literalmente os dois números V e os dois números H.',
            'V superior = Axial Vertical, V inferior = Radial Vertical; H superior = Axial Horizontal, H inferior = Radial Horizontal. Ignore a pequena tabela de amostras acima e números de pé manco.',
            'Retorne JSON {"compatible":true,"unit":"mm","values":{"Axial Vertical":"0.12","Radial Vertical":"-0.07","Axial Horizontal":"0.04","Radial Horizontal":"-0.03"}}. unit deve ser a unidade visível na tela. Se não houver tela legível, retorne compatible false e values vazio.'
          ].join('\n'), model, [{ mimeType, data }]);
          const visual = Array.isArray(reading) && reading.length === 1 ? reading[0] : reading;
          const visualUnit = normUnit(visual?.unit);
          const number = value => {
            if (typeof value !== 'string' && typeof value !== 'number') return null;
            const match = String(value).trim().match(/^([+-]?\d+(?:[.,]\d+)?)(?:\s*(?:mm|cm|µm|μm|um|mils?|in|pol))?$/i);
            return match ? Number(match[1].replace(',', '.')) : null;
          };
          if (visual?.compatible === true && SUPPORTED_UNITS.has(visualUnit)) {
            for (const [title, item] of labeled) {
              const captionUnit = item.unit || visualUnit;
              const seen = number(visual.values?.[title]);
              if (seen === null || captionUnit !== visualUnit || seen !== number(item.raw)) {
                console.warn('Divergência entre legenda e tela:', title);
                disagreements.push({
                  field: title,
                  caption: `${item.raw} ${captionUnit}`,
                  visual: seen === null ? null : `${seen} ${visualUnit}`
                });
                continue;
              }
              if (!validTitles.has(fold(title)) || records.length !== 1) continue;
              records[0].facts.push({
                field: validTitles.get(fold(title)),
                value: `${item.raw} ${captionUnit}`,
                evidence: `Legenda validada na tela: ${title.toLowerCase()}: ${item.raw} ${captionUnit}`
              });
            }
          } else {
            for (const [title, item] of labeled) {
              disagreements.push({ field: title, caption: `${item.raw} ${item.unit || 'mm'}`, visual: null });
            }
          }
        } catch (error) {
          for (const [title, item] of labeled) {
            disagreements.push({ field: title, caption: `${item.raw} ${item.unit || 'mm'}`, visual: null });
          }
          console.warn('Validação da imagem indisponível:', error.message);
        }
      }
      if (records.length === 1 && disagreements.length) records[0].disagreements = disagreements;
    }
    if (mimeType === 'application/pdf' && records.length && (validTitles.has('data') || validTitles.has('date'))) {
      try {
        const result = await geminiJson(apiKey, [
          'Examine o relatório inteiro e identifique o período geral de execução que abrange explicitamente os equipamentos identificados.',
          'Retorne JSON {"period":{"value":"intervalo literal incluindo as duas datas","evidence":"trecho literal que contém o intervalo","page":1}}.',
          'Use null quando não houver um intervalo geral explícito ou quando sua abrangência for incerta. Não use data de emissão, de criação nem atribua uma data pontual a cada equipamento.',
          'EQUIPAMENTOS: ' + JSON.stringify(records.map(record => record.equipment))
        ].join('\n'), model, [{ mimeType, data }]);
        const period = result?.period;
        if (typeof period?.value === 'string' && typeof period.evidence === 'string' &&
            (period.value.match(/\b\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4}\b/g) || []).length === 2 &&
            fold(period.evidence).includes(fold(period.value))) {
          for (const record of records) {
            record.facts = Array.isArray(record.facts) ? record.facts : [];
            if (!record.facts.some(fact => ['data', 'date'].includes(fold(fact.field)) && typeof fact.value === 'string' &&
                typeof fact.evidence === 'string' && fold(fact.evidence).includes(fold(fact.value)))) {
              record.facts.push({field: validTitles.get('data') || validTitles.get('date') || 'Data', value:period.value,
                evidence:`Período geral do serviço: ${period.evidence} (página ${period.page || 'não indicada'})`});
            }
          }
        }
      } catch (error) {
        console.warn('Leitura complementar do período indisponível:', error.message);
      }
    }
    if (mimeType === 'application/pdf' && records.length > 1 && validTitles.has('coupling gap')) {
      try {
        const supplemental = await geminiJson(apiKey, [
          'Examine o PDF completo. Para cada equipamento numerado, extraia a distância final do GAP do acoplamento entre motor e gerador após alinhamento, quando informada.',
          'Nunca use folga axial do virabrequim, pré GAP nem GAP inicial. Não misture equipamentos. O trecho de evidência deve conter literalmente o valor e a unidade.',
          'Retorne JSON {"records":[{"equipment":"nome literal","coupling_gap":{"value":"número e unidade","evidence":"citação textual com o mesmo número e unidade","page":1}}]}. Use null se não houver medida final clara.',
          'EQUIPAMENTOS IDENTIFICADOS: ' + JSON.stringify(records.map(record => record.equipment))
        ].join('\n'), model, [{ mimeType, data }]);
        const key = value => fold(value)
          .replace(/\b(?:diesel generator|diesel gerador|gerador diesel|grupo gerador|genset|dg)\s*#?\s*0*(\d+)\b/g, 'dg$1')
          .replace(/\b(?:motor de combustao principal|motor principal|main engine|mcp)(?:\s*#?\s*0*(\d+))?\b/g, (_, num) => num ? `mcp${num}` : 'mcp')
          .replace(/\b(?:bombordo|portside|port)\b/g, 'bb')
          .replace(/\b(?:boreste|starboard|stbd)\b/g, 'be')
          .replace(/[^a-z0-9]/g, '');
        const byEquipment = new Map(records.map(record => [key(record.equipment), record]));
        for (const item of supplemental?.records || []) {
          const match = byEquipment.get(key(item.equipment));
          const gap = item.coupling_gap;
          if (!match || typeof gap?.value !== 'string' || typeof gap.evidence !== 'string' ||
              !fold(gap.evidence).includes(fold(gap.value)) ||
              !/gap/i.test(gap.evidence) || /virabrequim|pré.?gap|antes do alinhamento/i.test(gap.evidence)) continue;
          match.facts = Array.isArray(match.facts) ? match.facts : [];
          if (!match.facts.some(fact => /^(?:coupling gap|gap final)$/i.test(fact.field) &&
              typeof fact.value === 'string' && typeof fact.evidence === 'string' &&
              fold(fact.evidence).includes(fold(fact.value)))) {
            match.facts.push({field:'Coupling GAP', value:gap.value,
              evidence:`${gap.evidence} (página ${gap.page || 'não indicada'})`});
          }
        }
      } catch (error) {
        console.warn('Leitura complementar de GAP indisponível:', error.message);
      }
    }
    return records.filter(record => typeof record?.equipment === 'string' && record.equipment.trim())
      .map(record => {
        const facts = (Array.isArray(record.facts) ? record.facts : []).flatMap(fact => {
          if (!fact || typeof fact.field !== 'string' || typeof fact.value !== 'string' ||
              !fact.value.trim() || typeof fact.evidence !== 'string' ||
              !fold(fact.evidence).includes(fold(fact.value))) return [];
          const field = fold(fact.field);
          if (/virabrequim|pre.?gap|inicial|antes/.test(field)) return [];
          const column = validTitles.get(field) || (/^(?:gap final|coupling gap final)$/.test(field)
            ? validTitles.get('coupling gap') : null);
          return column ? [`${column}: ${fact.value} (fonte: ${fact.evidence})`] : [];
        });
        const lines = [
          `Equipamento: ${record.equipment.trim()}`,
          record.vessel ? `Embarcação: ${record.vessel}` : '',
          fileName ? `Document: ${fileName}` : '',
          ...facts,
          ...(record.disagreements || []).map(d => `DIVERGENCIA_MEDICAO: ${JSON.stringify(d)}`)
        ].filter(Boolean);
        return lines.join('\n');
      }).join('\n\n--- OUTRO EQUIPAMENTO ---\n\n');
  }
  async function classify(previousMessages, currentMessage) {
    const transcript = [...previousMessages, currentMessage].map((message, index) => ({
      n: index + 1,
      time: message.timestamp,
      sender: message.sender,
      text: message.text
    }));
    const result = await geminiJson(apiKey, [
      'Você classifica mensagens de um grupo de manutenção que pode conter vários equipamentos por relatório.',
      'Analise a conversa inteira e classifique a mensagem atual em relação à atividade ativa.',
      'Responda somente JSON: {"decision":"related|unrelated|new_activity|uncertain"}.',
      'related: acrescenta, confirma ou corrige informação da mesma atividade/equipamento.',
      'unrelated: conversa paralela claramente sem relação com o alinhamento ativo.',
      'new_activity: há evidência clara de atividade distinta. Se a conversa ativa já contém um relatório com vários equipamentos, uma informação complementar sobre qualquer um deles é related.',
      'Inclua também como new_activity quando a conversa identificar claramente outra embarcação/MCP; se a mensagem disser que complementa ou corrige um registro anterior, não misture com o equipamento atual.',
      'uncertain: não é seguro decidir. Não misture equipamentos, não deduza nem use conhecimento externo.',
      'Se ainda não foi identificado equipamento, dados de alinhamento podem ser related. Uma mensagem ambígua deve ser uncertain.',
      'CONVERSA: ' + JSON.stringify(transcript)
    ].join('\n'), model);
    return result?.decision;
  }

  async function finish(session, reason) {
    const reportIndex = session.messages.findIndex(message =>
      String(message.text || '').includes('Conteúdo lido do anexo:'));
    let relevantMessages = session.messages;
    if (reportIndex > 0) {
      const reportTime = Date.parse(session.messages[reportIndex].timestamp || '');
      const hasContextCue = message => {
        if (message.explicitMention === true) return true;
        const body = String(message.originalText || message.text || '').replace(/^\[Grupo:[^\]]*\]\s*/i, '');
        return /(?:^|\n)\s*[A-Za-zÀ-ÿ][^:\n]{1,35}:\s*\S/m.test(body) ||
          /\b(?:embarca[cç][aã]o|navio|vessel|equipamento|equipment|mcp|dg|gerador|bomba|motivo|motiva[cç][aã]o|executor|respons[aá]vel|m[eé]todo|data|alinhamento|alignment|toler[aâ]ncia|tolerance|coupling|gap|laser|mm|µm|um|mils|bombordo|boreste|port|stbd|starboard)\b/i.test(body);
      };
      const preAttachment = session.messages.slice(0, reportIndex).filter(message => {
        const msgTime = Date.parse(message.timestamp || '');
        if (Number.isFinite(reportTime) && Number.isFinite(msgTime) && reportTime - msgTime > 2 * 60 * 60 * 1000) {
          return false;
        }
        return hasContextCue(message);
      });
      relevantMessages = [...preAttachment, ...session.messages.slice(reportIndex)];
    }
    const transcript = relevantMessages.map((message, index) => ({
      n: index + 1,
      time: message.timestamp,
      sender: message.sender,
      text: String(message.text || '').replace(/^DIVERGENCIA_MEDICAO:.*$/gm, '[Medição divergente aguardando confirmação]')
    }));
    const result = await geminiJson(apiKey, [
      'Extraia um registro de alinhamento POR equipamento distinto. Responda JSON {"records":[{"status":"ready|ambiguous|incomplete","vessel":{"value":"texto literal","message":1,"quote":"trecho literal"},"equipment":{"value":"texto literal","message":1,"quote":"trecho literal"},"fields":{"equipment_class":null,"maker":null,"model":null,"stationary_equipment_class":null,"stationary_maker":null,"stationary_model":null,"date":null,"motivation":null,"executor":null,"method":null,"axial_vertical":null,"axial_horizontal":null,"radial_vertical":null,"radial_horizontal":null,"coupling_gap":null,"standard":null,"axial_tolerance":null,"radial_tolerance":null,"coupling_gap_tolerance":null,"document":null,"measurement_unit":null,"axial_vertical_before":null,"axial_horizontal_before":null,"radial_vertical_before":null,"radial_horizontal_before":null}}]}.',
      'Use o título do grupo como evidência contextual da embarcação. Use a configuração online (taxonomia, glossário e combinações) para reconhecer nomes alternativos. equipment é a identificação do conjunto alinhado, não uma classe genérica.',
      'Compare a conversa com os cabeçalhos reais da planilha a seguir. Mapeie apenas para campos que existam nesses cabeçalhos e respeite o grupo dos títulos repetidos. Cabeçalhos sem correspondência permanecem sem informação.',
      'Extraia apenas valores que as mensagens afirmam explicitamente. Preserve datas parciais sem acrescentar ano. Mantenha tolerâncias separadas de medições. Registre medições após ajuste nas quatro direções apenas quando isso estiver explícito; medições anteriores ficam nos campos *_before. Não calcule, converta, complete, atribua autoria nem adivinhe dados ausentes.',
      'Cada valor não nulo precisa apontar para o número da mensagem e conter uma quote literal daquela mensagem que inclua o valor. Use incomplete quando faltarem campos. Use ambiguous somente para o registro cuja identidade ou associação for incerta. Não descarte outros equipamentos claros.',
      'Use status ready somente quando vessel, equipment e ao menos um campo de histórico estiverem claros. Use as grafias e unidades originais.',
      'MOTIVO DE FECHAMENTO: ' + reason,
      'CONFIGURAÇÃO ONLINE (referência para identificar valores canônicos; nunca invente): ' + await configContext(),
      'CABEÇALHOS E GRUPOS DA PLANILHA: ' + JSON.stringify(await getRecordSchema()),
      'MENSAGENS: ' + JSON.stringify(transcript)
    ].join('\n'), model);
    return onExtract(session, reason, result, transcript);
  }

  async function ask(session) {
    const result = await geminiJson(apiKey, [
      'Você acompanha uma coleta de alinhamento em um grupo. Leia a conversa e a configuração online.',
      'Use os cabeçalhos reais e os campos que o registrador preenche para determinar o que falta ou está ambíguo. Identifique o grupo dos títulos repetidos. Não afirme que campos não mapeados serão preenchidos.',
      'ESQUEMA DA PLANILHA E CAMPOS GRAVADOS: ' + JSON.stringify(await getRecordSchema()),
      'Diferencie sempre tolerância especificada de medição. Não declare aceitabilidade sem comparação correspondente.',
      'Use a configuração para reconhecer nomes canônicos. Se houver mais de uma correspondência plausível, inclua a escolha na pergunta.',
      'Retorne JSON: {"known":["campos já informados claramente"],"missing":["nomes curtos dos campos"],"question":"uma única mensagem curta pedindo de uma vez todos os campos ainda faltantes, no estilo Preciso desses dados: Embarcação, tolerância...; string vazia se nenhum"}.',
      'Faça a pergunta em português ou inglês conforme o idioma mais recente do grupo. Não pergunte campos já informados claramente.',
      'CONFIGURAÇÃO: ' + await configContext(),
      'CONVERSA: ' + JSON.stringify(session.messages.map(m => ({sender:m.sender,text:m.text})))
    ].join('\n'), model);
    const missing = Array.isArray(result?.missing) ? result.missing.map(String).sort() : [];
    const known = Array.isArray(result?.known) ? result.known.map(String).sort() : [];
    const question = typeof result?.question === 'string' ? result.question.trim() : '';
    return { missing, known, question };
  }

  return { detect, classify, finish, ask, inspectAttachment };
}

function verifyExtraction(result, transcript) {
  if (!result || !['ready', 'incomplete'].includes(result.status)) return { ok: false, reason: 'extração ambígua' };
  const fold = (value) => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
  const normalizeWs = value => fold(value).replace(/\s+/g, ' ').trim();
  const normalizeNumExpr = value => normalizeWs(value).replace(/(\d),(\d)/g, '$1.$2').replace(/(\d)\s*(mm|cm|µm|μm|um|mils?|in|pol)\b/gi, '$1 $2');
  const eqNorm = value => normalizeWs(value)
    .replace(/\b(?:diesel generator|diesel gerador|gerador diesel|grupo gerador|genset|dg)\s*#?\s*0*(\d+)\b/g, 'dg$1')
    .replace(/\b(?:motor de combustao principal|motor principal|main engine|mcp)(?:\s*#?\s*0*(\d+))?\b/g, (_, num) => num ? `mcp${num}` : 'mcp')
    .replace(/\b(?:bombordo|portside|port)\b/g, 'bb')
    .replace(/\b(?:boreste|starboard|stbd)\b/g, 'be')
    .replace(/[^a-z0-9]/g, '');
  const genericEntityTokens = new Set(['bram', 'navio', 'embarcacao', 'vessel', 'grupo', 'group', 'psv', 'ahts', 'osrv', 'rsv', 'lh']);
  const verifiedValue = (item, { matchEquipment = false, matchEntity = false } = {}) => {
    if (!item || typeof item.value !== 'string' || !item.value.trim() ||
        !Number.isInteger(item.message) || item.message < 1 || item.message > transcript.length ||
        typeof item.quote !== 'string' || !item.quote.trim()) return null;
    const source = transcript[item.message - 1].text;
    const quoteInSource = source.includes(item.quote) || normalizeWs(source).includes(normalizeWs(item.quote));
    if (!quoteInSource) return null;
    const valueText = item.value.trim();
    const direct = fold(item.quote).includes(fold(valueText)) ||
      normalizeNumExpr(item.quote).includes(normalizeNumExpr(valueText));
    if (direct) return valueText;
    if (matchEquipment) {
      const targetEq = eqNorm(valueText);
      if (targetEq && eqNorm(item.quote).includes(targetEq)) return valueText;
    }
    if (matchEntity) {
      const distinctive = normalizeWs(valueText).split(/[^a-z0-9]+/).filter(t => t.length >= 4 && !genericEntityTokens.has(t));
      const quoteWords = new Set(normalizeWs(item.quote).split(/[^a-z0-9]+/).filter(Boolean));
      if (distinctive.length && distinctive.every(t => quoteWords.has(t))) return valueText;
    }
    return null;
  };

  const sections = transcript.flatMap((message, messageIndex) => {
    const marker = 'Conteúdo lido do anexo:';
    const text = String(message.text || '');
    if (!text.includes(marker)) return [];
    return text.slice(text.indexOf(marker) + marker.length).split(/--- OUTRO EQUIPAMENTO ---/i)
      .map(section => ({ text: section, messageIndex }));
  });
  // A extração final precisa de um registro estruturalmente válido do Gemini.
  // Se ele omitir a identidade, recupere-a apenas da leitura mais recente do anexo.
  // Isso evita usar o primeiro anexo histórico para identificar a atividade atual.
  const latestMessageIndex = sections.length ? sections[sections.length - 1].messageIndex : -1;
  const latestSections = sections.filter(section => section.messageIndex === latestMessageIndex);
  const vesselNames = [...new Set(latestSections.flatMap(({ text }) => {
    const match = text.match(/^\s*Embarca[cç][aã]o:\s*(.+)$/im);
    return match && match[1].trim() ? [match[1].trim()] : [];
  }))];
  const vessel = verifiedValue(result.vessel, { matchEntity: true }) || (vesselNames.length === 1 ? vesselNames[0] : 'não informado');
  const names = [...new Set(latestSections.flatMap(({text}) => {
    const match = text.match(/^\s*Equipamento:\s*(.+)$/im);
    return match && match[1].trim() ? [match[1].trim()] : [];
  }))];
  const verifiedEquipment = verifiedValue(result.equipment, { matchEquipment: true });
  const equipment = verifiedEquipment || (names.length === 1 ? names[0] : 'não informado');

  const LABEL_ALIASES = {
    'Data': ['Data', 'Date'],
    'Maker': ['Maker', 'Fabricante'],
    'Model': ['Model', 'Modelo'],
    'Stationary Maker': ['Stationary Maker', 'Maker (Máquina Estacionária)'],
    'Stationary Model': ['Stationary Model', 'Model (Máquina Estacionária)'],
    'Stationary Equipment Class': ['Stationary Equipment Class', 'Equipment Class (Máquina Estacionária)'],
    'Equipment Class': ['Equipment Class', 'Equipment Class (Drive Machine)'],
    'Motivacao': ['Motivacao', 'Motivação', 'Motivation', 'Motivo'],
    'Executor': ['Executor', 'Responsavel', 'Responsável'],
    'Metodo': ['Metodo', 'Método', 'Method'],
    'Document': ['Document', 'Documento']
  };
  const labelForms = label => (LABEL_ALIASES[label] || [label]).map(fold);

  // Gemini por vezes simplifica um campo para string. Só aceita esse formato
  // quando a mesma medida aparece com o cabeçalho na seção do equipamento.
  const verifiedString = (value, label) => {
    if (typeof value !== 'string' || !value.trim() || equipment === 'não informado') return null;
    const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const forms = labelForms(label).map(escape).join('|');
    const pattern = new RegExp(`(?:^|\\n)(?:${forms}):\\s*${escape(fold(value.trim()))}(?=\\s*\\(|\\s*$)`, 'm');
    const checkSections = (list) => {
      for (const { text: section } of list) {
        const normalized = fold(section);
        const eqMatch = section.match(/^\s*Equipamento:\s*(.+)$/im);
        const sameEq = Boolean(eqMatch) && (fold(eqMatch[1].trim()) === fold(equipment) || eqNorm(eqMatch[1]) === eqNorm(equipment));
        if (sameEq && pattern.test(normalized)) return value.trim();
      }
      return null;
    };
    return checkSections(latestSections) || checkSections(sections);
  };

  const fields = {};
  for (const [key, label] of Object.entries(FIELD_LABELS)) {
    const value = verifiedValue(result.fields?.[key]) || verifiedString(result.fields?.[key], label);
    if (value) fields[label] = value;
  }
  if (equipment !== 'não informado' && names.length === 1 && eqNorm(names[0]) === eqNorm(equipment)) {
    const matchingSections = sections.filter(({ text }) => {
      const eqMatch = text.match(/^\s*Equipamento:\s*(.+)$/im);
      return eqMatch && eqNorm(eqMatch[1]) === eqNorm(equipment);
    });
    const collectFrom = (list) => {
      for (const [key, label] of Object.entries(FIELD_LABELS)) {
        if (fields[label]) continue;
        const allowedLabels = new Set(labelForms(label));
        const candidates = list.flatMap(({ text: section }) => section.split('\n').flatMap(line => {
          const match = line.match(/^([^:]+):\s*(.*?)\s+\(fonte:\s*(.+)\)$/i);
          if (!match || !allowedLabels.has(fold(match[1].trim())) || !match[2].trim()) return [];
          return fold(match[3]).includes(fold(match[2])) || normalizeNumExpr(match[3]).includes(normalizeNumExpr(match[2]))
            ? [match[2].trim()] : [];
        }));
        const unique = [...new Set(candidates)];
        if (unique.length === 1) fields[label] = unique[0];
      }
    };
    collectFrom(latestSections);
    if (matchingSections.length) collectFrom(matchingSections);
  }
  const input = [`Vessel: ${vessel}`, `Equipment: ${equipment}`];
  for (const [label, value] of Object.entries(fields)) input.push(`${label}: ${value}`);
  return { ok: true, text: input.join('\n'), vessel, equipment, fields };
}

function verifyExtractions(result, transcript) {
  const records = Array.isArray(result?.records) ? result.records : [result];
  if (!records.length) return [{ ok: false, reason: 'nenhum registro identificado' }];
  return records.map(record => verifyExtraction(record, transcript));
}

module.exports = { createTracker, fileStore, geminiJson, makeGeminiFunctions, verifyExtraction, verifyExtractions };


