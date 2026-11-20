// Shared contracts for vault-generator. Pure types: this file is erased at runtime
// (Node type-stripping), so never put runtime code here.

// ───────────────────────── primitives ─────────────────────────
/** verified = proven by a manifest/statement/static import; inferred = derived by a rule; heuristic = pattern guess */
export type Confidence = 'verified' | 'inferred' | 'heuristic';
export type AccessLevel = 'public' | 'restricted';
export type NoteStatus = 'current' | 'needs-review' | 'stale' | 'conflict' | 'deprecated';
/** generated: derived from code/config analysis; imported: converted from a source document;
 *  derived: built from other notes (MOCs, indexes); manual: written by a human. */
export type NoteOrigin = 'generated' | 'imported' | 'derived' | 'manual';

/** Pointer into a source file. `path` is posix and relative to the source root. */
export interface SourceRef {
  source: string;
  path: string;
  hash?: string;
  lines?: [number, number];
}
export interface Evidence {
  ref: SourceRef;
  note?: string;
}
export interface Warning {
  code: string;
  message: string;
  ref?: SourceRef;
}

// ───────────────────────── configuration ─────────────────────────
export interface AccessPolicy {
  /** Globs (relative to each source root) that must never be read, indexed, exported or listed. */
  deny: string[];
  /** Globs whose notes are generated with access=restricted and excluded from search/context/export by default. */
  restricted: string[];
  followSymlinks: 'within-roots' | 'never';
  maxFileBytes: number;
}
export interface Config {
  language: 'en' | 'es';
  depth: 'shallow' | 'standard' | 'deep';
  vault?: string;
  /** Extra ignore globs applied to every source. */
  exclude: string[];
  /** Directory base names never descended into (dependency/build/cache dirs). */
  ignoreDirs: string[];
  /** Honor .gitignore/.vgignore found at each source root. */
  useGitignore: boolean;
  /** If non-empty, only matching files are analyzed. */
  include: string[];
  access: AccessPolicy;
  layout: { folderThreshold: number; maxNoteChars: number };
  retention: { backupRuns: number };
  attachments: { copy: boolean; maxBytes: number };
  /** Plugin modules (relative to the config file). Loaded only after the user trusts them. */
  plugins: string[];
  /** Source-of-truth precedence used only to *suggest* a default when contradictions are found. */
  truthPrecedence: string[];
}

// ───────────────────────── scanning ─────────────────────────
export interface SourceInfo {
  id: string;
  /** absolute real path of the source root (never persisted) */
  root: string;
  /** posix path relative to the vault directory (what is persisted) */
  rel: string;
  label: string;
  kind: 'repo' | 'dir' | 'docs' | 'vault';
  /** project ids found inside this source */
  projects: string[];
  /** when the user pointed at a single file: only these root-relative paths are analysed */
  only?: string[];
}
export interface FileInfo {
  source: string;
  path: string;
  abs: string;
  size: number;
  mtimeMs: number;
  ext: string;
  /** coarse format used for analyzer routing */
  format: string;
  hash: string;
  restricted: boolean;
  /** policy = matched access.restricted; marker = auto-detected (path segment or frontmatter), needs a user decision */
  restrictedBy?: 'policy' | 'marker';
}
export type SkipReason =
  | 'denied-by-policy'
  | 'sensitive-file'
  | 'binary'
  | 'too-large'
  | 'symlink-outside-root'
  | 'unreadable'
  | 'ignored';
export interface SkipRecord {
  source: string;
  path: string;
  reason: SkipReason;
}
export interface ScanResult {
  files: FileInfo[];
  skipped: SkipRecord[];
  /** number of entries skipped silently because of standard ignore dirs (node_modules, .git, ...) */
  ignoredDirs: number;
}

// ───────────────────────── analyzers ─────────────────────────
export interface Section {
  level: number;
  title: string;
  slug: string;
  /** 1-based inclusive line range inside DocumentUnit.body */
  start: number;
  end: number;
}
export interface LinkRef {
  /** raw target as written in the source */
  target: string;
  text?: string;
  line: number;
  kind: 'link' | 'image' | 'wikilink' | 'embed';
}
export interface DocumentUnit {
  /** unique within its source file; usually the file path (or path#fragment when a file yields several documents) */
  key: string;
  file: SourceRef;
  title: string;
  /** analyzer-level kind: markdown | html | text | diagram | adr | api-doc | ... */
  kind: string;
  category?: string;
  /** Obsidian-compatible markdown. Relative links are still in source form; the note producer rewrites them. */
  body: string;
  frontmatter?: Record<string, unknown>;
  sections: Section[];
  links: LinkRef[];
  codeBlocks: { lang: string; line: number }[];
  mermaid: number;
  tables: number;
  admonitions: { kind: string; text: string; line: number }[];
  version?: string;
  /** Information that could not be preserved by the conversion. Never empty-but-lossy. */
  lossy: string[];
}

/** A claim extracted from a source, used for contradiction detection. */
export interface Fact {
  subject: string; // e.g. 'runtime:node', 'port:http', 'cmd:npm run build'
  value: string;
  ref: SourceRef;
  /** where it was stated: manifest | code | generated-doc | doc | readme */
  authority: string;
  text?: string;
}

export interface Entity {
  /** globally unique identity key, e.g. 'project:@acme/core', 'op:petstore:GET /pets' */
  key: string;
  /** open vocabulary: workspace, repository, project, application, package, module, component, api, operation, contract, document, example, decision, pattern, dependency, configuration, concept ... */
  type: string;
  name: string;
  /** project/source id this belongs to ('' for workspace level) */
  scope: string;
  summary?: string;
  attrs: Record<string, unknown>;
  refs: SourceRef[];
  confidence: Confidence;
  /** hash of the contract-relevant part, used to detect contract changes between syncs */
  fingerprint?: string;
}
export type RelationType =
  | 'belongs-to'
  | 'depends-on'
  | 'implements'
  | 'exposes'
  | 'consumes'
  | 'documents'
  | 'exemplifies'
  | 'supersedes'
  | 'relates-to'
  | 'derives-from'
  | (string & {});
export interface Relation {
  type: RelationType;
  /** entity keys */
  from: string;
  to: string;
  /** verified = proven by a declaration; inferred = pattern match, never shown as fact; confirmed = inferred and confirmed by the user */
  status: 'verified' | 'inferred' | 'confirmed';
  evidence: Evidence[];
}

export interface CodeSymbol {
  name: string;
  /** function | class | interface | type | enum | const | method | route | component | ... */
  kind: string;
  signature: string;
  doc?: string;
  line: number;
  exported: boolean;
  /** container for members, e.g. class name */
  parent?: string;
  members?: CodeSymbol[];
  decorators?: string[];
  attrs?: Record<string, unknown>;
}
export interface CodeFileInfo {
  file: SourceRef;
  language: string;
  imports: { spec: string; names: string[]; line: number }[];
  symbols: CodeSymbol[];
  /** leading file/module comment */
  moduleDoc?: string;
  lines: number;
}

export interface AnalysisResult {
  documents: DocumentUnit[];
  entities: Entity[];
  relations: Relation[];
  facts: Fact[];
  /** structured code information (only produced by code analyzers) */
  code?: CodeFileInfo;
  limitations: string[];
  warnings: Warning[];
  /** raw text findings: secrets redacted etc. */
  redactions?: number;
}
export interface AnalyzerContext {
  source: SourceInfo;
  config: Config;
  /** read file as utf8 text with BOM stripped and newlines normalized to \n */
  read(file: FileInfo): string;
  /** exists inside the same source root (for broken-link detection) */
  exists(relPath: string): boolean;
}
export interface Analyzer {
  id: string;
  version: string;
  description: string;
  /** formats/extensions handled, for the capabilities report */
  handles: string[];
  limitations: string[];
  /** returns a priority (higher wins) or 0/undefined if the file is not handled */
  match(file: FileInfo, head: string): number;
  analyze(file: FileInfo, ctx: AnalyzerContext): AnalysisResult;
}

// ───────────────────────── context detection ─────────────────────────
export interface Tech {
  name: string;
  version?: string;
  evidence: string;
}
export interface Dependency {
  name: string;
  range?: string;
  kind: 'prod' | 'dev' | 'peer' | 'optional' | 'build';
  /** true when the name matches another project of the detected workspace */
  internal?: boolean;
  evidence: Evidence;
}
export type ProjectKind = 'application' | 'library' | 'package' | 'service' | 'cli' | 'docs' | 'example' | 'unknown';
export interface ProjectInfo {
  /** stable slug, unique inside the report */
  id: string;
  name: string;
  /** posix, relative to the analyzed root; '.' for the root itself */
  path: string;
  ecosystem: string;
  kind: ProjectKind;
  kindEvidence: string[];
  version?: string;
  description?: string;
  frameworks: Tech[];
  languages: string[];
  dependencies: Dependency[];
  scripts: Record<string, string>;
  entryPoints: string[];
  manifests: string[];
  private?: boolean;
}
export type ContextKind =
  | 'single-project'
  | 'monorepo'
  | 'multi-repo-workspace'
  | 'docs-only'
  | 'existing-vault'
  | 'mixed'
  | 'unknown';
export interface RepositoryInfo {
  path: string;
  hasGit: boolean;
}
export interface WorkspaceInfo {
  tool: string;
  path: string;
  globs: string[];
  evidence: string;
}
export interface DocSourceInfo {
  path: string;
  files: number;
  formats: Record<string, number>;
  /** version label if the folder is a versioned documentation tree */
  version?: string;
  generator?: string;
}
export interface VaultInfo {
  path: string;
  hasManifest: boolean;
  hasObsidianDir: boolean;
  notes: number;
}
export interface ContextReport {
  /** analyzed directory, posix relative to itself ('.') — absolute path is only in `rootAbs` (not persisted) */
  rootAbs: string;
  kind: ContextKind;
  confidence: number;
  repositories: RepositoryInfo[];
  workspaces: WorkspaceInfo[];
  projects: ProjectInfo[];
  docSources: DocSourceInfo[];
  vaults: VaultInfo[];
  /** internal project→project dependency edges with evidence */
  graph: { from: string; to: string; kind: string; evidence: string }[];
  /** parent workspace root when the start dir is inside one (relative to rootAbs, e.g. '../..') */
  parentWorkspace?: { path: string; tool: string };
  /** name declared by the root manifest (workspace or single project), used to name the vault */
  rootName?: string;
  evidence: { kind: string; path: string; detail: string }[];
  /** versions seen in more than one place for the same thing */
  versionMismatches: { subject: string; values: { value: string; path: string }[] }[];
  ambiguities: string[];
  /** counts for quick sizing */
  stats: { files: number; sourceFiles: number; docFiles: number; dirs: number };
}

// ───────────────────────── questions / decisions ─────────────────────────
export interface QuestionOption {
  value: string;
  label: string;
  consequence?: string;
}
export interface Question {
  /** stable decision key, also the name used in `--answer <id>=<value>` */
  id: string;
  kind: string;
  prompt: string;
  why: string;
  options: QuestionOption[];
  multi?: boolean;
  /** option value applied when the question is non-blocking and the user does not answer */
  default?: string;
  /** blocking questions stop the operation before any write */
  blocking: boolean;
  /** free-text answer allowed */
  freeText?: boolean;
  group?: string;
}
export interface Decision {
  answer: string;
  answeredAt?: string;
  prompt?: string;
}

// ───────────────────────── notes & vault ─────────────────────────
export interface PlannedNote {
  /** stable id (persisted as vg.id); survives renames and moves */
  id: string;
  /** identity key, persisted as vg.key */
  key: string;
  type: string;
  category: string;
  scope: string;
  title: string;
  /** vault-relative posix dir; '' = vault root */
  folder: string;
  /** file name without extension (sanitized, unique within folder) */
  fileName: string;
  /** generated region content (no frontmatter, no markers) */
  body: string;
  /** managed frontmatter additions (tags, aliases, version, symbols, apis, relation lists, access, ...) */
  fm: Record<string, unknown>;
  origin: NoteOrigin;
  status: NoteStatus;
  access: AccessLevel;
  confidence: Confidence;
  sources: SourceRef[];
  analyzer?: string;
  /** keys of notes this one links to (resolved later) */
  linkKeys: string[];
  /** attachment copies: source file → vault-relative target */
  attachments: { from: { source: string; path: string }; to: string }[];
}

export type NoteAction =
  | 'create'
  | 'unchanged'
  | 'update'
  | 'merged'
  | 'conflict'
  | 'preserved-edited'
  | 'renamed'
  | 'stale';

export interface VaultNote {
  /** vault-relative posix path including .md */
  path: string;
  id: string;
  title: string;
  type?: string;
  fm: Record<string, unknown>;
  hasVg: boolean;
  key?: string;
  body: string;
  /** generated region text if markers exist */
  region?: string;
  regionHash?: string;
  access: AccessLevel;
  /** file line number = lineOffset + line number inside `body` (frontmatter and the vg:begin marker are not part of body) */
  lineOffset: number;
}

// ───────────────────────── manifest ─────────────────────────
export interface ManifestSource {
  id: string;
  /** posix path relative to the vault directory; null when it lives on another drive (bound in local.json) */
  path: string | null;
  label: string;
  kind: SourceInfo['kind'];
  projects: string[];
  only?: string[];
}
export interface Manifest {
  schema: 1;
  scopeId: string;
  name: string;
  createdWith: { tool: 'vault-generator'; version: string };
  language: 'en' | 'es';
  depth: 'shallow' | 'standard' | 'deep';
  vault: { placement: 'root' | 'subfolder'; folder: string };
  /** posix path from the vault directory to the workspace root */
  workspaceRoot: string;
  context: {
    kind: ContextKind;
    tools: string[];
    repositories: string[];
    projects: {
      id: string;
      name: string;
      path: string;
      kind: ProjectKind;
      ecosystem: string;
      version?: string;
      technologies: string[];
    }[];
    docSources: DocSourceInfo[];
    relations: { type: string; from: string; to: string; status: string }[];
    technologies: Record<string, string>;
    versions: { subject: string; values: string[] }[];
  };
  sources: ManifestSource[];
  scopeSelection: { mode: 'all' | 'projects'; projects: string[] };
  layout: { strategy: string; folders: Record<string, string> };
  indexing: { engine: 'sqlite-fts5'; notes: number; contentHash: string };
  sync: { strategy: 'hash+mtime'; lastRunId: string };
  decisions: Record<string, Decision>;
  conflicts: ConflictRecord[];
  transformers: string[];
  trustedPlugins: Record<string, string>;
}
export interface ConflictRecord {
  id: string;
  noteId: string;
  path: string;
  kind: 'edited-generated-region' | 'contradiction' | 'moved-and-edited' | 'other';
  /** vault-relative path of the saved incoming version */
  incoming?: string;
  runId: string;
  detail: string;
}

// ───────────────────────── operations ─────────────────────────
export interface OpOptions {
  mode: string;
  cwd: string;
  vault?: string;
  config?: string;
  sources: string[];
  scope: string[];
  depth?: 'shallow' | 'standard' | 'deep';
  language?: 'en' | 'es';
  answers: Record<string, string>;
  dryRun: boolean;
  json: boolean;
  /** free positional text / --request */
  request?: string;
  /** mode-specific flags */
  flags: Record<string, string | boolean | string[]>;
}
export type ResultStatus = 'done' | 'needs_input' | 'error' | 'dry_run';
export interface OpResult {
  ok: boolean;
  mode: string;
  status: ResultStatus;
  summary: string;
  data: Record<string, unknown>;
  questions: Question[];
  warnings: string[];
  next: string[];
  /** process exit code suggestion */
  exitCode: number;
}

// ───────────────────────── transformers ─────────────────────────
export interface TransformerSpec {
  id: string;
  version: string;
  description: string;
  kind: 'transform' | 'export';
  inputs: string[];
  outputs: string[];
  requires: string[];
  dependencies: string[];
  capabilities: string[];
  validations: string[];
  limitations: string[];
  updatePolicy: 'overwrite-generated' | 'create-only' | 'merge';
}
export interface TransformContext {
  cwd: string;
  /** absolute vault directory when the transformer needs one */
  vaultDir?: string;
  config: Config;
  /** include restricted notes (explicitly granted by the user) */
  includeRestricted: boolean;
  args: Record<string, string | boolean | string[]>;
}
export interface TransformResult {
  ok: boolean;
  outputs: string[];
  warnings: string[];
  validations: { name: string; passed: boolean; detail?: string }[];
  lossy: string[];
  details?: Record<string, unknown>;
}
export interface Transformer extends TransformerSpec {
  run(ctx: TransformContext, input: string | undefined, output: string | undefined): TransformResult | Promise<TransformResult>;
}
