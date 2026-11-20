export function parse(toml: string): Record<string, any>;
export function stringify(obj: Record<string, unknown>): string;
export class TomlError extends Error {}
export class TomlDate extends Date {}
declare const _default: { parse: typeof parse; stringify: typeof stringify };
export default _default;
