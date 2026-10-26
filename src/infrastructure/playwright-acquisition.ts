import { lookup as dnsLookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { parseCommaSeparatedList } from "../config.js";
import { DomainError } from "../domain/errors.js";
import { isBlockedAddress } from "./safe-http.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

export interface AcquireRequest {
  url: string;
  fields?: Record<string, string>;
}

export interface AcquiredPage {
  url: string;
  finalUrl: string;
  title: string;
  text: string;
  fields: Record<string, string>;
  screenshot: Buffer;
  provider: "mcp" | "playwright";
  toolVersion: string;
}

export interface AcquisitionProvider {
  acquire(request: AcquireRequest): Promise<AcquiredPage>;
}

export interface PlaywrightAcquisitionOptions {
  allowlist?: string[];
  browser?: Browser;
  env?: NodeJS.ProcessEnv;
  lookup?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
  captureScreenshot?: (page: Page) => Promise<Uint8Array>;
}

export function validateAcquireRequest(request: AcquireRequest): void {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new DomainError("INVALID_INPUT", "Acquisition request must be an object");
  }
  const keys = Object.keys(request);
  if (keys.some((key) => key !== "url" && key !== "fields")) {
    throw new DomainError("INVALID_INPUT", "Acquisition accepts only url and CSS fields");
  }
  if (typeof request.url !== "string" || request.url.trim().length === 0) {
    throw new DomainError("INVALID_INPUT", "Acquisition URL must not be empty");
  }
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new DomainError("INVALID_INPUT", "Acquisition URL is invalid");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new DomainError("INVALID_INPUT", "Acquisition URL must be HTTP or HTTPS without userinfo");
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

function normalizedHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
}

function unavailable(reason: string, message: string): DomainError {
  return new DomainError("CAPABILITY_UNAVAILABLE", message, false, { reason });
}

export class PlaywrightAcquisitionProvider implements AcquisitionProvider {
  private readonly allowlist: Set<string>;
  private readonly lookup: (hostname: string) => Promise<string[]>;
  private readonly timeoutMs: number;
  private readonly captureScreenshot: (page: Page) => Promise<Uint8Array>;

  constructor(private readonly options: PlaywrightAcquisitionOptions = {}) {
    this.allowlist = new Set(
      (options.allowlist ?? parseCommaSeparatedList(options.env?.MARKETING_HTTP_ALLOWLIST ?? process.env.MARKETING_HTTP_ALLOWLIST))
        .map(normalizedHostname),
    );
    this.lookup = options.lookup ?? (async (hostname) => {
      const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
      return addresses.map((entry) => entry.address);
    });
    this.timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    this.captureScreenshot = options.captureScreenshot ?? ((page) => page.screenshot({ type: "png" }));
  }

  async acquire(request: AcquireRequest): Promise<AcquiredPage> {
    validateAcquireRequest(request);
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new DomainError("INVALID_INPUT", "Acquisition timeout must be positive");
    }
    await this.validateDestination(request.url);
    const ownedBrowser = !this.options.browser;
    const browser = this.options.browser ?? await chromium.launch({ headless: true });
    let context;
    try {
      context = await browser.newContext({ acceptDownloads: false });
      const page = await context.newPage();
      page.setDefaultTimeout(this.timeoutMs);
      let downloadDenied = false;
      page.on("download", (download) => {
        downloadDenied = true;
        void download.cancel().catch(() => undefined);
      });
      await page.route("**/*", async (route) => {
        try {
          await this.validateDestination(route.request().url());
          await route.continue();
        } catch {
          await route.abort("blockedbyclient");
        }
      });
      for (const selector of Object.values(request.fields ?? {})) {
        try {
          await page.locator(`css=${selector}`).count();
        } catch {
          throw new DomainError("INVALID_INPUT", "Acquisition fields must contain valid CSS selectors");
        }
      }
      let response;
      try {
        response = await page.goto(request.url, { waitUntil: "networkidle", timeout: this.timeoutMs });
      } catch (error) {
        if (downloadDenied) {
          throw unavailable("download_denied", "Content acquisition downloads are disabled");
        }
        throw error;
      }
      const status = response?.status() ?? 0;
      if ([401, 403, 429].includes(status)) {
        throw unavailable(`http_${status}`, `Content acquisition requires access unavailable to this tool (HTTP ${status})`);
      }
      if (status < 200 || status >= 400) {
        throw unavailable("http_error", `Content acquisition failed with HTTP ${status || "unknown"}`);
      }
      const text = (await page.locator("css=body").innerText()).trim();
      if (/(?:\bcaptcha\b|\bplease\s+(?:log|sign)\s*in\b|\blog\s*in\s+to\s+continue\b)/i.test(text)) {
        throw unavailable("access_gate", "Content acquisition is blocked by a login or CAPTCHA gate");
      }
      const fields: Record<string, string> = {};
      for (const [name, selector] of Object.entries(request.fields ?? {})) {
        fields[name] = await page.locator(`css=${selector}`).first().innerText();
      }
      if (downloadDenied) {
        throw unavailable("download_denied", "Content acquisition downloads are disabled");
      }
      let screenshot: Buffer;
      try {
        screenshot = Buffer.from(await this.captureScreenshot(page));
      } catch {
        throw unavailable("screenshot_failed", "Content acquisition screenshot failed");
      }
      if (downloadDenied) {
        throw unavailable("download_denied", "Content acquisition downloads are disabled");
      }
      if (screenshot.length === 0 || screenshot.length > MAX_SCREENSHOT_BYTES ||
        !screenshot.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        throw unavailable("screenshot_failed", "Content acquisition screenshot is invalid");
      }
      return {
        url: request.url,
        finalUrl: page.url(),
        title: await page.title(),
        text,
        fields,
        screenshot,
        provider: "playwright",
        toolVersion: browser.version(),
      };
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      if (!browser.isConnected() || /(?:target|browser|context).*(?:closed|crash)|browser.*disconnect/i.test(String(error))) {
        throw unavailable("browser_unavailable", "Content acquisition browser is unavailable");
      }
      throw unavailable("acquisition_failed", "Content acquisition through Chromium failed");
    } finally {
      await context?.close().catch(() => undefined);
      if (ownedBrowser) {
        await browser.close().catch(() => undefined);
      }
    }
  }

  private async validateDestination(raw: string): Promise<void> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw unavailable("destination_denied", "Content acquisition destination is invalid");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw unavailable("destination_denied", "Content acquisition destination must use HTTP or HTTPS");
    }
    if (url.username || url.password) {
      throw unavailable("destination_denied", "Content acquisition destination userinfo is not allowed");
    }
    const hostname = normalizedHostname(url.hostname);
    let addresses: string[];
    try {
      addresses = isIPv4(hostname) || isIPv6(hostname) ? [hostname] : await this.lookup(hostname);
    } catch {
      throw unavailable("destination_denied", "Content acquisition destination could not be resolved");
    }
    if (addresses.length === 0 || addresses.some((address) => isBlockedAddress(address))) {
      if (!this.allowlist.has(hostname)) {
        throw unavailable("destination_denied", "Content acquisition destination is not allowed");
      }
    }
  }
}
