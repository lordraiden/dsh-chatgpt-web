/**
 * Types for the dependency-free HAR shape analyser, so the test suite can import the pieces it
 * asserts on without adding `allowJs` to the project's TypeScript program.
 *
 * The script is plain ESM that runs under Node with no npm dependencies; this file names only what
 * the tests and the CLI need. Keep it in sync with `har-shape.mjs`.
 */

export const USAGE: string;

export interface HarShapeOptions {
  top?: number;
  depth?: number;
  frames?: number;
  maxBodyLines?: number;
}

export interface CliOptions {
  path: string;
  json: boolean;
  help: boolean;
  top: number;
  depth: number;
  frames: number;
}

export interface HarDocument {
  entries: unknown[];
}

export interface HarFile {
  name: string;
  document: HarDocument;
}

export interface SseParse {
  frames: unknown[];
  eventNames: string[];
  doneMarkers: number;
  dataLines: number;
  unparsable: number;
  empty: number;
}

export interface TerminationValue {
  value: string;
  count: number;
}

export interface TerminationField {
  path: string;
  values: TerminationValue[];
  suppressed: number;
  distinct: number;
  changes: boolean;
}

export interface FrameShape {
  shape: string;
  count: number;
}

export interface SseSummary {
  responses: number;
  dataLines: number;
  doneMarkers: number;
  unparsable: number;
  eventNames: string[];
  shapes: FrameShape[];
  shapeTotal: number;
  terminationFields: TerminationField[];
}

export interface RequestBodySummary {
  contentType: string;
  params: string[];
  note: string;
  shape: unknown;
}

export interface ModelField {
  path: string;
  value: string;
}

export interface AccountField {
  path: string;
  fingerprint: string;
  occurrences: number;
}

export interface EndpointReport {
  method: string;
  host: string;
  path: string;
  requests: number;
  queryNames: string[];
  statuses: number[];
  requestContentTypes: string[];
  responseContentTypes: string[];
  requestHeaderNames: string[];
  requestBodies: RequestBodySummary[];
  requestShape: unknown;
  responseShape: unknown;
  sse: SseSummary | null;
  models: ModelField[];
  accounts: AccountField[];
  missingResponseContent: number;
  score: number;
  reasons: string[];
}

export interface CandidateReport {
  method: string;
  host: string;
  path: string;
  requests: number;
  score: number;
  reasons: string[];
}

export interface HarReport {
  har: {
    name: string;
    entries: number;
    hosts: string[];
    endpointShapes: number;
    malformedUrls: number;
  };
  options: Required<HarShapeOptions>;
  endpoints: EndpointReport[];
  turnCandidates: CandidateReport[];
  modelCandidates: (ModelField & { endpoint: string })[];
  accountCandidates: (AccountField & { endpoint: string })[];
  missingObservations: string[];
  notes: string[];
}

export function isTokenShaped(value: unknown): boolean;
export function normalizePath(pathname: string): string;
export function compactShape(node: unknown): string;
export function parseSseText(text: string): SseParse;
export function readHarFile(path: string): HarFile;
export function parseHarDocument(parsed: unknown): HarDocument;
export function analyzeHar(document: HarDocument, options?: HarShapeOptions): HarReport;
export function formatReport(report: HarReport): string;
export function reportToJson(report: HarReport): unknown;
export function parseArgs(argv: readonly string[]): CliOptions;
export function main(
  argv: readonly string[],
  io?: { stdout?: (text: string) => void; stderr?: (text: string) => void },
): number;
