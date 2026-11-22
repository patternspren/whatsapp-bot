const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'); const os=require('node:os'); const path=require('node:path');
const {createConfirmations,parseCorrection,isApproval}=require('../confirmations');

test('propostas sobrevivem a reinício, isolam grupos e não se repetem',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'confirm-')); const file=path.join(dir,'state.json');
 const proposal={data:{vessel:'BRAM Atlas',equipment:'MCP 1',axial_vertical:'não informado'},conflicts:[],text:'Confira antes de gravar'};
 const a=createConfirmations(file); const sent=a.prepare('g1','sessao1',proposal);
 assert.match(sent.text,/Confira/); a.sent(sent.key,'msg1');
 assert.equal(a.prepare('g1','sessao1',proposal),null);
 const b=createConfirmations(file);
 assert.equal(b.lookup('g2','msg1'),null); assert.equal(b.lookup('g1','msg1')[1].sessionId,'sessao1');
 b.done(sent.key,'resp1','answered'); assert.equal(b.lookup('g1','msg1')[1].status,'answered');
 fs.rmSync(dir,{recursive:true,force:true});
});

test('correção exige campo e preserva sinal e decimal',()=>{
 assert.deepEqual(parseCorrection('axial vertical: -0,01 mm'),[{key:'axial_vertical',value:'-0.01 mm'}]);
 assert.deepEqual(parseCorrection('sim, 0,01'),[]);
 assert.deepEqual(parseCorrection('0,01',[{field:'Axial Vertical'}]),[]);
 assert.deepEqual(parseCorrection('0,01 mm',[{field:'Axial Vertical'}]),[{key:'axial_vertical',value:'0.01 mm'}]);
 assert.deepEqual(parseCorrection('axial vertical: -2 cm'),[{key:'axial_vertical',value:'-2 cm'}]);
 assert.deepEqual(parseCorrection('Embarcação: Bram Atlas\nEquipment / Tag: MCP 1'),[
   {key:'vessel',value:'Bram Atlas'},{key:'equipment',value:'MCP 1'}
 ]);
 assert.deepEqual(parseCorrection('Maker (Drive Machine): WEG\nMaker (Máquina Estacionária): ABB'),[
   {key:'maker',value:'WEG'},{key:'stationary_maker',value:'ABB'}
 ]);
 assert.equal(isApproval('confirmo'),true);
 assert.equal(isApproval('confirmado, pode gravar'),true);
 assert.equal(isApproval('confirmo os dados'),true);
 assert.equal(isApproval('confirmado os dados'),true);
 assert.equal(isApproval('@999888777 confirmado'),true);
 assert.deepEqual(parseCorrection('@999888777\naxial vertical: -0.01\nexecutor: navship',[{field:'Axial Vertical',caption:'-0.015 mm',visual:'-0.01 mm'}]),[{key:'axial_vertical',value:'-0.01 mm'},{key:'executor',value:'navship'}]);
 assert.deepEqual(parseCorrection('axial vertical: -0.01').invalidFields,['axial vertical']);
 assert.deepEqual(parseCorrection('axial vertical: -0.01',[{field:'Axial Vertical',caption:'-0.015 mm',visual:'-0.01 cm'}]).invalidFields,['axial vertical']);
 assert.equal(isApproval('confirmo?'),false);
 assert.equal(isApproval('sim, correto'),true);
 assert.equal(isApproval('não, axial vertical: -0.01 mm'),false);
});

test('deduplica conteúdo idêntico após mensagem nova e mantém proposta aberta',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'confirm-')); const file=path.join(dir,'state.json');
 try {
  const c=createConfirmations(file), p={data:{vessel:'Joe Griffin'},conflicts:[],target:{revision:'1'},text:'confira',sourceVersion:'a'};
  const first=c.prepare('g','s',p); c.sent(first.key,'m1');
  assert.equal(c.prepare('g','s',{...p,sourceVersion:'b'}),null);
  assert.equal(c.lookup('g','m1')[1].status,'sent');
  assert.equal(c.latestOpen('g')[0].messageId,'m1');
  assert.deepEqual(parseCorrection('campo inventado: valor').unknownFields,['campo inventado']);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
