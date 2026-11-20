// Agent Skills spec validation (https://agentskills.io/specification), plus Claude Code / Codex
// specifics. Used by tests, by `--mode validate-skill`, and by the installer.
import fs from 'node:fs';
import path from 'node:path';
import { splitFrontmatter } from './markdown.ts';
import { parseYaml } from './yaml.ts';
import { normalizeText, toPosix } from './util.ts';

export interface SkillCheck {
  ok: boolean;
  name?: string;
  errors: string[];
  warnings: string[];
  info: { lines: number; descriptionChars: number; references: string[]; scripts: string[] };
}

const SPEC_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const CLAUDE_FIELDS = new Set(['when_to_use', 'argument-hint', 'arguments', 'disable-model-invocation', 'user-invocable', 'disallowed-tools', 'model', 'effort', 'context', 'agent', 'background', 'hooks', 'paths', 'shell']);

export function validateSkillDir(dir: string): SkillCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const file = path.join(dir, 'SKILL.md');
  const info: SkillCheck['info'] = { lines: 0, descriptionChars: 0, references: [], scripts: [] };
  if (!fs.existsSync(file)) return { ok: false, errors: [`SKILL.md not found in ${dir}`], warnings, info };
  const text = normalizeText(fs.readFileSync(file, 'utf8'));
  info.lines = text.split('\n').length;
  if (!text.startsWith('---\n')) errors.push('frontmatter must start on the first line with ---');
  const { fm, body } = splitFrontmatter(text);
  if (!fm) return { ok: false, errors: [...errors, 'missing YAML frontmatter'], warnings, info };
  const parsed = parseYaml(fm.raw);
  if (parsed.error) errors.push(`invalid YAML frontmatter: ${parsed.error}`);
  const data = fm.data;
  const name = data.name;
  if (typeof name !== 'string' || !name) errors.push('"name" is required');
  else {
    if (name.length > 64) errors.push('"name" must be at most 64 characters');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) errors.push('"name" may only contain lowercase letters, digits and single hyphens, and must not start/end with a hyphen');
    if (path.basename(dir) !== name) errors.push(`"name" (${name}) must match the directory name (${path.basename(dir)})`);
    if (name.startsWith('anthropic-skills') || name === 'synced') errors.push('"name" uses a reserved Claude Code name');
  }
  const desc = data.description;
  if (typeof desc !== 'string' || !desc.trim()) errors.push('"description" is required');
  else {
    info.descriptionChars = desc.length;
    if (desc.length > 1024) errors.push(`"description" is ${desc.length} characters (max 1024)`);
    if (!/\buse (it )?when\b|\bwhen\b/i.test(desc)) warnings.push('"description" should say when to use the skill');
  }
  if (data.compatibility !== undefined && (typeof data.compatibility !== 'string' || data.compatibility.length > 500)) errors.push('"compatibility" must be a string of at most 500 characters');
  if (data.metadata !== undefined) {
    if (!data.metadata || typeof data.metadata !== 'object' || Array.isArray(data.metadata)) errors.push('"metadata" must be a map');
    else for (const [k, v] of Object.entries(data.metadata)) if (typeof v !== 'string') errors.push(`metadata.${k} must be a string`);
  }
  if (data['allowed-tools'] !== undefined && typeof data['allowed-tools'] !== 'string') errors.push('"allowed-tools" must be a space-separated string');
  for (const k of Object.keys(data)) {
    if (SPEC_FIELDS.has(k)) continue;
    if (CLAUDE_FIELDS.has(k)) warnings.push(`"${k}" is a Claude Code extension; claude.ai uploads and the Skills API reject it`);
    else warnings.push(`unknown frontmatter field "${k}"`);
  }
  if (info.lines > 500) warnings.push(`SKILL.md has ${info.lines} lines (recommended < 500); move detail to references/`);
  if (body.length / 4 > 5000) warnings.push(`SKILL.md body is ~${Math.round(body.length / 4)} tokens (recommended < 5000)`);
  // referenced files must exist and stay one level deep
  for (const m of body.matchAll(/\]\(((?:references|scripts|assets|agents)\/[^)#\s]+)\)|`((?:references|scripts|assets)\/[^`\s]+)`/g)) {
    const ref = (m[1] ?? m[2]).replace(/[),.;:]+$/, '');
    if (ref.includes('*') || ref.includes('<')) continue;
    if (!fs.existsSync(path.join(dir, ref))) errors.push(`referenced file not found: ${ref}`);
    if (ref.startsWith('references/')) info.references.push(ref);
    if (ref.startsWith('scripts/')) info.scripts.push(ref);
  }
  info.references = [...new Set(info.references)];
  info.scripts = [...new Set(info.scripts)];
  const refDir = path.join(dir, 'references');
  if (fs.existsSync(refDir)) {
    for (const f of fs.readdirSync(refDir)) {
      const t = fs.readFileSync(path.join(refDir, f), 'utf8');
      for (const m of t.matchAll(/\]\(((?!https?:|#)[^)\s]+\.md)(?:#[^)]*)?\)/g)) {
        const target = path.resolve(refDir, m[1]);
        if (!fs.existsSync(target)) errors.push(`references/${f}: broken link to ${m[1]}`);
      }
      if (!info.references.includes(`references/${f}`)) warnings.push(`references/${f} is not linked from SKILL.md`);
    }
  }
  // Codex agents/openai.yaml (optional)
  const oy = path.join(dir, 'agents', 'openai.yaml');
  if (fs.existsSync(oy)) {
    const y = parseYaml(fs.readFileSync(oy, 'utf8'));
    if (y.error) errors.push(`agents/openai.yaml: ${y.error}`);
    else {
      const v = y.value as Record<string, any>;
      if (v.policy?.allow_implicit_invocation !== undefined && typeof v.policy.allow_implicit_invocation !== 'boolean') errors.push('agents/openai.yaml: policy.allow_implicit_invocation must be boolean');
      if (v.interface?.short_description && String(v.interface.short_description).length > 120) warnings.push('agents/openai.yaml: interface.short_description is long');
    }
  }
  return { ok: errors.length === 0, name: typeof name === 'string' ? name : undefined, errors, warnings: warnings.map((w) => toPosix(w)), info };
}
