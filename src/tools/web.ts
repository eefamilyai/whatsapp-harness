import { config } from "../config.js";
import { log } from "../log.js";
import { clip, num, str, type Tool } from "./types.js";

const UA = "Mozilla/5.0 (compatible; WhatsAppAssistant/0.1; +personal)";

interface Hit {
  title: string;
  url: string;
  snippet: string;
}

async function searxng(query: string, n: number): Promise<{ hits: Hit[]; answers: string[] }> {
  const u = new URL(`${config.searxngUrl}/search`);
  u.searchParams.set("q", query);
  u.searchParams.set("format", "json");
  const res = await fetch(u, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const j = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
    answers?: (string | { answer?: string })[];
  };
  const hits = (j.results ?? [])
    .filter((r) => r.url && r.title)
    .slice(0, n)
    .map((r) => ({ title: r.title!, url: r.url!, snippet: (r.content ?? "").trim() }));
  const answers = (j.answers ?? []).map((a) => (typeof a === "string" ? a : (a.answer ?? ""))).filter(Boolean);
  return { hits, answers };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

async function duckduckgo(query: string, n: number): Promise<Hit[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const html = await res.text();
  const hits: Hit[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  for (let m = re.exec(html); m && hits.length < n; m = re.exec(html)) {
    let url = decodeEntities(m[1]!);
    const redirect = /[?&]uddg=([^&]+)/.exec(url);
    if (redirect) url = decodeURIComponent(redirect[1]!);
    if (url.startsWith("//")) url = `https:${url}`;
    hits.push({
      title: decodeEntities(m[2]!.replace(/<[^>]+>/g, "")).trim(),
      url,
      snippet: decodeEntities((m[3] ?? "").replace(/<[^>]+>/g, "")).trim(),
    });
  }
  return hits;
}

export const webSearch: Tool = {
  name: "web_search",
  description:
    "Search the web. Returns titles, URLs and snippets. Use for current events, facts you are unsure of, prices, weather, places, anything recent. Follow up with web_fetch to read a result in full.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      max_results: { type: "integer", description: "1-10, default 6" },
    },
    required: ["query"],
  },
  async run(args) {
    const query = str(args.query);
    if (!query) throw new Error("query is required");
    const n = Math.min(10, Math.max(1, Math.round(num(args.max_results) ?? 6)));
    let hits: Hit[] = [];
    let answers: string[] = [];
    let source = "";
    if (config.searxngUrl) {
      try {
        ({ hits, answers } = await searxng(query, n));
        source = "searxng";
      } catch (err) {
        log.warn(`searxng failed: ${(err as Error).message}`);
      }
    }
    if (!hits.length) {
      hits = await duckduckgo(query, n);
      source = "duckduckgo";
    }
    if (!hits.length && !answers.length) return `No results for "${query}".`;
    const lines = [...answers.map((a) => `Answer: ${a}`)];
    hits.forEach((h, i) => lines.push(`${i + 1}. ${h.title}\n   ${h.url}\n   ${clip(h.snippet, 320)}`));
    log.debug(`web_search via ${source}`);
    return lines.join("\n");
  },
};

function htmlToText(html: string): string {
  let h = html;
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(h)?.[1];
  h = h
    .replace(/<(script|style|noscript|svg|template|iframe|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br|ul|ol|table|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  h = decodeEntities(h)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return title ? `${decodeEntities(title).trim()}\n\n${h}` : h;
}

export const webFetch: Tool = {
  name: "web_fetch",
  description: "Download a web page (or JSON/text URL) and return its readable text.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string" },
      max_chars: { type: "integer", description: "Max characters to return, default 8000, max 20000" },
    },
    required: ["url"],
  },
  async run(args) {
    const url = str(args.url);
    if (!url || !/^https?:\/\//i.test(url)) throw new Error("url must start with http:// or https://");
    const max = Math.min(20_000, Math.max(500, Math.round(num(args.max_chars) ?? 8000)));
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,application/json,text/plain,*/*" }, redirect: "follow", signal: AbortSignal.timeout(25_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    const type = res.headers.get("content-type") ?? "";
    if (/^(image|audio|video)\//.test(type) || /pdf|zip|octet-stream/.test(type)) {
      return `Not readable as text (content-type ${type}).`;
    }
    const raw = (await res.text()).slice(0, 2_000_000);
    const text = /html/.test(type) || /^\s*<(!doctype|html)/i.test(raw) ? htmlToText(raw) : raw;
    return clip(text, max);
  },
};
