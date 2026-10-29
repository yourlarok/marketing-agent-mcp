import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

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
  analyticsMcp?: {
    command: string;
    args: string[];
  };
  benchmarkMcp?: {
    command: string;
    args: string[];
  };
  mediaMcp?: {
    command: string;
    args: string[];
    envAllowlist: string[];
  };
  ffprobeCommand?: string;
  logLevel: "error" | "warn" | "info";
}

function parseMcpArguments(value: string | undefined, variable: string): string[] {
  if (!value) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${variable} must be a JSON string array`, { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error(`${variable} must be a JSON string array`);
  }
  return parsed;
}

export function parseContentMcpArguments(value: string | undefined): string[] {
  return parseMcpArguments(value, "MARKETING_CONTENT_MCP_ARGS");
}

export function parseAnalyticsMcpArguments(value: string | undefined): string[] {
  return parseMcpArguments(value, "MARKETING_ANALYTICS_MCP_ARGS");
}

export function parseBenchmarkMcpArguments(value: string | undefined): string[] {
  return parseMcpArguments(value, "MARKETING_BENCHMARK_MCP_ARGS");
}

export function parseMediaMcpArguments(value: string | undefined): string[] {
  return parseMcpArguments(value, "MARKETING_MEDIA_MCP_ARGS");
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
  const analyticsMcpCommand = env.MARKETING_ANALYTICS_MCP_COMMAND;
  if (!analyticsMcpCommand && env.MARKETING_ANALYTICS_MCP_ARGS) {
    throw new Error("MARKETING_ANALYTICS_MCP_COMMAND is required when MCP arguments are configured");
  }
  const benchmarkMcpCommand = env.MARKETING_BENCHMARK_MCP_COMMAND;
  if (!benchmarkMcpCommand && env.MARKETING_BENCHMARK_MCP_ARGS) {
    throw new Error("MARKETING_BENCHMARK_MCP_COMMAND is required when MCP arguments are configured");
  }
  if (benchmarkMcpCommand !== undefined && benchmarkMcpCommand.trim().length === 0) {
    throw new Error("MARKETING_BENCHMARK_MCP_COMMAND must not be empty");
  }
  const mediaMcpCommand = env.MARKETING_MEDIA_MCP_COMMAND;
  if (!mediaMcpCommand && (env.MARKETING_MEDIA_MCP_ARGS || env.MARKETING_MEDIA_MCP_ENV_ALLOWLIST)) {
    throw new Error("MARKETING_MEDIA_MCP_COMMAND is required when media MCP settings are configured");
  }
  if (mediaMcpCommand !== undefined && mediaMcpCommand.trim().length === 0) {
    throw new Error("MARKETING_MEDIA_MCP_COMMAND must not be empty");
  }
  const mediaEnvAllowlist = parseCommaSeparatedList(env.MARKETING_MEDIA_MCP_ENV_ALLOWLIST);
  if (mediaEnvAllowlist.some((name) => !/^[A-Z_][A-Z0-9_]*$/i.test(name))) {
    throw new Error("MARKETING_MEDIA_MCP_ENV_ALLOWLIST must contain environment variable names only");
  }
  const ffprobeCommand = env.MARKETING_FFPROBE_COMMAND;
  if (ffprobeCommand !== undefined && !isAbsolute(ffprobeCommand)) {
    throw new Error("MARKETING_FFPROBE_COMMAND must be an absolute executable path");
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
    ...(analyticsMcpCommand ? {
      analyticsMcp: {
        command: analyticsMcpCommand,
        args: parseAnalyticsMcpArguments(env.MARKETING_ANALYTICS_MCP_ARGS),
      },
    } : {}),
    ...(benchmarkMcpCommand ? {
      benchmarkMcp: {
        command: benchmarkMcpCommand,
        args: parseBenchmarkMcpArguments(env.MARKETING_BENCHMARK_MCP_ARGS),
      },
    } : {}),
    ...(mediaMcpCommand ? {
      mediaMcp: {
        command: mediaMcpCommand,
        args: parseMediaMcpArguments(env.MARKETING_MEDIA_MCP_ARGS),
        envAllowlist: mediaEnvAllowlist,
      },
    } : {}),
    ...(ffprobeCommand ? { ffprobeCommand } : {}),
    logLevel: "info",
  };
}
