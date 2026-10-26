import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { PassThrough, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parse } from "csv-parse";
import ExcelJS from "exceljs";
import { SaxesParser } from "saxes";
import unzipper from "unzipper";

export interface IngestLimits {
  maxFileBytes?: number;
  maxFiles?: number;
  maxRows?: number;
  maxColumns?: number;
}

export const DEFAULT_INGEST_LIMITS: Readonly<Required<IngestLimits>> = {
  maxFileBytes: 25 * 1024 * 1024,
  maxFiles: 100,
  maxRows: 100000,
  maxColumns: 500,
};

export const XLSX_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
export const XLSX_MAX_WORKBOOK_BYTES = 128 * 1024 * 1024;
export const MAX_DATASET_JSONL_BYTES = 25 * 1024 * 1024;
export const MAX_BATCH_JSONL_BYTES = 100 * 1024 * 1024;

export type DatasetFieldType =
  | "empty"
  | "string"
  | "number"
  | "boolean"
  | "mixed";

export interface ParsedDatasetField {
  name: string;
  index: number;
  inferredType: DatasetFieldType;
}

export interface ParsedSourceMetadata {
  path: string;
  fileName: string;
  format: "csv" | "xlsx";
  sizeBytes: number;
  sheetName?: string;
}

export interface DatasetQualityStatistics {
  rowCount: number;
  columnCount: number;
  duplicateRowCount: number;
  emptyRowCount: number;
  typeInconsistencyCount: number;
}

export interface DatasetIssue {
  code:
    | "DUPLICATE_HEADER"
    | "EMPTY_HEADER"
    | "INCONSISTENT_COLUMNS"
    | "DUPLICATE_ROW"
    | "TYPE_INCONSISTENCY"
    | "MISSING_CACHED_FORMULA_RESULT";
  message: string;
  rowNumber?: number;
  columnNumber?: number;
}

export interface ParsedDataset {
  source: ParsedSourceMetadata;
  fields: ParsedDatasetField[];
  rowsJsonl: string;
  quality: DatasetQualityStatistics;
  issues: DatasetIssue[];
}

export interface ParsedFileBatch {
  datasets: ParsedDataset[];
}

type JsonValue = string | number | boolean | null;
type RowValues = JsonValue[];

interface ValidatedFile {
  path: string;
  fileName: string;
  format: "csv" | "xlsx";
  sizeBytes: number;
  handle: FileHandle;
  pendingReads: Set<Promise<void>>;
}

interface WorkbookRelationship {
  Id: string;
  Target: string;
}

interface WorkbookModel {
  sheets: { id: number; name: string; rId: string }[];
  properties: { date1904?: boolean };
}

interface XlsxStreamingEngine {
  parseWorkbook(stream: Readable): Promise<WorkbookModel>;
  parseRels(stream: Readable): Promise<WorkbookRelationship[]>;
  parseSharedStrings(stream: Readable): Promise<{ values: unknown[] }>;
}

interface XlsxStreamingReader {
  model: WorkbookModel;
  properties: { model: WorkbookModel["properties"] };
  workbookRels: WorkbookRelationship[];
  sharedStrings: unknown[];
  _parseStyles(stream: Readable): Promise<void>;
  _parseWorksheet(
    stream: Readable,
    sheetNumber: string,
  ): AsyncIterable<{
    value: ExcelJS.stream.xlsx.WorksheetReader & { name: string };
  }>;
}

class WorkbookInflationBudget {
  private totalBytes = 0;

  xml(entry: unzipper.File, label: string): Readable {
    let entryBytes = 0;
    return validatedXml(
      entry.stream(),
      label,
      (bytes) => {
        entryBytes += bytes;
        this.totalBytes += bytes;
        if (entryBytes > XLSX_MAX_ENTRY_BYTES) {
          throw new Error(`XLSX entry ${label} exceeds 64 MiB uncompressed ZIP entry limit`);
        }
        if (this.totalBytes > XLSX_MAX_WORKBOOK_BYTES) {
          throw new Error("XLSX exceeds 128 MiB uncompressed workbook limit");
        }
      },
    );
  }
}

class DatasetAccumulator {
  readonly issues: DatasetIssue[] = [];
  private names: string[] = [];
  private types: (Exclude<DatasetFieldType, "empty" | "mixed"> | "mixed" | undefined)[] =
    [];
  private rowsJsonl = "";
  private rowCount = 0;
  private jsonlBytes = 0;
  private readonly uniqueRowHashes = new Set<string>();
  private duplicateRowCount = 0;
  private emptyRowCount = 0;
  private typeInconsistencyCount = 0;

  constructor(
    readonly source: ParsedSourceMetadata,
    private readonly limits: Required<IngestLimits>,
    private readonly consumeRow: () => void,
    private readonly consumeJsonl: (bytes: number) => void,
  ) {}

  setHeaders(values: RowValues): void {
    this.assertColumnLimit(values.length);
    const used = new Set<string>();
    this.names = values.map((value, index) => {
      const original = value === null ? "" : String(value).trim();
      const base = original || `column_${index + 1}`;
      if (!original) {
        this.issues.push({
          code: "EMPTY_HEADER",
          message: `Empty header replaced with ${base}`,
          rowNumber: 1,
          columnNumber: index + 1,
        });
      }
      let name = base;
      let suffix = 2;
      while (used.has(name)) {
        if (suffix === 2) {
          this.issues.push({
            code: "DUPLICATE_HEADER",
            message: `Duplicate header ${base} renamed`,
            rowNumber: 1,
            columnNumber: index + 1,
          });
        }
        name = `${base}_${suffix}`;
        suffix += 1;
      }
      used.add(name);
      return name;
    });
    this.types = this.names.map(() => undefined);
  }

  addRow(values: RowValues, rowNumber: number): void {
    this.consumeRow();
    this.assertColumnLimit(values.length);
    if (values.length !== this.names.length) {
      this.issues.push({
        code: "INCONSISTENT_COLUMNS",
        message: `Expected ${this.names.length} columns but found ${values.length}`,
        rowNumber,
      });
    }

    const record: Record<string, JsonValue> = Object.create(null) as Record<
      string,
      JsonValue
    >;
    let empty = true;
    for (let index = 0; index < this.names.length; index += 1) {
      const value = values[index] ?? null;
      const name = this.names[index]!;
      record[name] = value;
      if (value !== null && value !== "") {
        empty = false;
      }
      this.observeType(index, value, rowNumber);
    }
    const serialized = JSON.stringify(record);
    const hash = createHash("sha256").update(serialized).digest("base64url");
    if (this.uniqueRowHashes.has(hash)) {
      this.duplicateRowCount += 1;
      this.issues.push({
        code: "DUPLICATE_ROW",
        message: "Duplicate row",
        rowNumber,
      });
    } else {
      this.uniqueRowHashes.add(hash);
    }
    if (empty) {
      this.emptyRowCount += 1;
    }

    const line = `${serialized}\n`;
    const bytes = Buffer.byteLength(line);
    if (this.jsonlBytes + bytes > MAX_DATASET_JSONL_BYTES) {
      throw new Error("Dataset exceeds 25 MiB normalized JSONL limit");
    }
    this.consumeJsonl(bytes);
    this.jsonlBytes += bytes;
    this.rowsJsonl += line;
    this.rowCount += 1;
  }

  finish(): ParsedDataset {
    return {
      source: this.source,
      fields: this.names.map((name, index) => ({
        name,
        index,
        inferredType: this.types[index] ?? "empty",
      })),
      rowsJsonl: this.rowsJsonl,
      quality: {
        rowCount: this.rowCount,
        columnCount: this.names.length,
        duplicateRowCount: this.duplicateRowCount,
        emptyRowCount: this.emptyRowCount,
        typeInconsistencyCount: this.typeInconsistencyCount,
      },
      issues: this.issues,
    };
  }

  private assertColumnLimit(columns: number): void {
    if (columns > this.limits.maxColumns) {
      const detail =
        this.limits.maxColumns === DEFAULT_INGEST_LIMITS.maxColumns
          ? "500 columns"
          : "column limit";
      throw new Error(`Import exceeds ${detail}`);
    }
  }

  private observeType(index: number, value: JsonValue, rowNumber: number): void {
    if (value === null || value === "") {
      return;
    }
    const observed = typeof value as "string" | "number" | "boolean";
    const previous = this.types[index];
    if (!previous) {
      this.types[index] = observed;
    } else if (previous !== observed) {
      if (previous !== "mixed") {
        this.typeInconsistencyCount += 1;
        this.issues.push({
          code: "TYPE_INCONSISTENCY",
          message: `Column ${this.names[index]} contains inconsistent types`,
          rowNumber,
          columnNumber: index + 1,
        });
      }
      this.types[index] = "mixed";
    }
  }
}

export async function ingestFiles(
  paths: string[],
  limits: IngestLimits,
): Promise<ParsedFileBatch> {
  const resolvedLimits = resolveLimits(limits);
  if (paths.length > resolvedLimits.maxFiles) {
    const detail =
      resolvedLimits.maxFiles === DEFAULT_INGEST_LIMITS.maxFiles
        ? "100 files"
        : "file limit";
    throw new Error(`Import exceeds ${detail}`);
  }

  const root = await canonicalImportRoot();
  let rowCount = 0;
  const consumeRow = (): void => {
    if (rowCount >= resolvedLimits.maxRows) {
      const detail =
        resolvedLimits.maxRows === DEFAULT_INGEST_LIMITS.maxRows
          ? "100000 rows"
          : "row limit";
      throw new Error(`Import exceeds ${detail}`);
    }
    rowCount += 1;
  };
  let jsonlBytes = 0;
  const consumeJsonl = (bytes: number): void => {
    if (jsonlBytes + bytes > MAX_BATCH_JSONL_BYTES) {
      throw new Error("Batch exceeds 100 MiB normalized JSONL limit");
    }
    jsonlBytes += bytes;
  };

  const datasets: ParsedDataset[] = [];
  for (const path of paths) {
    const file = await validateImportFile(root, path, resolvedLimits.maxFileBytes);
    try {
      if (file.format === "csv") {
        datasets.push(await parseCsv(file, resolvedLimits, consumeRow, consumeJsonl));
      } else {
        datasets.push(...(await parseXlsx(file, resolvedLimits, consumeRow, consumeJsonl)));
      }
    } finally {
      await Promise.all([...file.pendingReads]);
      await file.handle.close();
    }
  }
  return { datasets };
}

function resolveLimits(limits: IngestLimits): Required<IngestLimits> {
  const result = { ...DEFAULT_INGEST_LIMITS };
  for (const key of Object.keys(result) as (keyof IngestLimits)[]) {
    const requested = limits[key];
    if (requested !== undefined) {
      if (!Number.isSafeInteger(requested) || requested <= 0) {
        throw new Error(`${key} must be a positive integer`);
      }
      result[key] = Math.min(result[key], requested);
    }
  }
  return result;
}

async function canonicalImportRoot(): Promise<string> {
  const configured = process.env.MARKETING_IMPORT_ROOT;
  if (!configured) {
    throw new Error("MARKETING_IMPORT_ROOT is required for file imports");
  }
  const root = await realpath(resolve(configured));
  if (!(await stat(root)).isDirectory()) {
    throw new Error("MARKETING_IMPORT_ROOT must be a directory");
  }
  return root;
}

function assertInsideRoot(root: string, path: string): void {
  const child = relative(root, path);
  if (!child || child.startsWith(`..${sep}`) || child === ".." || resolve(root, child) !== path) {
    throw new Error(`Import path is outside MARKETING_IMPORT_ROOT: ${path}`);
  }
}

async function validateImportFile(
  root: string,
  path: string,
  maxFileBytes: number,
): Promise<ValidatedFile> {
  const candidate = resolve(root, path);
  assertInsideRoot(root, candidate);
  const extension = extname(candidate).toLowerCase();
  if (extension !== ".csv" && extension !== ".xlsx") {
    throw new Error("Only .csv or .xlsx imports are supported");
  }

  const canonicalPath = await realpath(candidate);
  assertInsideRoot(root, canonicalPath);
  const canonicalExtension = extname(canonicalPath).toLowerCase();
  if (canonicalExtension !== extension) {
    throw new Error("Only .csv or .xlsx imports are supported");
  }
  const handle = await open(
    canonicalPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const [metadata, openedPath, openedMetadata] = await Promise.all([
      handle.stat(),
      realpath(canonicalPath),
      stat(canonicalPath),
    ]);
    assertInsideRoot(root, openedPath);
    if (
      openedPath !== canonicalPath ||
      metadata.dev !== openedMetadata.dev ||
      metadata.ino !== openedMetadata.ino
    ) {
      throw new Error(`Import file changed while opening: ${path}`);
    }
    if (!metadata.isFile()) {
      throw new Error(`Import path must be a regular file: ${path}`);
    }
    assertFileSize(metadata.size, maxFileBytes);
    return {
      path: canonicalPath,
      fileName: basename(canonicalPath),
      format: extension.slice(1) as "csv" | "xlsx",
      sizeBytes: metadata.size,
      handle,
      pendingReads: new Set(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function assertFileSize(size: number, maxFileBytes: number): void {
  if (size > maxFileBytes) {
    const detail =
      maxFileBytes === DEFAULT_INGEST_LIMITS.maxFileBytes ? "25 MiB byte limit" : "byte limit";
    throw new Error(`Import exceeds ${detail}`);
  }
}

async function* boundedFileBytes(
  handle: FileHandle,
  maxFileBytes: number,
): AsyncGenerator<Buffer> {
  let size = 0;
  for await (const chunk of createReadStream("", {
    fd: handle.fd,
    start: 0,
    autoClose: false,
  })) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    assertFileSize(size, maxFileBytes);
    yield buffer;
  }
}

async function parseCsv(
  file: ValidatedFile,
  limits: Required<IngestLimits>,
  consumeRow: () => void,
  consumeJsonl: (bytes: number) => void,
): Promise<ParsedDataset> {
  const accumulator = new DatasetAccumulator(
    {
      path: file.path,
      fileName: file.fileName,
      format: file.format,
      sizeBytes: file.sizeBytes,
    },
    limits,
    consumeRow,
    consumeJsonl,
  );
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const decoded = (async function* (): AsyncGenerator<string> {
    try {
      for await (const chunk of boundedFileBytes(file.handle, limits.maxFileBytes)) {
        yield decoder.decode(chunk, { stream: true });
      }
      const tail = decoder.decode();
      if (tail) {
        yield tail;
      }
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error(`CSV import is not valid UTF-8: ${file.fileName}`, {
          cause: error,
        });
      }
      throw error;
    }
  })();
  const input = Readable.from(decoded);
  const parser = parse({ bom: true, relax_column_count: true, skip_empty_lines: true });
  const completion = pipeline(input, parser);
  void completion.catch(() => undefined);

  try {
    let rowNumber = 0;
    for await (const record of parser as AsyncIterable<string[]>) {
      rowNumber += 1;
      if (rowNumber === 1) {
        accumulator.setHeaders(record);
      } else {
        accumulator.addRow(record, rowNumber);
      }
    }
    await completion;
  } finally {
    parser.destroy();
    input.destroy();
  }
  return accumulator.finish();
}

async function parseXlsx(
  file: ValidatedFile,
  limits: Required<IngestLimits>,
  consumeRow: () => void,
  consumeJsonl: (bytes: number) => void,
): Promise<ParsedDataset[]> {
  const archive = await unzipper.Open.custom({
    size: async () => {
      const { size } = await file.handle.stat();
      assertFileSize(size, limits.maxFileBytes);
      return size;
    },
    stream: (offset, length) => {
      const source = createReadStream("", {
        fd: file.handle.fd,
        start: offset,
        end: length ? offset + length : undefined,
        autoClose: false,
      });
      const completion = new Promise<void>((resolve) => {
        source.once("end", resolve);
        source.once("error", resolve);
      });
      file.pendingReads.add(completion);
      void completion.then(() => file.pendingReads.delete(completion));
      const output = new PassThrough();
      source.once("error", (error) => output.destroy(error));
      output.once("close", () => source.resume());
      source.pipe(output);
      return output;
    },
  });
  const entries = new Map(archive.files.map((entry) => [entry.path, entry]));
  const budget = new WorkbookInflationBudget();
  const requiredEntry = (path: string): unzipper.File => {
    const entry = entries.get(path);
    if (!entry) {
      throw new Error(`Invalid XLSX workbook: missing ${path}`);
    }
    return entry;
  };
  const engine = new ExcelJS.Workbook().xlsx as unknown as XlsxStreamingEngine;
  const model = await engine.parseWorkbook(
    budget.xml(requiredEntry("xl/workbook.xml"), "workbook"),
  );
  const relationships = await engine.parseRels(
    budget.xml(requiredEntry("xl/_rels/workbook.xml.rels"), "relationships"),
  );
  const workbook = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([]), {
    worksheets: "emit",
    sharedStrings: "cache",
    styles: "cache",
    hyperlinks: "ignore",
  }) as unknown as XlsxStreamingReader;
  workbook.model = model;
  workbook.properties = { model: model.properties };
  workbook.workbookRels = relationships;
  workbook.sharedStrings = entries.has("xl/sharedStrings.xml")
    ? (await engine.parseSharedStrings(
        budget.xml(requiredEntry("xl/sharedStrings.xml"), "sharedStrings"),
      )).values
    : [];
  if (entries.has("xl/styles.xml")) {
    await workbook._parseStyles(budget.xml(requiredEntry("xl/styles.xml"), "styles"));
  }

  const datasets: ParsedDataset[] = [];
  for (const sheet of model.sheets) {
    const relationship = relationships.find((item) => item.Id === sheet.rId);
    if (!relationship) {
      throw new Error(`Invalid XLSX workbook: missing relationship for ${sheet.name}`);
    }
    const target = relationship.Target.replace(/^\//, "");
    if (target.split("/").includes("..")) {
      throw new Error("Invalid XLSX workbook: worksheet path traversal");
    }
    const entryPath = target.startsWith("xl/") ? target : `xl/${target}`;
    const sheetNumber = /\/sheet(\d+)\.xml$/.exec(entryPath)?.[1] ?? String(sheet.id);
    for await (const { value: worksheet } of workbook._parseWorksheet(
      budget.xml(requiredEntry(entryPath), `worksheet ${sheet.name}`),
      sheetNumber,
    )) {
      worksheet.name = sheet.name;
      const accumulator = new DatasetAccumulator(
        {
          path: file.path,
          fileName: file.fileName,
          format: file.format,
          sizeBytes: file.sizeBytes,
          sheetName: sheet.name,
        },
        limits,
        consumeRow,
        consumeJsonl,
      );
      let rowNumber = 0;
      for await (const row of worksheet) {
        rowNumber += 1;
        const cells = Array.isArray(row.values) ? row.values.slice(1) : [];
        const values: JsonValue[] = [];
        for (let index = 0; index < cells.length; index += 1) {
          const normalized = normalizeCell(cells[index]);
          if (normalized.missingFormulaResult) {
            accumulator.issues.push({
              code: "MISSING_CACHED_FORMULA_RESULT",
              message: "Formula has no cached result; formula was not executed",
              rowNumber,
              columnNumber: index + 1,
            });
          }
          values.push(normalized.value);
        }
        if (rowNumber === 1) {
          accumulator.setHeaders(values);
        } else {
          accumulator.addRow(values, rowNumber);
        }
      }
      datasets.push(accumulator.finish());
    }
  }
  return datasets;
}

function validatedXml(
  input: Readable,
  label: string,
  onBytes: (bytes: number) => void,
): Readable {
  const parser = new SaxesParser();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let failure: Error | undefined;
  parser.on("error", (error) => {
    failure = new Error(`Invalid or truncated ${label} XML`, { cause: error });
  });
  const validate = (operation: () => void): Error | undefined => {
    if (failure) {
      return failure;
    }
    try {
      operation();
    } catch (error) {
      failure = error instanceof Error ? error : new Error(`Invalid ${label} XML`);
    }
    return failure;
  };
  const output = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const error = validate(() => {
        onBytes(chunk.length);
        parser.write(decoder.decode(chunk, { stream: true }));
      });
      callback(error, error ? undefined : chunk);
    },
    flush(callback) {
      const error = validate(() => {
        parser.write(decoder.decode());
        parser.close();
      });
      callback(error);
    },
  });
  input.once("error", (error) => output.destroy(error));
  output.once("error", () => input.destroy());
  return input.pipe(output);
}

function normalizeCell(value: unknown): {
  value: JsonValue;
  missingFormulaResult: boolean;
} {
  if (value === null || value === undefined) {
    return { value: null, missingFormulaResult: false };
  }
  if (value instanceof Date) {
    return { value: value.toISOString(), missingFormulaResult: false };
  }
  if (typeof value === "number") {
    return {
      value: Number.isFinite(value) ? value : null,
      missingFormulaResult: false,
    };
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return { value, missingFormulaResult: false };
  }
  if (typeof value === "object") {
    const cell = value as Record<string, unknown>;
    if ("formula" in cell || "sharedFormula" in cell) {
      if (!("result" in cell) || cell.result === undefined) {
        return { value: null, missingFormulaResult: true };
      }
      return normalizeCell(cell.result);
    }
    if (Array.isArray(cell.richText)) {
      const text = cell.richText
        .map((part) =>
          typeof part === "object" && part !== null && "text" in part
            ? String((part as { text: unknown }).text)
            : "",
        )
        .join("");
      return { value: text, missingFormulaResult: false };
    }
    if ("hyperlink" in cell && "text" in cell) {
      return { value: String(cell.text), missingFormulaResult: false };
    }
  }
  return { value: null, missingFormulaResult: false };
}
