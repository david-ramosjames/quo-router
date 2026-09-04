// Shared plumbing for the prompt tests. Both suites pull the real functions
// out of server.js and run them, so what they measure is what ships — this
// module just assembles the pieces they need in common.

import fs from "node:fs";

export const SRC = fs.readFileSync(new URL("./server.js", import.meta.url), "utf8");

// Lift a top-level function (or `const NAME = ...` line) verbatim out of the source.
export function grab(name, src = SRC) {
  const re = new RegExp(`^(?:const ${name} = [^\\n]+|(?:async )?function ${name}\\([\\s\\S]*?\\n\\})`, "m");
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${name} from server.js`);
  return m[0];
}

// The real provider layer, wired to whichever key is in the environment, so a
// suite exercises the same request path production uses.
export function llmPrelude() {
  return [
    `const OPENAI_API_KEY = process.env.OPENAI_API_KEY;`,
    `const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;`,
    `const LLM_PROVIDER = OPENAI_API_KEY ? "openai" : ANTHROPIC_API_KEY ? "anthropic" : null;`,
    `const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";`,
    `const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";`,
    // Retry/backoff isn't under test; go straight to fetch.
    `const fetchWithRetry = (url, opts) => fetch(url, opts);`,
    grab("llmConfigured"),
    SRC.match(/^let openaiTokenParam = .+$/m)[0],
    grab("callOpenAI"),
    grab("callAnthropic"),
    grab("llmText"),
    grab("llmExtract"),
  ].join("\n\n");
}

export function requireKey() {
  if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) return;
  console.error("Set OPENAI_API_KEY (or ANTHROPIC_API_KEY) — this test calls the real model. Aborting.");
  process.exit(2);
}

export function activeProvider() {
  return process.env.OPENAI_API_KEY
    ? `OpenAI (${process.env.OPENAI_MODEL || "gpt-4o-mini"})`
    : `Anthropic (${process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001"})`;
}
