const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTracker, makeGeminiFunctions, verifyExtractions } = require('../gemini_conversation');
const { getRecordSchema } = require('../alignment_history');

test('recupera equipamento e campos comprovados de um único anexo', () => {
  const text = '[Grupo: Exemplo] Embarcação Exemplo\nConteúdo lido do anexo: Equipamento: MCP\nData: 17/11 (fonte: legenda data 17/11)\nRadial Vertical: -0.35 mm (fonte: tela -0.35 mm)\n[Medição divergente aguardando confirmação]';
  const result = {status:'incomplete', vessel:{value:'Embarcação Exemplo', message:1, quote:'Embarcação Exemplo'}, equipment:null, fields:{}};
  const [record] = verifyExtractions({records:[result]}, [{text}]);
  assert.equal(record.equipment, 'MCP');
  assert.equal(record.fields.Data, '17/11');
  assert.equal(record.fields['Radial vertical'], '-0.35 mm');
  assert.equal(record.fields['Axial vertical'], undefined);
});

test('usa o anexo mais recente quando a extração do Gemini omite a identidade', () => {
  const transcript = [{text:'Conteúdo lido do anexo: Equipamento: MCP\nRadial Vertical: 0.10 mm (fonte: 0.10 mm)'},
    {text:'Conteúdo lido do anexo: Equipamento: MCP\nRadial Vertical: 0.20 mm (fonte: 0.20 mm)'}];
  const [record] = verifyExtractions({records:[{status:'incomplete',fields:{}}]}, transcript);
  assert.equal(record.equipment, 'MCP');
  assert.equal(record.fields['Radial vertical'], '0.20 mm');
});

test('mantém ambígua a última leitura que contém mais de um equipamento', () => {
  const transcript = [{text:'Conteúdo lido do anexo: Equipamento: MCP 1\nRadial Vertical: 0.10 mm (fonte: 0.10 mm)\n\n--- OUTRO EQUIPAMENTO ---\n\nEquipamento: MCP 2\nRadial Vertical: 0.20 mm (fonte: 0.20 mm)'}];
  const [record] = verifyExtractions({records:[{status:'incomplete',fields:{}}]}, transcript);
  assert.equal(record.equipment, 'não informado');
  assert.deepEqual(record.fields, {});
});

test('inicia sessão com detecção contextual e ignora conversa sem relação', async () => {
  const tracker = createTracker({ detect: async m => m.text.includes('alinhar o eixo'), classify: async () => 'related',
    finish: async () => {}, save: async () => {} });
  assert.equal(await tracker.process({group:'a', text:'Vamos almoçar?'}), 'ignorada');
  assert.equal(await tracker.process({group:'a', text:'Vamos alinhar o eixo da bomba'}), 'aberta');
  assert.equal(tracker.snapshot().a.messages.length, 2);
});

test('lê títulos atuais com grupos e informa ao Gemini o esquema', async () => {
  const sheets = { spreadsheets: { values: { get: async () => ({data:{values:[['', 'Drive Machine'], ['', 'Vessel', 'Equipment / Tag', 'Maker', 'Comments']]}}) } } };
  const schema = await getRecordSchema(sheets, 'test', 'Modelo alinhamento');
  assert.equal(schema[0].title, 'Vessel');
  assert.deepEqual(schema.find(c => c.title === 'Maker').mappedAs, ['maker']);
  const original = global.fetch;
  let prompt;
  global.fetch = async (_url, options) => {
    prompt = JSON.parse(options.body).contents[0].parts[0].text;
    return {ok:true, json:async () => ({candidates:[{content:{parts:[{text:'{"known":[],"missing":["Vessel"],"question":"Embarcação?"}'}]}}]})};
  };
  try {
    const gemini = makeGeminiFunctions({apiKey:'test', config:{}, getRecordSchema:async () => schema});
    await gemini.ask({messages:[]});
    assert.match(prompt, /Drive Machine/);
    assert.match(prompt, /Vessel/);
    assert.match(prompt, /mappedAs/);
  } finally { global.fetch = original; }
});

test('compara a extração final com os cabeçalhos reais da planilha', async () => {
  const original = global.fetch;
  let prompt;
  global.fetch = async (_url, options) => {
    prompt = JSON.parse(options.body).contents[0].parts[0].text;
    return {ok:true, json:async () => ({candidates:[{content:{parts:[{text:'{"status":"incomplete","vessel":null,"equipment":null,"fields":{}}'}]}}]})};
  };
  try {
    const schema = [{group:'drive machine', title:'Axial Vertical', mappedAs:['axial_vertical']}];
    const gemini = makeGeminiFunctions({apiKey:'test', config:{}, getRecordSchema:async () => schema, onExtract:async () => {}});
    await gemini.finish({messages:[{text:'resultado'}]}, 'sincronização periódica');
    assert.match(prompt, /Axial Vertical/);
    assert.match(prompt, /Compare a conversa com os cabeçalhos reais/);
  } finally { global.fetch = original; }
});

test('prioriza o relatório sobre mensagens antigas de teste na extração final', async () => {
  const original = global.fetch;
  let prompt, transcript;
  global.fetch = async (_url, options) => {
    prompt = JSON.parse(options.body).contents[0].parts[0].text;
    return {ok:true,json:async () => ({candidates:[{content:{parts:[{text:'{"records":[]}'}]}}]})};
  };
  try {
    const gemini = makeGeminiFunctions({apiKey:'test',config:{},getRecordSchema:async()=>[],
      onExtract:async (_session,_reason,_result,messages) => { transcript = messages; }});
    await gemini.finish({messages:[
      {text:'bora',timestamp:'2026-11-14T17:00:00Z'},
      {text:'Conteúdo lido do anexo: Equipamento: DG #1; Coupling GAP: 27,65 mm',timestamp:'2026-11-14T23:29:00Z'}
    ]},'sincronização periódica');
    assert.equal(transcript.length, 1);
    assert.doesNotMatch(prompt, /bora/);
    assert.match(prompt, /27,65 mm/);
  } finally { global.fetch = original; }
});

test('envia anexo ao Gemini junto do nome do grupo, legenda e esquema da planilha', async () => {
  const original = global.fetch;
  let payload;
  global.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, json: async () => ({candidates:[{content:{parts:[{text:JSON.stringify({records:[
      {vessel:'BRAM Atlas', equipment:'DG1', facts:[
        {field:'Axial Horizontal', value:'0,02 mm', evidence:'Figura 2, p. 3: 0,02 mm'},
        {field:'Folga do virabrequim', value:'0,24 mm', evidence:'Figura 3: folga do virabrequim 0,24 mm'}]},
      {vessel:'BRAM Atlas', equipment:'DG2', facts:[]}
    ]})}]}}]}) };
  };
  try {
    const gemini = makeGeminiFunctions({apiKey:'test', config:{}, getRecordSchema:async () => [{title:'Axial Horizontal',mappedAs:['axial_horizontal']}]});
    const summary = await gemini.inspectAttachment({caption:'Relatório final', groupName:'BRAM Atlas', fileName:'relatorio.pdf', mimeType:'application/pdf', data:Buffer.from('pdf')});
    assert.match(summary, /DG1/);
    assert.match(summary, /DG2/);
    assert.match(summary, /Axial Horizontal: 0,02 mm/);
    assert.doesNotMatch(summary, /Folga do virabrequim/);
    assert.match(summary, /Document: relatorio.pdf/);
    assert.equal(payload.contents[0].parts[1].inline_data.mime_type, 'application/pdf');
    assert.match(payload.contents[0].parts[0].text, /BRAM Atlas/);
    assert.match(payload.contents[0].parts[0].text, /Axial Horizontal/);
  } finally { global.fetch = original; }
});

test('valida quatro registros independentes sem exigir todos os campos', () => {
  const transcript = [{text:'[Grupo: BRAM Breeze] Relatório: Diesel Generator #1, #2, #3 e #4; GAP #3 31,00 mm'}];
  const evidence = value => ({ value, message:1, quote: transcript[0].text });
  const records = [1,2,3,4].map(n => ({status:'incomplete', vessel:evidence('BRAM Breeze'),
    equipment:evidence(`#${n}`), fields:n === 3 ? {coupling_gap:evidence('31,00 mm')} : {}}));
  const checked = verifyExtractions({records}, transcript);
  assert.equal(checked.length, 4);
  assert.ok(checked.every(record => record.ok));
  assert.equal(checked[2].fields['Coupling gap'], '31,00 mm');
  assert.deepEqual(checked[0].fields, {});
});

test('recupera GAP final de quatro geradores sem aceitar folga do virabrequim', async () => {
  const original = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    const result = calls === 1 ? {records:[1,2,3,4].map(n => ({
      vessel:'BRAM BREEZE', equipment:`Diesel Generator #${n}`,
      facts:n === 1 ? [{field:'GAP final',value:'27,65 mm',evidence:'Figura 49'}] : []
    }))} : {records:[
      {equipment:'DG #1',coupling_gap:{value:'27,65 mm',evidence:'Figura 49 - Gap após alinhamento: 27,65 mm',page:31}},
      {equipment:'DG #2',coupling_gap:{value:'29,45 mm',evidence:'Figura 27 - Gap verificado (29,45 mm)',page:18}},
      {equipment:'DG #3',coupling_gap:{value:'0,24 mm',evidence:'Folga do virabrequim 0,24 mm',page:13}},
      {equipment:'DG #4',coupling_gap:{value:'27,87 mm',evidence:'Figura 39 - Gap final: 27,87 mm',page:25}}
    ]};
    return {ok:true,json:async () => ({candidates:[{content:{parts:[{text:JSON.stringify(result)}]}}]})};
  };
  try {
    const gemini = makeGeminiFunctions({apiKey:'test', config:{},
      getRecordSchema:async () => [{title:'Coupling GAP',mappedAs:['coupling_gap']}]});
    const text = await gemini.inspectAttachment({mimeType:'application/pdf',data:Buffer.from('pdf'),fileName:'report.pdf'});
    assert.equal(calls, 2);
    assert.match(text, /Diesel Generator #1[\s\S]*Coupling GAP: 27,65 mm/);
    assert.match(text, /Diesel Generator #2[\s\S]*Coupling GAP: 29,45 mm/);
    assert.doesNotMatch(text, /0,24 mm/);
    assert.match(text, /Diesel Generator #4[\s\S]*Coupling GAP: 27,87 mm/);
  } finally { global.fetch = original; }
});

test('aceita medida em string somente na seção correta do equipamento', () => {
  const text = 'Conteúdo lido do anexo: Equipamento: Diesel Generator #1\nCoupling GAP: 27,65 mm (fonte: Figura 49)\nDocument: report.pdf\n\n--- OUTRO EQUIPAMENTO ---\n\nEquipamento: Diesel Generator #2\nCoupling GAP: 29,45 mm (fonte: Figura 27)\nDocument: report.pdf';
  const item = value => ({value,message:1,quote:`Equipamento: ${value}`});
  const records = [
    {status:'incomplete',equipment:item('Diesel Generator #1'),fields:{coupling_gap:'27,65 mm',document:'report.pdf'}},
    {status:'incomplete',equipment:item('Diesel Generator #2'),fields:{coupling_gap:'29,45 mm',document:'report.pdf'}},
    {status:'incomplete',equipment:item('Diesel Generator #1'),fields:{coupling_gap:'29,45 mm'}}
  ];
  const verified = verifyExtractions({records},[{text}]);
  assert.equal(verified[0].fields['Coupling gap'],'27,65 mm');
  assert.equal(verified[1].fields['Coupling gap'],'29,45 mm');
  assert.equal(verified[0].fields.Document,'report.pdf');
  assert.equal(verified[2].fields['Coupling gap'],undefined);
});

test('registra período geral do serviço sem criar uma data para cada DG', async () => {
  const original = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    const answer = ++calls === 1 ? {records:[1,2].map(n => ({equipment:`DG #${n}`,facts:[]}))} :
      {period:{value:'06/08/2026 a 13/08/2026', evidence:'Trabalho executado com data de início em 06/08/2026 a 13/08/2026',page:1}};
    return {ok:true,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify(answer)}]}}]})};
  };
  try {
    const gemini=makeGeminiFunctions({apiKey:'test',config:{},
      getRecordSchema:async()=>[{title:'Data',mappedAs:['date']}]});
    const summary=await gemini.inspectAttachment({mimeType:'application/pdf',data:Buffer.from('pdf')});
    assert.equal((summary.match(/Data: 06\/08\/2026 a 13\/08\/2026/g)||[]).length,2);
    assert.match(summary,/Período geral do serviço/);
  } finally {global.fetch=original;}
});



test('guarda divergência entre legenda e imagem sem gravar valor incerto', async () => {
 const old=global.fetch; let n=0;
 global.fetch=async()=>({ok:true,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify(++n===1 ? {records:[{vessel:'Joe Griffin',equipment:'MCP 1',facts:[]}]} : {compatible:true,unit:'mm',values:{'Axial Vertical':'-0.01','Radial Vertical':'-0.35','Axial Horizontal':'-0.02','Radial Horizontal':'-0.02'}})}]}}]})});
 try {
  const schema=['Axial Vertical','Radial Vertical','Axial Horizontal','Radial Horizontal'].map(title=>({title,mappedAs:['x']}));
  const g=makeGeminiFunctions({apiKey:'test',config:{},getRecordSchema:async()=>schema});
  const out=await g.inspectAttachment({caption:'axial vertical: -0.1\nradial vertical: -0.35\naxial horizontal: -0.02\nradial horizontal: -0.02',groupName:'Joe Griffin',fileName:'',mimeType:'image/jpeg',data:Buffer.from('test')});
  assert.match(out,/DIVERGENCIA_MEDICAO:.*-0.1 mm.*-0.01 mm/);
  assert.match(out,/Radial Vertical: -0.35 mm/); assert.doesNotMatch(out,/Axial Vertical: -0.1 mm/);
 } finally {global.fetch=old;}
});

test('valores divergentes não são oferecidos como medição confirmada na extração', async () => {
 const old=global.fetch; let request;
 global.fetch=async (_url,options)=>{request=JSON.parse(options.body);return {ok:true,json:async()=>({candidates:[{content:{parts:[{text:'{"records":[]}'}]}}]})};};
 try {
  const g=makeGeminiFunctions({apiKey:'test',config:{},getRecordSchema:async()=>[],onExtract:async()=>({})});
  await g.finish({messages:[{text:'Conteúdo lido do anexo: Equipamento: MCP 1\nDIVERGENCIA_MEDICAO: {"field":"Axial Vertical","caption":"-0.1 mm","visual":"-0.01 mm"}'}]},'teste');
  const prompt=request.contents[0].parts[0].text;
  assert.doesNotMatch(prompt, /-0\.1 mm/); assert.doesNotMatch(prompt, /-0\.01 mm/); assert.match(prompt,/aguardando confirmação/);
 } finally {global.fetch=old;}
});
