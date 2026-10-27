import { statSync } from "node:fs";

export interface AppConfig {
  dataDir: string;
  artifactDir?: string;
  importRoot?: string;
  databaseRoot?: string;
  httpAllowlist?: string[];
  httpCredentialAllowlist?: string[];
  contentMcp?: {
    command: string;
    args: string[];
  };
  logLevel: "error" | "warn" | "info";
}

export function parseContentMcpArguments(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("MARKETING_CONTENT_MCP_ARGS must be a JSON string array", { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("MARKETING_CONTENT_MCP_ARGS must be a JSON string array");
  }
  return parsed;
}

export function parseCommaSeparatedList(value: string | undefined): string[] {
  return value ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const dataDir = env.MARKETING_DATA_DIR;

  if (!dataDir) {
    throw new Error("MARKETING_DATA_DIR is required");
  }

  let isDirectory: boolean;
  try {
    isDirectory = statSync(dataDir).isDirectory();
  } catch (error) {
    throw new Error("MARKETING_DATA_DIR must be an existing directory", {
      cause: error,
    });
  }

  if (!isDirectory) {
    throw new Error("MARKETING_DATA_DIR must be a directory");
  }

  const importRoot = env.MARKETING_IMPORT_ROOT;
  if (importRoot) {
    let importRootIsDirectory: boolean;
    try {
      importRootIsDirectory = statSync(importRoot).isDirectory();
    } catch (error) {
      throw new Error("MARKETING_IMPORT_ROOT must be an existing directory", {
        cause: error,
      });
    }
    if (!importRootIsDirectory) {
      throw new Error("MARKETING_IMPORT_ROOT must be a directory");
    }
  }

  const databaseRoot = env.MARKETING_DATABASE_ROOT;
  if (databaseRoot) {
    let databaseRootIsDirectory: boolean;
    try {
      databaseRootIsDirectory = statSync(databaseRoot).isDirectory();
    } catch (error) {
      throw new Error("MARKETING_DATABASE_ROOT must be an existing directory", {
        cause: error,
      });
    }
    if (!databaseRootIsDirectory) {
      throw new Error("MARKETING_DATABASE_ROOT must be a directory");
    }
  }

  const httpAllowlist = parseCommaSeparatedList(env.MARKETING_HTTP_ALLOWLIST);
  const httpCredentialAllowlist = parseCommaSeparatedList(env.MARKETING_HTTP_CREDENTIAL_ALLOWLIST);
  const contentMcpCommand = env.MARKETING_CONTENT_MCP_COMMAND;
  if (!contentMcpCommand && env.MARKETING_CONTENT_MCP_ARGS) {
    throw new Error("MARKETING_CONTENT_MCP_COMMAND is required when MCP arguments are configured");
  }
  return {
    dataDir,
    ...(env.MARKETING_ARTIFACT_DIR ? { artifactDir: env.MARKETING_ARTIFACT_DIR } : {}),
    ...(importRoot ? { importRoot } : {}),
    ...(databaseRoot ? { databaseRoot } : {}),
    ...(httpAllowlist.length > 0 ? { httpAllowlist } : {}),
    ...(httpCredentialAllowlist.length > 0 ? { httpCredentialAllowlist } : {}),
    ...(contentMcpCommand ? {
      contentMcp: {
        command: contentMcpCommand,
        args: parseContentMcpArguments(env.MARKETING_CONTENT_MCP_ARGS),
      },
    } : {}),
    logLevel: "info",
  };
}
