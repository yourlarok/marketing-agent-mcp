import { chromium, type Browser, type Page } from "playwright";
import { parseCommaSeparatedList } from "../config.js";
import { DomainError } from "../domain/errors.js";
import {
  acquisitionPayloadBytes,
  assertAcquisitionPayloadBudget,
  assertAcquisitionUrlInScope,
  canonicalAcquisitionUrl,
  raceWithAcquisitionAbort,
  throwIfAcquisitionAborted,
  acquisitionDeadlineError,
  type AcquisitionScope,
} from "./acquisition-policy.js";
import { DestinationPinningProxy, DestinationValidator } from "./destination-proxy.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

export interface AcquireRequest {
  url: string;
  fields?: Record<string, string>;
  scope?: AcquisitionScope;
  maxBytes?: number;
  timeoutMs?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
}

export interface AcquiredPage {
  url: string;
  finalUrl: string;
  title: string;
  text: string;
  fields: Record<string, string>;
  links?: string[];
  screenshot: Buffer;
  provider: "mcp" | "playwright";
  toolVersion: string;
}

export interface AcquisitionProvider {
  acquire(request: AcquireRequest): Promise<AcquiredPage>;
}

export interface PlaywrightAcquisitionOptions {
  allowlist?: string[];
  env?: NodeJS.ProcessEnv;
  lookup?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
  ignoreHTTPSErrors?: boolean;
  captureScreenshot?: (page: Page) => Promise<Uint8Array>;
  launchBrowser?: (proxyUrl: string) => Promise<Browser>;
}

export function validateAcquireRequest(request: AcquireRequest): void {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new DomainError("INVALID_INPUT", "Acquisition request must be an object");
  }
  const supported = new Set(["url", "fields", "scope", "maxBytes", "timeoutMs", "deadlineMs", "signal"]);
  if (Object.keys(request).some((key) => !supported.has(key))) {
    throw new DomainError("INVALID_INPUT", "Acquisition request contains unsupported fields");
  }
  canonicalAcquisitionUrl(request.url);
  assertAcquisitionUrlInScope(request.url, request.scope);
  if (request.maxBytes !== undefined && (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 0)) {
    throw new DomainError("INVALID_INPUT", "Acquisition maxBytes must be a non-negative integer");
  }
  for (const value of [request.timeoutMs, request.deadlineMs]) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new DomainError("INVALID_INPUT", "Acquisition time budgets must be positive finite numbers");
    }
  }
  if (request.fields === undefined) {
    return;
  }
  if (request.fields === null || typeof request.fields !== "object" || Array.isArray(request.fields)) {
    throw new DomainError("INVALID_INPUT", "Acquisition fields must be a CSS-selector map");
  }
  const entries = Object.entries(request.fields);
  if (entries.length > 50) {
    throw new DomainError("INVALID_INPUT", "Acquisition supports at most 50 CSS fields");
  }
  for (const [name, selector] of entries) {
    if (!name.trim() || typeof selector !== "string" || !selector.trim() || selector.length > 1_000) {
      throw new DomainError("INVALID_INPUT", "Acquisition CSS field names and selectors must not be empty");
    }
    if (selector.includes(">>") || /[\u0000-\u001f]/.test(selector)) {
      throw new DomainError("INVALID_INPUT", "Acquisition fields must use CSS selectors without selector engines");
    }
  }
}

export function remainingAcquisitionTimeout(request: AcquireRequest): number {
  throwIfAcquisitionAborted(request.signal);
  const configured = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const remaining = request.deadlineMs === undefined ? configured : Math.min(configured, request.deadlineMs - Date.now());
  if (remaining <= 0) {
    throw acquisitionDeadlineError();
  }
  return remaining;
}

function unavailable(reason: string, message: string): DomainError {
  return new DomainError("CAPABILITY_UNAVAILABLE", message, false, { reason });
}

export class PlaywrightAcquisitionProvider implements AcquisitionProvider {
  private readonly validator: DestinationValidator;
  private readonly timeoutMs: number;
  private readonly captureScreenshot: (page: Page) => Promise<Uint8Array>;

  constructor(private readonly options: PlaywrightAcquisitionOptions = {}) {
    this.validator = new DestinationValidator({
      allowlist: options.allowlist ?? parseCommaSeparatedList(options.env?.MARKETING_HTTP_ALLOWLIST ?? process.env.MARKETING_HTTP_ALLOWLIST),
      ...(options.lookup ? { lookup: options.lookup } : {}),
    });
    this.timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    this.captureScreenshot = options.captureScreenshot ?? ((page) => page.screenshot({ type: "png" }));
  }

  async acquire(request: AcquireRequest): Promise<AcquiredPage> {
    validateAcquireRequest(request);
    const timeoutMs = Math.min(this.timeoutMs, remainingAcquisitionTimeout(request));
    return raceWithAcquisitionAbort(this.perform(request, timeoutMs), request.signal);
  }

  private async perform(request: AcquireRequest, timeoutMs: number): Promise<AcquiredPage> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new DomainError("INVALID_INPUT", "Acquisition timeout must be positive");
    }
    const proxy = await DestinationPinningProxy.start(this.validator, timeoutMs, request.scope);
    let browser: Browser | undefined;
    let context;
    const candidatePayload: { text: string; fields: Record<string, string>; screenshot: Uint8Array } = {
      text: "", fields: {}, screenshot: Buffer.alloc(0),
    };
    try {
      const launch = this.options.launchBrowser ?? ((proxyUrl: string) => chromium.launch({
        headless: true,
        proxy: { server: proxyUrl, bypass: "<-loopback>" },
      }));
      browser = await launch(proxy.url);
      context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: "block",
        ignoreHTTPSErrors: this.options.ignoreHTTPSErrors ?? false,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);
      let downloadDenied = false;
      let mainScopeDenied = false;
      page.on("download", (download) => {
        downloadDenied = true;
        void download.cancel().catch(() => undefined);
      });
      if (request.scope) {
        await page.route("**/*", (route) => {
          try {
            assertAcquisitionUrlInScope(route.request().url(), request.scope);
            return route.continue();
          } catch {
            if (route.request().isNavigationRequest() && route.request().frame() === page.mainFrame()) {
              mainScopeDenied = true;
            }
            return route.abort("blockedbyclient");
          }
        });
      }
      for (const selector of Object.values(request.fields ?? {})) {
        try {
          await page.locator(`css=${selector}`).count();
        } catch {
          throw new DomainError("INVALID_INPUT", "Acquisition fields must contain valid CSS selectors");
        }
      }
      let response;
      try {
        response = await page.goto(request.url, { waitUntil: "networkidle", timeout: timeoutMs });
      } catch (error) {
        if (mainScopeDenied) {
          throw unavailable("scope_denied", "Acquisition navigation is outside the research scope");
        }
        if (downloadDenied) {
          throw unavailable("download_denied", "Content acquisition downloads are disabled");
        }
        throw error;
      }
      throwIfAcquisitionAborted(request.signal);
      if (mainScopeDenied) {
        throw unavailable("scope_denied", "Acquisition navigation is outside the research scope");
      }
      assertAcquisitionUrlInScope(page.url(), request.scope);
      const status = response?.status() ?? 0;
      if ([401, 403, 429].includes(status)) {
        throw unavailable(`http_${status}`, `Content acquisition requires access unavailable to this tool (HTTP ${status})`);
      }
      if (status < 200 || status >= 400) {
        throw unavailable("http_error", `Content acquisition failed with HTTP ${status || "unknown"}`);
      }
      const text = (await page.locator("css=body").innerText()).trim();
      candidatePayload.text = text;
      assertAcquisitionPayloadBudget({ text, fields: {}, screenshot: Buffer.alloc(0) }, request.maxBytes);
      if (/(?:\bcaptcha\b|\bplease\s+(?:log|sign)\s*in\b|\blog\s*in\s+to\s+continue\b)/i.test(text)) {
        throw unavailable("access_gate", "Content acquisition is blocked by a login or CAPTCHA gate");
      }
      const fields: Record<string, string> = {};
      candidatePayload.fields = fields;
      for (const [name, selector] of Object.entries(request.fields ?? {})) {
        fields[name] = await page.locator(`css=${selector}`).first().innerText();
        assertAcquisitionPayloadBudget({ text, fields, screenshot: Buffer.alloc(0) }, request.maxBytes);
      }
      if (downloadDenied) {
        throw unavailable("download_denied", "Content acquisition downloads are disabled");
      }
      const links = await page.locator("css=a[href]").evaluateAll((anchors) =>
        anchors.slice(0, 1_000).map((anchor) => anchor.getAttribute("href")!)
      );
      let screenshot: Buffer;
      try {
        screenshot = Buffer.from(await this.captureScreenshot(page));
      } catch {
        throw unavailable("screenshot_failed", "Content acquisition screenshot failed");
      }
      candidatePayload.screenshot = screenshot;
      assertAcquisitionPayloadBudget({ text, fields, screenshot }, request.maxBytes);
      if (downloadDenied) {
        throw unavailable("download_denied", "Content acquisition downloads are disabled");
      }
      if (screenshot.length === 0 || screenshot.length > MAX_SCREENSHOT_BYTES ||
        !screenshot.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        throw unavailable("screenshot_failed", "Content acquisition screenshot is invalid");
      }
      const title = await page.title();
      throwIfAcquisitionAborted(request.signal);
      return {
        url: request.url,
        finalUrl: page.url(),
        title,
        text,
        fields,
        links,
        screenshot,
        provider: "playwright",
        toolVersion: browser.version(),
      };
    } catch (error) {
      const payloadBytes = acquisitionPayloadBytes(candidatePayload);
      const details = {
        ...(error instanceof DomainError ? error.details : {}),
        ...(payloadBytes > 0 ? { payloadBytes } : {}),
      };
      if (error instanceof DomainError) {
        throw new DomainError(error.code, error.message, error.retryable, details);
      }
      const reason = browser && (!browser.isConnected() || /(?:target|browser|context).*(?:closed|crash)|browser.*disconnect/i.test(String(error)))
        ? "browser_unavailable"
        : "acquisition_failed";
      throw new DomainError("CAPABILITY_UNAVAILABLE", "Content acquisition through Chromium failed", false, {
        ...details,
        reason,
      });
    } finally {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      await proxy.close();
    }
  }
}
