import { createReadStream, symlinkSync, unlinkSync } from "node:fs";
import { copyFile, mkdir, readFile, realpath, symlink, truncate, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});
import { loadConfig } from "../../src/config.js";
import {
  DEFAULT_INGEST_LIMITS,
  ingestFiles,
  type IngestLimits,
} from "../../src/infrastructure/file-ingestor.js";
import { createTempDir, removeTempDir } from "../helpers.js";

const csvFixture = resolve("tests/fixtures/csv/marketing.csv");
const invalidUtf8Fixture = resolve("tests/fixtures/csv/invalid-utf8.csv");
const xlsxFixture = resolve("tests/fixtures/xlsx/marketing.xlsx");
const encryptedFixture = resolve("tests/fixtures/xlsx/encrypted.xlsx");

function jsonl(rows: string): Record<string, unknown>[] {
  return rows.trim() ? rows.trimEnd().split("\n").map((row) => JSON.parse(row)) : [];
}

describe("bounded CSV/XLSX ingestion", () => {
  let root: string;
  let outside: string;
  let originalRoot: string | undefined;

  beforeEach(async () => {
    root = await createTempDir();
    outside = await createTempDir();
    originalRoot = process.env.MARKETING_IMPORT_ROOT;
    process.env.MARKETING_IMPORT_ROOT = root;
    await Promise.all([
      copyFile(csvFixture, join(root, "marketing.csv")),
      copyFile(invalidUtf8Fixture, join(root, "invalid-utf8.csv")),
      copyFile(xlsxFixture, join(root, "marketing.xlsx")),
      copyFile(encryptedFixture, join(root, "encrypted.xlsx")),
    ]);
  });

  afterEach(async () => {
    vi.mocked(createReadStream).mockReset();
    if (originalRoot === undefined) {
      delete process.env.MARKETING_IMPORT_ROOT;
    } else {
      process.env.MARKETING_IMPORT_ROOT = originalRoot;
    }
    await Promise.all([removeTempDir(root), removeTempDir(outside)]);
  });

  function ingest(paths: string[], limits: IngestLimits = {}) {
    return ingestFiles(paths, limits);
  }

  async function ingestionError(paths: string[]): Promise<unknown> {
    try {
      await ingest(paths);
      return undefined;
    } catch (error) {
      return error;
    }
  }

  it("loads an optional import root without requiring it for non-import tools", () => {
    expect(
      loadConfig({ MARKETING_DATA_DIR: root, MARKETING_IMPORT_ROOT: root }),
    ).toEqual({ dataDir: root, importRoot: root, logLevel: "info" });
    expect(loadConfig({ MARKETING_DATA_DIR: root })).toEqual({
      dataDir: root,
      logLevel: "info",
    });
  });

  it("parses BOM and quoted delimiters while repairing duplicate and empty headers", async () => {
    const batch = await ingest(["marketing.csv"]);

    expect(batch.datasets).toHaveLength(1);
    const dataset = batch.datasets[0]!;
    expect(dataset.source).toMatchObject({
      path: await realpath(join(root, "marketing.csv")),
      fileName: "marketing.csv",
      format: "csv",
    });
    expect(dataset.fields.map((field) => field.name)).toEqual([
      "name",
      "name_2",
      "column_3",
      "notes",
    ]);
    expect(jsonl(dataset.rowsJsonl)).toEqual([
      {
        name: "Acme, Inc",
        name_2: "A",
        column_3: "",
        notes: 'said "hello"',
      },
      { name: "Beta", name_2: "B", column_3: "2", notes: "plain" },
    ]);
    expect(dataset.quality).toMatchObject({ rowCount: 2, duplicateRowCount: 0 });
    expect(dataset.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "DUPLICATE_HEADER",
        "EMPTY_HEADER",
        "INCONSISTENT_COLUMNS",
      ]),
    );
  });

  it("streams every real XLSX sheet using cached formula results without executing formulas", async () => {
    const batch = await ingest(["marketing.xlsx"]);

    expect(batch.datasets.map((dataset) => dataset.source.sheetName)).toEqual([
      "Leads",
      "Spend",
    ]);
    const [leads, spend] = batch.datasets;
    const leadRows = jsonl(leads!.rowsJsonl);
    expect(leadRows[0]).toEqual({
      name: "Alice",
      value: 10,
      when: "2026-01-01T00:00:00.000Z",
      calculation: 2,
    });
    expect(leadRows[2]).toMatchObject({ value: "10", calculation: 3 });
    expect(JSON.stringify(leadRows)).not.toContain("1+1");
    expect(leads!.quality).toMatchObject({
      rowCount: 3,
      duplicateRowCount: 1,
      typeInconsistencyCount: 1,
    });
    expect(leads!.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["DUPLICATE_ROW", "TYPE_INCONSISTENCY"]),
    );
    expect(jsonl(spend!.rowsJsonl)).toEqual([{ channel: "Search", amount: 25 }]);
  });

  it("parses multiple files into independent datasets", async () => {
    const batch = await ingest(["marketing.csv", "marketing.xlsx"]);

    expect(batch.datasets).toHaveLength(3);
    expect(batch.datasets.map((dataset) => dataset.source.fileName)).toEqual([
      "marketing.csv",
      "marketing.xlsx",
      "marketing.xlsx",
    ]);
  });

  it("requires MARKETING_IMPORT_ROOT", async () => {
    delete process.env.MARKETING_IMPORT_ROOT;

    await expect(ingest(["marketing.csv"])).rejects.toThrow(
      "MARKETING_IMPORT_ROOT",
    );
  });

  it("rejects traversal, absolute paths outside the root, and unsupported extensions", async () => {
    await writeFile(join(outside, "secret.csv"), "name\nsecret\n");
    await writeFile(join(root, "notes.txt"), "not tabular");

    await expect(ingest([join(outside, "secret.csv")])).rejects.toThrow(
      "outside MARKETING_IMPORT_ROOT",
    );
    await expect(ingest(["../secret.csv"])).rejects.toThrow(
      "outside MARKETING_IMPORT_ROOT",
    );
    await expect(ingest(["notes.txt"])).rejects.toThrow(".csv or .xlsx");
  });

  it("rejects a symlink that escapes the canonical import root", async () => {
    await writeFile(join(outside, "secret.csv"), "name\nsecret\n");
    await symlink(join(outside, "secret.csv"), join(root, "escape.csv"));

    await expect(ingest(["escape.csv"])).rejects.toThrow(
      "outside MARKETING_IMPORT_ROOT",
    );
  });

  it("rejects a symlink whose canonical target has a disallowed extension", async () => {
    await writeFile(join(root, "data.txt"), "name\nvalue\n");
    await symlink(join(root, "data.txt"), join(root, "alias.csv"));

    await expect(ingest(["alias.csv"])).rejects.toThrow(".csv or .xlsx");
  });

  it("rejects truncated worksheet XML even when the ZIP directory is intact", async () => {
    const truncated = await readFile("tests/fixtures/xlsx/truncated-sheet.xlsx");
    await writeFile(join(root, "truncated-sheet.xlsx"), truncated);

    await expect(ingest(["truncated-sheet.xlsx"])).rejects.toThrow();
  });

  it("rejects non-regular files", async () => {
    await mkdir(join(root, "directory.csv"));

    await expect(ingest(["directory.csv"])).rejects.toThrow("regular file");
  });

  it("rejects invalid UTF-8 instead of replacing bytes", async () => {
    await expect(ingest(["invalid-utf8.csv"])).rejects.toThrow("UTF-8");
  });

  it("rejects encrypted or otherwise unsupported OLE workbooks", async () => {
    await expect(ingest(["encrypted.xlsx"])).rejects.toThrow();
  });

  it("rejects truncated workbooks and unterminated CSV records without partial datasets", async () => {
    const workbook = await readFile(xlsxFixture);
    await writeFile(join(root, "truncated.xlsx"), workbook.subarray(0, 100));
    await writeFile(join(root, "truncated.csv"), 'name,notes\nAlice,"unfinished');

    await expect(ingest(["truncated.xlsx"])).rejects.toThrow();
    await expect(ingest(["truncated.csv"])).rejects.toThrow();
  });

  it("enforces the 100-file batch ceiling before parsing", async () => {
    const paths = Array.from({ length: 101 }, (_, index) => `${index}.csv`);

    await expect(ingest(paths)).rejects.toThrow("100 files");
  });

  it("enforces the 25MiB byte ceiling before reading an oversized file", async () => {
    await writeFile(join(root, "large.csv"), "name\n");
    await truncate(join(root, "large.csv"), DEFAULT_INGEST_LIMITS.maxFileBytes + 1);

    await expect(ingest(["large.csv"])).rejects.toThrow("25 MiB");
  });

  it("terminates instead of returning rows after a caller's lower byte limit", async () => {
    await expect(ingest(["marketing.csv"], { maxFileBytes: 10 })).rejects.toThrow(
      "byte limit",
    );
  });

  it("enforces 100000 rows and terminates at a lower row limit", async () => {
    await writeFile(join(root, "rows.csv"), `name\n${"x\n".repeat(100001)}`);

    await expect(ingest(["rows.csv"])).rejects.toThrow("100000 rows");
    await expect(ingest(["marketing.xlsx"], { maxRows: 2 })).rejects.toThrow(
      "row limit",
    );
  });

  it("enforces 500 columns across headers and data", async () => {
    const headers = Array.from({ length: 501 }, (_, index) => `c${index}`).join(",");
    await writeFile(join(root, "columns.csv"), `${headers}\n`);

    await expect(ingest(["columns.csv"])).rejects.toThrow("500 columns");
  });

  it("allocates globally unique repaired headers without overwriting data", async () => {
    await writeFile(
      join(root, "headers.csv"),
      "a,a_2,a,,column_4,,column_6\n1,2,3,4,5,6,7\n",
    );

    const batch = await ingest(["headers.csv"]);
    const dataset = batch.datasets[0]!;
    expect(dataset.fields.map((field) => field.name)).toEqual([
      "a",
      "a_2",
      "a_3",
      "column_4",
      "column_4_2",
      "column_6",
      "column_6_2",
    ]);
    expect(jsonl(dataset.rowsJsonl)).toEqual([
      {
        a: "1",
        a_2: "2",
        a_3: "3",
        column_4: "4",
        column_4_2: "5",
        column_6: "6",
        column_6_2: "7",
      },
    ]);
  });

  it("counts actual inflated bytes and rejects a ZIP entry above 64 MiB", async () => {
    await copyFile(
      resolve("tests/fixtures/xlsx/expanded-shared-strings.xlsx"),
      join(root, "expanded-shared-strings.xlsx"),
    );

    expect(await ingestionError(["expanded-shared-strings.xlsx"])).toMatchObject({
      message: expect.stringContaining("64 MiB uncompressed ZIP entry"),
    });
  }, 30_000);

  it("rejects a workbook above 128 MiB cumulative inflated bytes", async () => {
    await copyFile(
      resolve("tests/fixtures/xlsx/expanded-workbook.xlsx"),
      join(root, "expanded-workbook.xlsx"),
    );

    expect(await ingestionError(["expanded-workbook.xlsx"])).toMatchObject({
      message: expect.stringContaining("128 MiB uncompressed workbook"),
    });
  }, 30_000);

  it.each([
    "truncated-workbook.xlsx",
    "truncated-rels.xlsx",
    "truncated-shared-strings.xlsx",
    "truncated-styles.xlsx",
  ])("rejects non-worksheet XML without a root close: %s", async (fileName) => {
    await copyFile(resolve(`tests/fixtures/xlsx/${fileName}`), join(root, fileName));

    expect(await ingestionError([fileName])).toBeInstanceOf(Error);
  });

  it("rejects normalized dataset JSONL above 25 MiB", async () => {
    const header = "h".repeat(1024);
    await writeFile(join(root, "jsonl.csv"), `${header}\n${"x\n".repeat(27000)}`);

    expect(await ingestionError(["jsonl.csv"])).toMatchObject({
      message: expect.stringContaining("25 MiB normalized JSONL"),
    });
  }, 30_000);

  it("rejects normalized batch JSONL above 100 MiB before the row ceiling", async () => {
    const header = "h".repeat(1100);
    const contents = `${header}\n${"x\n".repeat(20000)}`;
    const paths = Array.from({ length: 5 }, (_, index) => `jsonl-${index}.csv`);
    for (const path of paths) {
      await writeFile(join(root, path), contents);
    }

    expect(await ingestionError(paths)).toMatchObject({
      message: expect.stringContaining("100 MiB normalized JSONL"),
    });
  }, 30_000);

  it("does not read a symlink swapped in at the path-reopen boundary", async () => {
    const path = join(root, "race.csv");
    const replacement = join(outside, "replacement.csv");
    await writeFile(path, "name\nsafe\n");
    await writeFile(replacement, "name\nreplaced\n");
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(createReadStream).mockImplementationOnce(((
      requestedPath: string,
      options?: { fd?: number },
    ) => {
      if (typeof options?.fd === "number") {
        return actualFs.createReadStream(requestedPath, options);
      }
      unlinkSync(requestedPath);
      symlinkSync(replacement, requestedPath);
      return actualFs.createReadStream(requestedPath);
    }) as typeof createReadStream);

    const batch = await ingest(["race.csv"]);

    expect(jsonl(batch.datasets[0]!.rowsJsonl)).toEqual([{ name: "safe" }]);
  });
});
