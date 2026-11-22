const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const confirmationLib=require('../confirmations');
const historyLib=require('../alignment_history');

function harness(entry, writeResult = {status:'updated',row:3}) {
  const writes=[]; const completed=[]; const replies=[];
  const schema=[
    {title:'Vessel',mappedAs:['vessel']}, {title:'Equipment / Tag',mappedAs:['equipment']},
    {title:'Axial Vertical',mappedAs:['axial_vertical']}
  ];
  const proposals=new Map([['proposal',['proposal-key',entry]]]);
  const prepared=new Map();
  const mocks={
    '@whiskeysockets/baileys':{}, 'qrcode-terminal':{}, pino:()=>({}),
    googleapis:{google:{options(){},auth:{GoogleAuth:class{}},sheets:()=>({})}},
    fs:{readFileSync(){throw new Error('sem estado')},writeFileSync(){},appendFileSync(){},chmodSync(){}},
    './gemini_conversation':{
      createTracker:()=>({process:async()=> 'aberta',snapshot:()=>({})}),
      fileStore:()=>({load(){},save(){}}),makeGeminiFunctions:()=>({})
    },
    './confirmations':{...confirmationLib,createConfirmations:()=>({
      lookup:(_group,id)=>proposals.get(id),done:(key,id)=>completed.push({key,id}),
      prepare:(_group,sessionId,draft)=>{
        const key='revised-key';
        prepared.set(key,{...draft,sessionId,status:'sent'});
        return {key,text:draft.text};
      },
      sent:(key,id)=>proposals.set(id,[key,prepared.get(key)])
    })},
    './alignment_config':{loadAlignmentConfig:async()=>({})},
    './alignment_history':{
      ...historyLib,
      getRecordSchema:async()=>schema,
      resolveRecordTarget:async()=>({status:'ready', target:{row:3,revision:'latest',current:{}}, schema}),
      recordHistory:async(_sheets,_id,data,sessionId,options)=>{writes.push({data,sessionId,options});return writeResult;}
    }
  };
  const source=fs.readFileSync(require.resolve('../index.js'),'utf8');
  const end=source.indexOf("process.on('SIGINT'");
  const context={require:name=>mocks[name]||require(name),__dirname:'/tmp',Buffer,
    process:{env:{SPREADSHEET_ID:'test',CONFIG_SPREADSHEET_ID:'test',GEMINI_API_KEY:'test',GEMINI_CONVERSATION_ENABLED:'true'}},
    console,fetch,setInterval:()=>({unref(){}}),setTimeout,Date};
  vm.runInNewContext(source.slice(0,end)+'\nthis.handle=handleMessage;',context);
  return {handle:context.handle,writes,completed,replies,sock:{sendMessage:async(_group,message)=>{replies.push(message);return {key:{id:'bot-reply'}};}}};
}

const proposal=()=>({status:'sent',authorizedSender:'isabela@s.whatsapp.net',sessionId:'same-session',target:{row:3,revision:'initial'},startedAt:'2026-11-18T10:00:00.000Z',data:{
  vessel:'BRAM Atlas',equipment:'MCP 1',axial_vertical:'usuário passou informação divergente'
},conflicts:[{field:'Axial Vertical',caption:'-0.015 mm',visual:'-0.01 mm'}]});
const reply=(text,stanzaId='proposal',id='response')=>({key:{remoteJid:'grupo@g.us',participant:'isabela@s.whatsapp.net',id},message:{extendedTextMessage:{text,contextInfo:{stanzaId}}}});

test('divergência exige escolha explícita antes de gravar',async()=>{
  const h=harness(proposal());
  await h.handle(h.sock,reply('confirmo'));
  assert.equal(h.writes.length,0);
  assert.match(h.replies[0].text,/divergências/);
  assert.equal(h.replies.length,1);
});

test('correção pede nova validação completa e só depois grava na mesma linha',async()=>{
  const h=harness(proposal());
  await h.handle(h.sock,reply('Axial Vertical: -0,01 mm'));
  assert.equal(h.writes.length,0);
  assert.match(h.replies[0].text,/Vessel: BRAM Atlas/);
  assert.match(h.replies[0].text,/Equipment \/ Tag: MCP 1/);
  assert.match(h.replies[0].text,/Axial Vertical: -0.01 mm/);
  await h.handle(h.sock,reply('confirmo','bot-reply','response-2'));
  assert.equal(h.writes.length,1);
  assert.equal(h.writes[0].data.axial_vertical,'-0.01 mm');
  assert.equal(h.writes[0].data.observations,'');
  assert.equal(h.writes[0].sessionId,'same-session');
  assert.equal(h.writes[0].options.target.row,3);
});

test('destino alterado exige nova conferência e não confirma gravação',async()=>{
  const h=harness({...proposal(),conflicts:[]}, {status:'target_changed'});
  await h.handle(h.sock,reply('confirmo'));
  assert.equal(h.completed.length,0);
  assert.match(h.replies[0].text,/planilha mudou/);
  assert.match(h.replies[1].text,/linha 3 já existente/);
});

test('outra pessoa pode confirmar a proposta por padrão',async()=>{
  const h=harness({...proposal(),conflicts:[]});
  const msg=reply('confirmo'); msg.key.participant='outra@s.whatsapp.net';
  await h.handle(h.sock,msg);
  assert.equal(h.writes.length,1);
  assert.equal(h.writes[0].data.approvedBy,'outra@s.whatsapp.net');
});
