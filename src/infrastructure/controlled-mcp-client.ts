import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DomainError } from "../domain/errors.js";

const CLEANUP_GRACE_MS = 100;
const CLEANUP_KILL_TIMEOUT_MS = 1_000;

export interface ControlledMcpClientOptions {
  clientName: string;
  capability: string;
  configurationAction: string;
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  envAllowlist?: string[];
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface ControlledMcpResponse<T> {
  result: T;
  toolVersion: string;
}

class BoundedStdioClientTransport extends StdioClientTransport {
  private readonly exited: Promise<void>;
  private exitedResolve!: () => void;
  private processObserved = false;
  private childPid: number | undefined;
  private hasExited = false;

  constructor(parameters: ConstructorParameters<typeof StdioClientTransport>[0]) {
    super(parameters);
    this.exited = new Promise((resolve) => {
      this.exitedResolve = resolve;
    });
    this.onclose = () => {
      this.hasExited = true;
      this.exitedResolve();
    };
  }

  override async start(): Promise<void> {
    const starting = super.start();
    this.childPid = this.pid ?? undefined;
    this.processObserved = this.childPid !== undefined;
    await starting;
  }

  get needsCleanup(): boolean {
    return this.processObserved && !this.hasExited;
  }

  async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.hasExited) return true;
    return settlesWithin(this.exited, timeoutMs);
  }

  terminate(signal: NodeJS.Signals): void {
    if (this.childPid === undefined || this.hasExited) return;
    try {
      process.kill(this.childPid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class ControlledMcpClient {
  constructor(private readonly options: ControlledMcpClientOptions) {
    if (options.command !== undefined && options.command.trim().length === 0) {
      throw new DomainError("INVALID_INPUT", `${options.clientName} MCP command must not be empty`);
    }
  }

  private gap(reason: string, message: string, retryable = false): DomainError {
    return new DomainError("CAPABILITY_UNAVAILABLE", message, retryable, {
      capability: this.options.capability,
      reason,
      configurationAction: this.options.configurationAction,
    });
  }

  async call<T>(
    tool: string,
    input: Record<string, unknown>,
    parse: (structuredContent: unknown) => T,
  ): Promise<ControlledMcpResponse<T>> {
    if (!this.options.command) {
      throw this.gap("mcp_not_configured", `${this.options.clientName} MCP is not configured`);
    }
    const client = new Client({ name: this.options.clientName, version: "1.0.0" });
    const environment = getDefaultEnvironment();
    const sourceEnvironment = this.options.env ?? process.env;
    for (const name of new Set(this.options.envAllowlist ?? [])) {
      const value = sourceEnvironment[name];
      if (/^[A-Z_][A-Z0-9_]*$/i.test(name) && typeof value === "string") environment[name] = value;
    }
    let rawResponseTooLarge = false;
    const transport = new BoundedStdioClientTransport({
      command: this.options.command,
      args: this.options.args ?? [],
      env: environment,
      stderr: "ignore",
      maxBufferSize: this.options.maxResponseBytes,
    });
    transport.onerror = (error) => {
      if (error.message.includes("ReadBuffer exceeded maximum size")) rawResponseTooLarge = true;
    };
    const abort = new AbortController();
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        abort.abort();
        reject(this.gap("mcp_timeout", `${this.options.clientName} MCP timed out`, true));
      }, this.options.timeoutMs);
    });
    try {
      await Promise.race([client.connect(transport), deadline]);
      const response = await Promise.race([
        client.callTool({ name: tool, arguments: input }, undefined, {
          timeout: this.options.timeoutMs,
          signal: abort.signal,
        }),
        deadline,
      ]);
      if (response.isError) throw this.gap("mcp_unavailable", `${this.options.clientName} MCP ${tool} failed`);
      return {
        result: parse(response.structuredContent),
        toolVersion: client.getServerVersion()?.version ?? "unknown",
      };
    } catch (error) {
      if (rawResponseTooLarge) {
        throw this.gap("mcp_response_too_large", `${this.options.clientName} MCP raw response exceeds the byte limit`);
      }
      if (error instanceof DomainError && error.code === "CAPABILITY_UNAVAILABLE") throw error;
      if (timedOut || abort.signal.aborted) {
        throw this.gap("mcp_timeout", `${this.options.clientName} MCP timed out`, true);
      }
      throw this.gap("mcp_unavailable", `${this.options.clientName} MCP is unavailable`, true);
    } finally {
      if (timer) clearTimeout(timer);
      await this.close(client, transport);
    }
  }

  private async close(client: Client, transport: BoundedStdioClientTransport): Promise<void> {
    if (!transport.needsCleanup) return;
    let closeFailure: unknown;
    const closing = client.close().catch((error: unknown) => {
      closeFailure = error;
    });
    if (!(await transport.waitForExit(CLEANUP_GRACE_MS))) {
      transport.terminate("SIGTERM");
      if (!(await transport.waitForExit(CLEANUP_GRACE_MS))) {
        transport.terminate("SIGKILL");
        if (!(await transport.waitForExit(CLEANUP_KILL_TIMEOUT_MS))) {
          throw this.gap("mcp_cleanup_failed", `${this.options.clientName} MCP process did not exit after SIGKILL`);
        }
      }
    }
    if (!(await settlesWithin(closing, CLEANUP_KILL_TIMEOUT_MS)) || closeFailure !== undefined) {
      throw this.gap("mcp_cleanup_failed", `${this.options.clientName} MCP cleanup failed`);
    }
  }
}
