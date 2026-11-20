declare const YAML: {
  parse(src: string, options?: Record<string, unknown>): any;
  parseAllDocuments(src: string, options?: Record<string, unknown>): any[] | any;
  stringify(value: unknown, options?: Record<string, unknown>): string;
};
export default YAML;
