// Natural-language → operation mapping (EN/ES). Agents map requests themselves following SKILL.md;
// this is the deterministic fallback used by the CLI when no --mode is given.
export const MODES = [
  'analyze', 'generate', 'sync', 'search', 'context', 'validate', 'reorganize', 'transform', 'export', 'examples', 'capabilities',
  'index', 'conflicts', 'restore', 'status', 'help', 'validate-skill',
] as const;
export type Mode = (typeof MODES)[number];

const RULES: { mode: Mode; re: RegExp; extract?: RegExp }[] = [
  { mode: 'capabilities', re: /\b(capabilit\w*|what can (you|it) do|supported formats|qu[ée] (puedes|sabes) hacer|capacidades|formatos soportados)\b/i },
  { mode: 'restore', re: /\b(restore|undo|roll ?back|revert|recover|restaura\w*|deshac\w*|recupera\w*|revierte)\b/i },
  { mode: 'conflicts', re: /\b(conflicts?|conflictos?)\b/i },
  { mode: 'examples', re: /\b(examples?|demo|sample app|ejemplos?|aplicaci[oó]n de (ejemplo|demostraci[oó]n))\b/i, extract: /(?:example|ejemplo|demo)\w*\s+(?:of|de|for|para|that|que)?\s*(.+)$/i },
  { mode: 'context', re: /\b(context(o)?\s+(package|for|para)|paquete de contexto|context pack)\b/i, extract: /(?:for|para)\s+(.+)$/i },
  { mode: 'export', re: /\b(export\w*|exporta\w*|static site|sitio (web|est[aá]tico)|publish)\b/i },
  { mode: 'transform', re: /\b(convert\w*|transform\w*|convierte|convertir|transforma\w*)\b/i },
  { mode: 'reorganize', re: /\b(reorgani[sz]\w*|restructur\w*|reestructura\w*|reorganiza\w*)\b/i },
  { mode: 'validate', re: /\b(validat\w*|valida\w*|check the vault|verify|verifica\w*|comprueba\w*|broken links|enlaces rotos)\b/i },
  { mode: 'sync', re: /\b(sync\w*|synchroni[sz]\w*|sincroniza\w*|refresh|update the vault|actualiza\w* (el )?vault|incremental)\b/i },
  { mode: 'search', re: /\b(search|find|look ?up|where is|where are|busca\w*|encuentra\w*|d[oó]nde (est[aá]|se))\b/i, extract: /(?:search|find|look ?up|busca\w*|encuentra\w*)\s+(?:for\s+)?(.+)$/i },
  { mode: 'index', re: /\b(re-?index|rebuild (the )?index|reindexa\w*|índice)\b/i },
  { mode: 'status', re: /\b(status|estado|what changed|qu[ée] ha cambiado)\b/i },
  { mode: 'generate', re: /\b(generat\w*|create|build|genera\w*|crea\w*|construye)\b/i },
  { mode: 'analyze', re: /\b(analy[sz]\w*|inspect|analiza\w*|examina\w*|propose|prop[oó]n\w*|plan)\b/i },
];

const QUESTION = /^\s*(?:¿\s*)?(where|how|what|which|who|why|when|is|are|does|do|can|could|should|d[oó]nde|c[oó]mo|qu[eé]|cu[aá]l(?:es)?|qui[eé]n|por qu[eé]|cu[aá]ndo|es|hay|puedo)\b/i;

export interface Intent {
  mode: Mode;
  confidence: 'explicit' | 'keyword' | 'default';
  text?: string;
  alternatives: Mode[];
}

export function detectIntent(request: string | undefined, hasManifest: boolean): Intent {
  const text = (request ?? '').trim();
  if (!text) return { mode: hasManifest ? 'status' : 'analyze', confidence: 'default', alternatives: [] };
  const hits = RULES.filter((r) => r.re.test(text));
  if (!hits.length) return { mode: 'search', confidence: 'default', text, alternatives: hasManifest ? [] : ['analyze'] };
  // a question ("where is X validated?") is a search unless it starts with an operation verb
  const question = QUESTION.test(text) || /\?\s*$/.test(text);
  const imperative = hits.find((h) => new RegExp(`^\\s*(?:please\\s+|por favor\\s+)?(?:${h.re.source})`, 'i').test(text));
  if (question && !imperative && hits[0].mode !== 'search') {
    return { mode: 'search', confidence: 'keyword', text, alternatives: hits.map((h) => h.mode).filter((m) => m !== 'search') };
  }
  const first = imperative ?? hits[0];
  const extracted = first.extract?.exec(text)?.[1]?.trim();
  return { mode: first.mode, confidence: 'keyword', text: extracted || text, alternatives: hits.slice(1).map((h) => h.mode) };
}
