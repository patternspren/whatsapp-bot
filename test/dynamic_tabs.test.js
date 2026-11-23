const {test} = require('node:test');
const assert = require('node:assert/strict');
const {resolveTargetTab} = require('../alignment_tabs');
const {resolveRecordTarget, recordHistory, getRecordSchema} = require('../alignment_history');
const tabs = ['MCP', 'Shaft gen - redutora '];
const config = {glossary:[
  {taxonomia:'Shaft Generator', 'possiveis nomes':'gerador de eixo; shaft gen, motor; drive'},
  {taxonomia:'Propulsion Engine', 'possiveis nomes':'MCP; motor de propulsão principal, motor; drive'},
  {taxonomia:'FIFI', 'possiveis nomes':'bomba fifi; motor; drive'}
], combinations:[{'maquina a ser alinhada / drive machine':'Gerador de eixo', 'maquina estacionaria':'Caixa redutora'}]};
test('roteamento preserva título e rejeita palavras genéricas e equipamentos sem aba', () => {
  for (const equipment of ['gerador de eixo','shaft gen','Shaft Generator No.1','caixa redutora'])
    assert.equal(resolveTargetTab({tabs, config, data:{equipment}}).tabTitle, tabs[1]);
  for (const equipment of ['MCP','motor de propulsão principal','Propulsion Engine'])
    assert.equal(resolveTargetTab({tabs, config, data:{equipment}}).tabTitle, tabs[0]);
  for (const equipment of ['motor','drive','Bomba FIFI'])
    assert.equal(resolveTargetTab({tabs, config, data:{equipment}}).status, 'tab_not_found');
  assert.equal(resolveTargetTab({tabs:['MCP BB','MCP BE'], config, data:{equipment:'MCP'}}).status, 'ambiguous_tab');
});
function model() {
  const rows = [
    ['Drive Machine','','Histórico','Reference'],
    ['Vessel','Equipment / Tag','Data','Comments'],
    ['Navegantes Pride','Shaft gen/ Redutora','09/03/2023',''],
    ['Navegantes Pride','Shaft gen/ Redutora','10/05/2025','']
  ];
  const ranges=[];
  const sheet={spreadsheets:{get:async()=>({data:{sheets:tabs.map(title=>({properties:{title}}))}}),values:{
    get:async({range})=>{ranges.push(range); return {data:{values:range.endsWith('ZZ2') ? rows.slice(0,2) : rows.map(r=>[...r])}}},
    append:async({range,requestBody})=>{ranges.push(range); rows.push(requestBody.values[0]); return {data:{updates:{updatedRange:`'Shaft gen - redutora '!A${rows.length}:D${rows.length}`}}}},
    batchUpdate:async({requestBody})=>{for(const item of requestBody.data){ranges.push(item.range);const m=item.range.match(/!([A-Z])(\d+)$/);rows[+m[2]-1][m[1].charCodeAt(0)-65]=item.values[0][0]}}
  }}};
  return {rows,ranges,sheet};
}
test('data nova cria linha sem sobrescrever histórico e sessão atualiza a mesma aba literal', async()=>{
  const {rows,ranges,sheet}=model(), title=tabs[1];
  const data={vessel:'Navegantes Pride',equipment:'Gerador de eixo',date:'22/11/2026'};
  const first=await resolveRecordTarget(sheet,'records',data,'sess',title);
  assert.equal(first.target.row,null);
  assert.deepEqual(await recordHistory(sheet,'records',data,'sess',{target:first.target,confirmationId:'one'}),{status:'appended',row:5});
  const second=await resolveRecordTarget(sheet,'records',data,'sess',title);
  assert.equal(second.target.row,5);
  await recordHistory(sheet,'records',{...data,date:'22/11/2026'},'sess',{target:second.target,confirmationId:'two'});
  assert.equal(rows[2][2],'09/03/2023'); assert.equal(rows[3][2],'10/05/2025');
  assert.ok(ranges.every(range=>range.startsWith("'Shaft gen - redutora '!")));
});
test('data ausente não sobrescreve linha antiga',async()=>{
  const {sheet}=model();
  assert.equal((await resolveRecordTarget(sheet,'records',{vessel:'Navegantes Pride',equipment:'Gerador de eixo'},'new',tabs[1])).status,'ambiguous_target');
});
test('esquema é descoberto pela primeira aba com cabeçalhos válidos',async()=>{
  const {sheet}=model();
  assert.ok((await getRecordSchema(sheet,'records')).some(column=>column.mappedAs.includes('equipment')));
});

test('extração inicial sem unidade não grava medição nem inventa milímetros', () => {
  const {verifyExtraction} = require('../gemini_conversation');
  const text='Navegantes Pride gerador de eixo axial vertical: 0.03';
  const item = value => ({value,message:1,quote:text});
  const result = verifyExtraction({status:'ready', vessel:item('Navegantes Pride'), equipment:item('gerador de eixo'), fields:{axial_vertical:item('0.03')}},[{text}]);
  assert.equal(result.fields['Axial vertical'], undefined);
});

test('glossário numerado compartilha família e contexto desempata pares', () => {
  const glossary = [];
  for (let n=1;n<=4;n++) {
    glossary.push({taxonomia:`Propulsion Engine No.${n}`, 'possiveis nomes':'mcp; motor de propulsão; motor'});
    glossary.push({taxonomia:`Aux. Generator No.${n}, Alternator`, 'possiveis nomes':'mca; motor auxiliar; motor'});
    glossary.push({taxonomia:`Main Generator No.${n}`, 'possiveis nomes':'dg; motor; gerador principal'});
    glossary.push({taxonomia:`FIFI No.${n}`, 'possiveis nomes':'fifi; motor da fifi; motor'});
  }
  const c={glossary,combinations:[{'maquina a ser alinhada / drive machine':'MCP','maquina estacionaria':'Caixa redutora'}]};
  for(const [equipment,title] of [['motor de propulsão','MCP'],['motor auxiliar','MCA'],['MCA 1','MCA'],['motor da fifi','FIFI'],['DG1','DG']])
    assert.equal(resolveTargetTab({tabs:['MCP','MCA','FIFI','DG'],config:c,data:{equipment}}).tabTitle,title,equipment);
  assert.equal(resolveTargetTab({tabs:['MCP - Linha de eixo','MCP - Caixa redutora'],config:c,data:{equipment:'MCP'},contextText:'MCP x caixa redutora'}).tabTitle,'MCP - Caixa redutora');
  assert.equal(resolveTargetTab({tabs:['MCP','MCA','FIFI','DG'],config:c,data:{equipment:'motor'}}).status,'tab_not_found');
});

test('identidade MCP reconhece números e revisões incluem a aba', async () => {
  const {equipmentIdentity} = require('../alignment_history');
  assert.equal(equipmentIdentity('Propulsion Engine No.1'),equipmentIdentity('MCP 1'));
  assert.equal(equipmentIdentity('motor de propulsão'),equipmentIdentity('MCP'));
  const {sheet}=model();
  const data={vessel:'Outro',equipment:'MCP 1'};
  const a=await resolveRecordTarget(sheet,'records',data,'sess','MCP');
  const b=await resolveRecordTarget(sheet,'records',data,'sess','Shaft gen - redutora ');
  assert.notEqual(a.target.revision,b.target.revision);
});
