import { config } from "./config.js";

export const geminiEnabled = (): boolean => !!config.gemini.apiKey;

/** Hand a file (audio, video, PDF, image) to Gemini with a prompt and get text back. */
export async function geminiAnalyze(mime: string, data: Buffer, prompt: string): Promise<string> {
  if (!geminiEnabled()) throw new Error("GEMINI_API_KEY is not set");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.gemini.model)}:generateContent`;
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ inline_data: { mime_type: mime, data: data.toString("base64") } }, { text: prompt }] }],
  });
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000 * attempt));
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": config.gemini.apiKey },
      body,
      signal: AbortSignal.timeout(240_000),
    });
    const text = await res.text();
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`Gemini HTTP ${res.status}`);
      continue;
    }
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg;
      } catch {
        /* raw */
      }
      throw new Error(`Gemini HTTP ${res.status}: ${msg}`);
    }
    const j = JSON.parse(text) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; promptFeedback?: { blockReason?: string } };
    const out = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
    if (!out) throw new Error(j.promptFeedback?.blockReason ? `Gemini blocked it (${j.promptFeedback.blockReason})` : "Gemini returned nothing");
    return out;
  }
  throw lastErr ?? new Error("Gemini failed");
}
