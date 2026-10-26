import { statSync } from "node:fs";

export interface AppConfig {
  dataDir: string;
  importRoot?: string;
  logLevel: "error" | "warn" | "info";
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

  return { dataDir, ...(importRoot ? { importRoot } : {}), logLevel: "info" };
}
