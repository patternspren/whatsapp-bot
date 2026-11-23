const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

test('ignora mensagens até a menção e então envia o contexto recente ao rastreador',async()=>{
  const tracked=[];
  const mocks={
    './alignment_tabs':require('../alignment_tabs'),
    '@whiskeysockets/baileys':{}, 'qrcode-terminal':{}, pino:()=>({}),
    googleapis:{google:{options(){},auth:{GoogleAuth:class{}},sheets:()=>({})}},
    fs:{readFileSync(){throw new Error('sem estado')},writeFileSync(){}},
    './gemini_conversation':{
      createTracker:()=>({process:async msg=>{tracked.push(msg);return 'aberta'},snapshot:()=>({})}),
      fileStore:()=>({load(){},save(){}}),
      makeGeminiFunctions:()=>({inspectAttachment:async()=>''})
    },
    './confirmations':{createConfirmations:()=>({lookup:()=>null}),parseCorrection:()=>[],isApproval:()=>false},
    './alignment_config':{loadAlignmentConfig:async()=>({})},
    './alignment_history':{}
  };
  const source=fs.readFileSync(require.resolve('../index.js'),'utf8');
  const end=source.indexOf("process.on('SIGINT'");
  const context={require:name=>mocks[name]||require(name),__dirname:'/tmp',Buffer,
    process:{env:{SPREADSHEET_ID:'test',CONFIG_SPREADSHEET_ID:'test',GEMINI_API_KEY:'test',GEMINI_CONVERSATION_ENABLED:'true'}},
    console,fetch,setInterval:()=>({unref(){}}),setTimeout,Date};
  vm.runInNewContext(source.slice(0,end)+'\nthis.handle=handleMessage;',context);
  const sock={user:{id:'12345@s.whatsapp.net',lid:'67890:4@lid'},groupMetadata:async()=>({subject:'BRAM Atlas'})};
  await context.handle(sock,{key:{remoteJid:'grupo@g.us',id:'before'},message:{conversation:'Segue relatório final do MCP 1'}});
  assert.equal(tracked.length,0);
  await context.handle(sock,{key:{remoteJid:'grupo@g.us',id:'mention'},message:{extendedTextMessage:{text:'@bot confira este relatório',contextInfo:{mentionedJid:['12345@s.whatsapp.net']}}}});
  assert.equal(tracked.length,2);
  await context.handle(sock,{key:{remoteJid:'outro@g.us',id:'mention-by-lid'},message:{extendedTextMessage:{text:'@bot confira o alinhamento',contextInfo:{mentionedJid:['67890@lid']}}}});
  assert.equal(tracked.length,3);
  assert.match(tracked[0].text,/relatório final do MCP 1/);
  assert.equal(tracked[0].activatedByMention,true);
  assert.equal(tracked[1].activatedByMention,true);
});
