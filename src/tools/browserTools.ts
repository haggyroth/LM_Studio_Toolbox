import { tool, type Tool } from "@lmstudio/sdk";
import { z } from "zod";
import { stat } from "fs/promises";
import type { ToolContext } from "./context";
import { validatePath, createSafeToolImplementation } from "./helpers";
import { executeBrowserActions } from "../browserActions";
import { rankFuzzyMatches } from "../fuzzySearch";
import { savePersistedState } from "../stateManager";

export const browserActionSchema = z.object({
  type: z.enum(["wait_for_selector", "wait", "click", "type", "press", "select", "hover", "scroll", "evaluate"]),
  selector: z.string().optional().describe("CSS selector used by selector-based actions."),
  text: z.string().optional().describe("Text payload for type action."),
  value: z.string().optional().describe("Value payload for select action."),
  key: z.string().optional().describe("Keyboard key for press action (e.g., Enter, Tab)."),
  milliseconds: z.number().int().min(0).max(30000).optional().describe("Delay in milliseconds for wait action."),
  x: z.number().optional().describe("Horizontal scroll delta for scroll action."),
  y: z.number().optional().describe("Vertical scroll delta for scroll action."),
  script: z.string().optional().describe("JavaScript snippet for evaluate action (executed in page context)."),
});

/** Extract interactive elements from a page and fuzzy-rank them against a query. */
async function pageFuzzyFind(page: any, fuzzy_find: string, max_results: number) {
  const candidates = await page.evaluate(() => {
    const dedup = new Map<string, { text: string; selector: string }>();
    const nodes = document.querySelectorAll("a,button,input,textarea,select,[role='button'],[aria-label],h1,h2,h3,h4,h5,h6,p,span");
    const clean = (v: string) => v.replace(/\s+/g, " ").trim();
    const classSelector = (el: Element) => {
      const classes = Array.from(el.classList).slice(0, 2).map(c => c.replace(/[^a-zA-Z0-9_-]/g, ""));
      return classes.length > 0 ? `.${classes.join(".")}` : "";
    };
    const buildSelector = (el: Element) => {
      if ((el as HTMLElement).id) return `#${(el as HTMLElement).id}`;
      const name = el.getAttribute("name");
      if (name) return `${el.tagName.toLowerCase()}[name="${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
      return `${el.tagName.toLowerCase()}${classSelector(el)}`;
    };
    for (const node of nodes) {
      const element = node as HTMLElement;
      const text = clean(element.innerText || (element as HTMLInputElement).value || element.getAttribute("aria-label") || "");
      if (!text) continue;
      const selector = buildSelector(element);
      const key = `${text}||${selector}`;
      if (!dedup.has(key)) dedup.set(key, { text: text.substring(0, 200), selector });
      if (dedup.size >= 400) break;
    }
    return Array.from(dedup.values());
  });

  return candidates
    .map((c: any) => ({
      ...c,
      score: Math.max(
        rankFuzzyMatches(fuzzy_find, [c.text], 1)[0]?.score ?? 0,
        rankFuzzyMatches(fuzzy_find, [c.selector], 1)[0]?.score ?? 0,
      ),
    }))
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, max_results)
    .map(({ text, selector, score }: any) => ({ text, selector, score }));
}

export function createBrowserTools(ctx: ToolContext): Tool[] {
  const tools: Tool[] = [];

  tools.push(tool({
    name: "browser_session_open",
    description: "Open a persistent browser session (single active page), navigate to URL, and return page text for context.",
    parameters: {
      url: z.string(),
      wait_for_selector: z.string().optional().describe("Optional selector to wait for after navigation."),
      include_page_text: z.boolean().optional().describe("If true (default), returns full page text content after opening."),
    },
    implementation: createSafeToolImplementation(async ({ url, wait_for_selector, include_page_text = true }) => {
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        return { error: "URL must start with http:// or https:// (file:// and other schemes are not allowed)." };
      }
      try {
        if (ctx.browserSession) {
          await ctx.browserSession.browser.close().catch(() => {});
          ctx.browserSession = null;
        }
        const puppeteer = await import("puppeteer");
        const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
        if (wait_for_selector) await page.waitForSelector(wait_for_selector, { timeout: 15000 });

        ctx.browserSession = { browser, page, currentUrl: page.url() };

        const pageText = include_page_text ? await page.evaluate(() => (document.body as HTMLElement).innerText || "") : undefined;
        return {
          success: true, session_active: true, url: page.url(),
          title: await page.title(), text_content: pageText,
          text_length: pageText ? pageText.length : 0, message: "Browser session opened.",
        };
      } catch (error) {
        return { error: `Failed to open browser session: ${error instanceof Error ? error.message : String(error)}` };
      }
    }, ctx.allowBrowserControl, "browser_control"),
  }));

  tools.push(tool({
    name: "browser_session_control",
    description: "Control the active persistent browser session. Supports actions, page reading, screenshot capture, and fuzzy finding in-page text/selectors.",
    parameters: {
      actions: z.array(browserActionSchema).optional(),
      read_page: z.boolean().optional(),
      full_read: z.boolean().optional().describe("If true, forces full page text output even when URL has not changed."),
      screenshot_path: z.string().optional(),
      full_page_screenshot: z.boolean().optional(),
      fuzzy_find: z.string().optional(),
      max_results: z.number().int().min(1).max(20).optional(),
    },
    implementation: createSafeToolImplementation(async ({ actions, read_page = true, full_read = false, screenshot_path, full_page_screenshot, fuzzy_find, max_results = 5 }) => {
      if (!ctx.browserSession) return { error: "No active browser session. Call 'browser_session_open' first." };
      try {
        const beforeUrl = ctx.browserSession.page.url();
        const actionLog = await executeBrowserActions(ctx.browserSession.page, actions || []);
        const afterUrl = ctx.browserSession.page.url();
        const urlChanged = beforeUrl !== afterUrl;
        ctx.browserSession.currentUrl = afterUrl;

        let screenshotSaved = false;
        if (screenshot_path) {
          const screenshotFilePath = validatePath(ctx.cwd, screenshot_path, ctx.protectedPaths);
          await ctx.browserSession.page.screenshot({ path: screenshotFilePath, fullPage: full_page_screenshot ?? false });
          screenshotSaved = true;
        }

        let pageSnapshot: any = undefined;
        if (read_page) {
          const title = await ctx.browserSession.page.title();
          if (urlChanged || full_read) {
            const textContent = await ctx.browserSession.page.evaluate(() => (document.body as HTMLElement).innerText || "");
            pageSnapshot = { url: afterUrl, title, text_content: textContent, text_length: textContent.length };
          } else {
            pageSnapshot = { url: afterUrl, title, note: "Full page text omitted (URL unchanged). Set full_read=true to force full output." };
          }
        }

        const fuzzyResults = (fuzzy_find?.trim())
          ? await pageFuzzyFind(ctx.browserSession.page, fuzzy_find, max_results)
          : [];

        return {
          success: true, session_active: true, actions_executed: actionLog,
          screenshot_saved: screenshotSaved, url_changed: urlChanged,
          url_change_notice: urlChanged ? `Url changed to -> [${afterUrl}]` : undefined,
          page: pageSnapshot, fuzzy_find_results: fuzzyResults,
        };
      } catch (error) {
        return { error: `Browser session control failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    }, ctx.allowBrowserControl, "browser_control"),
  }));

  tools.push(tool({
    name: "browser_session_close",
    description: "Close the active persistent browser session.",
    parameters: {},
    implementation: createSafeToolImplementation(async () => {
      if (!ctx.browserSession) return { success: true, session_active: false, message: "No active browser session." };
      try {
        // M.3: persist last URL before closing so it can be surfaced on session resume
        const lastUrl = ctx.browserSession.currentUrl || ctx.browserSession.page.url();
        if (lastUrl && lastUrl !== "about:blank") {
          ctx.fullState.lastBrowserUrl = lastUrl;
          savePersistedState(ctx.fullState).catch(() => {}); // fire-and-forget
        }
        await ctx.browserSession.browser.close();
        ctx.browserSession = null;
        return { success: true, session_active: false, message: "Browser session closed." };
      } catch (error) {
        return { error: `Failed to close browser session: ${error instanceof Error ? error.message : String(error)}` };
      }
    }, ctx.allowBrowserControl, "browser_control"),
  }));

  tools.push(tool({
    name: "browser_open_page",
    description: "Open a webpage in a headless browser (Puppeteer), render it once, and return content. One-shot only; do not use for multi-step navigation.",
    parameters: {
      url: z.string(),
      screenshot_path: z.string().optional().describe("Path to save a screenshot (e.g., 'screenshot.png')."),
      wait_for_selector: z.string().optional().describe("CSS selector to wait for before returning."),
      full_page_screenshot: z.boolean().optional().describe("If true, captures the full page when taking a screenshot."),
      actions: z.array(browserActionSchema).optional().describe("Optional scripted browser steps to run after navigation."),
    },
    implementation: createSafeToolImplementation(async ({ url, screenshot_path, wait_for_selector, full_page_screenshot, actions }) => {
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        return { error: "URL must start with http:// or https:// (file:// and other schemes are not allowed)." };
      }
      let browser: any;
      try {
        const puppeteer = await import("puppeteer");
        browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
        const page = await browser.newPage();
        try {
          await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
          if (wait_for_selector) await page.waitForSelector(wait_for_selector, { timeout: 10000 });

          const beforeActionUrl = page.url();
          const action_log = await executeBrowserActions(page, actions || []);
          const currentUrl = page.url();
          const urlChanged = currentUrl !== beforeActionUrl;

          const title = await page.title();
          const textContent = await page.evaluate(() => (document.body as HTMLElement).innerText || "");

          let screenshot_saved = false;
          if (screenshot_path) {
            const screenshotFilePath = validatePath(ctx.cwd, screenshot_path, ctx.protectedPaths);
            await page.screenshot({ path: screenshotFilePath, fullPage: full_page_screenshot ?? false });
            screenshot_saved = true;
          }

          return {
            url: currentUrl, title,
            text_content: textContent.substring(0, 5000),
            screenshot_saved, actions_executed: action_log, url_changed: urlChanged,
            url_change_notice: urlChanged ? `Url changed to -> [${currentUrl}]` : undefined,
          };
        } finally {
          await browser.close();
        }
      } catch (error) {
        if (browser) await browser.close().catch(() => {});
        return { error: `Browser operation failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    }, ctx.allowBrowserControl, "browser_control"),
  }));

  // ── N.10: capture_screenshot ──────────────────────────────────────────────

  tools.push(tool({
    name: "capture_screenshot",
    description: "Open a URL in a headless browser, take a screenshot, save it to the workspace, and return the file path. One-shot visual check — no persistent session required. Useful for visual regression checks, UI previews, and 'what does this page look like?' queries.",
    parameters: {
      url: z.string().describe("URL to screenshot (must start with http:// or https://)."),
      output_path: z.string().optional().describe("Workspace-relative path to save the PNG (default: screenshot_<timestamp>.png)."),
      full_page: z.boolean().optional().default(false).describe("If true, captures the full scrollable page height instead of just the viewport (default: false)."),
      width: z.number().int().min(320).max(3840).optional().default(1280).describe("Viewport width in pixels (default: 1280)."),
      height: z.number().int().min(240).max(2160).optional().default(800).describe("Viewport height in pixels (default: 800)."),
      wait_for_selector: z.string().optional().describe("CSS selector to wait for before capturing (useful for SPAs that render asynchronously)."),
      delay_ms: z.number().int().min(0).max(10000).optional().describe("Extra milliseconds to wait after navigation before capturing (0–10000)."),
    },
    implementation: createSafeToolImplementation(async ({ url, output_path, full_page = false, width = 1280, height = 800, wait_for_selector, delay_ms }) => {
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        return { error: "URL must start with http:// or https:// (file:// and other schemes are not allowed)." };
      }
      const savePath = output_path ?? `screenshot_${Date.now()}.png`;
      const filePath = validatePath(ctx.cwd, savePath, ctx.protectedPaths);

      let browser: any;
      try {
        const puppeteer = await import("puppeteer");
        browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
        const page = await browser.newPage();
        await page.setViewport({ width, height });
        await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
        if (wait_for_selector) await page.waitForSelector(wait_for_selector, { timeout: 10000 });
        if (delay_ms && delay_ms > 0) await new Promise(r => setTimeout(r, delay_ms));
        await page.screenshot({ path: filePath, fullPage: full_page });
        const { size } = await stat(filePath);
        return {
          success: true,
          path: savePath,
          url: page.url(),
          title: await page.title(),
          full_page,
          viewport: { width, height },
          file_size_bytes: size,
          message: `Screenshot saved to ${savePath}`,
        };
      } catch (error) {
        return { error: `capture_screenshot failed: ${error instanceof Error ? error.message : String(error)}` };
      } finally {
        if (browser) await browser.close().catch(() => {});
      }
    }, ctx.allowBrowserControl, "browser_control"),
  }));

  return tools;
}
