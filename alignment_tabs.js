const { norm } = require('./alignment_config');
const GENERIC = new Set(['drive', 'motor', 'motor eletrico', 'motor a diesel', 'alternador']);
const builtins = [
  ['mcp', 'motor de propulsao', 'motor de propulsao principal', 'motor de combustao principal', 'propulsion engine', 'main engine'],
  ['gerador de eixo', 'shaft generator', 'shaft gen'],
  ['caixa redutora', 'redutora', 'gearbox']
];
const clean = value => norm(value).replace(/([a-z])(\d)/g, '$1 $2').replace(/\s+/g, ' ');
const base = value => clean(value).replace(/\s*,\s*(?:alternator|elect\.?\s*motor).*$/, '').replace(/\s*(?:no\.?|nº|#)\s*\d+\b/g, '').replace(/^([a-z]{2,6})\s+\d+$/, '$1').trim();
const contains = (text, term) => {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Boolean(term) && new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`).test(text);
};
function resolveTargetTab({tabs, config = {}, data = {}, contextText = ''}) {
  const titles = tabs.map(t => typeof t === 'string' ? t : t.title);
  if (titles.length === 1 && norm(titles[0]) === 'modelo alinhamento') return {status:'ready', tabTitle:titles[0]};
  const groups = new Map();
  for (const row of config.glossary || []) {
    const key = base(row.taxonomia || row.termo);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, {terms:new Set(), explicit:new Set()});
    const group = groups.get(key);
    for (const term of [key, row.termo, ...(row['possiveis nomes'] || row['nomes possiveis'] || '').split(/[;,]/)]) {
      const value = base(term); if (value) group.terms.add(value);
    }
    if (row.aba || row.planilha) group.explicit.add(norm(row.aba || row.planilha));
  }
  const families = [...groups.values()];
  // Aliases built into the application augment matching glossary families, rather than
  // counting as separate owners of the same word.
  for (const aliases of builtins) {
    const hits = families.filter(f => aliases.some(a => f.terms.has(a)));
    if (!hits.length) families.push({terms:new Set(aliases), explicit:new Set()});
    else for (const family of hits) for (const alias of aliases) family.terms.add(alias);
  }
  const owners = new Map();
  for (const family of families) for (const term of family.terms) owners.set(term, (owners.get(term) || 0) + 1);
  const usable = term => term.length > 1 && !GENERIC.has(term) && owners.get(term) === 1;
  const matchingFamilies = text => families.filter(f => [...f.terms].some(t => usable(t) && contains(text, t)));
  const primary = clean([data.equipment, data.class].filter(Boolean).join(' '));
  const selected = matchingFamilies(primary || clean(contextText));
  const titleMatches = (title, family) => family.explicit.has(norm(title)) || [...family.terms].some(t => usable(t) && contains(clean(title), t));
  let scored = titles.map(title => ({title, score:selected.filter(f => titleMatches(title,f)).length}));
  const best = Math.max(0,...scored.map(x => x.score));
  let winners = scored.filter(x => best && x.score === best);
  if (winners.length > 1) {
    const context = clean([data.stationary_class, contextText].filter(Boolean).join(' '));
    const contextualFamilies = matchingFamilies(context);
    // Configurations expand stationary terms through glossary families.
    for (const row of config.combinations || []) {
      const drive = clean(row['maquina a ser alinhada / drive machine'] || row['drive machine'] || row['maquina a ser alinhada']);
      const stationary = clean(row['maquina estacionaria']);
      if (!drive || !stationary || !contains(context, stationary)) continue;
      for (const f of matchingFamilies(stationary)) if (!contextualFamilies.includes(f)) contextualFamilies.push(f);
    }
    scored = winners.map(item => ({...item, tie:contextualFamilies.filter(f => !selected.includes(f) && titleMatches(item.title,f)).length}));
    const tie = Math.max(...scored.map(x => x.tie));
    if (tie) winners = scored.filter(x => x.tie === tie);
  }
  return winners.length === 1 ? {status:'ready',tabTitle:winners[0].title} : {status:winners.length ? 'ambiguous_tab' : 'tab_not_found',tabs:winners.length ? winners.map(x => x.title) : titles};
}
module.exports = {resolveTargetTab};
