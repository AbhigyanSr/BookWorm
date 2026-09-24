import "dotenv/config";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 3000);
const cache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000;

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "Content-Type",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 100_000) throw new Error("Request is too large.");
  }
  return JSON.parse(body || "{}");
}

function cleanWord(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9'-]/g, "").slice(0, 80);
}

function cleanContext(value) {
  return String(value || "").trim().slice(0, 2000);
}

function cacheKey(word, context) {
  return createHash("sha256").update(`${word.toLowerCase()}\n${context}`).digest("hex");
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function getAuthoritativeLexicalData(word) {
  const encodedWord = encodeURIComponent(word);
  const [dictionaryResult, wiktionaryResult] = await Promise.allSettled([
    fetchJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodedWord}`),
    fetchJson(`https://en.wiktionary.org/api/rest_v1/page/summary/${encodedWord}`),
  ]);

  const sources = [];
  const dictionary = dictionaryResult.status === "fulfilled" ? dictionaryResult.value[0] : null;
  const wiktionary = wiktionaryResult.status === "fulfilled" ? wiktionaryResult.value : null;

  if (dictionary) {
    const meanings = dictionary.meanings || [];
    const definitions = meanings.flatMap((meaning) => meaning.definitions || []);
    const etymology = dictionary.origin || "";
    sources.push({ name: "Dictionary API", url: `https://api.dictionaryapi.dev/api/v2/entries/en/${encodedWord}` });
    return {
      pronunciation: dictionary.phonetic || dictionary.phonetics?.find((item) => item.text)?.text || "",
      partOfSpeech: meanings[0]?.partOfSpeech || "",
      definition: definitions[0]?.definition || "",
      etymology,
      historicalDevelopment: "",
      earliestKnownForm: "",
      relatedWords: definitions.flatMap((item) => item.synonyms || []).slice(0, 12),
      sources,
      wiktionary,
    };
  }

  if (wiktionary) {
    sources.push({ name: "Wiktionary", url: wiktionary.content_urls?.desktop?.page || `https://en.wiktionary.org/wiki/${encodedWord}` });
    return {
      pronunciation: "",
      partOfSpeech: "",
      definition: wiktionary.extract || "",
      etymology: "",
      historicalDevelopment: "",
      earliestKnownForm: "",
      relatedWords: [],
      sources,
      wiktionary,
    };
  }

  return {
    pronunciation: "",
    partOfSpeech: "",
    definition: "",
    etymology: "",
    historicalDevelopment: "",
    earliestKnownForm: "",
    relatedWords: [],
    sources,
    unavailable: true,
  };
}

async function synthesizeWithGemini(word, context, lexicalData) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const prompt = [
    "You are a lexical research assistant, not a generic chatbot.",
    "Use authoritative evidence first. Do not invent etymologies or historical forms.",
    "Clearly label unsupported or uncertain facts as unknown or uncertain.",
    "Return only valid JSON with exactly these keys: word, pronunciation, partOfSpeech, definition, etymology, historicalDevelopment, earliestKnownForm, relatedWords, contextualMeaning, contextualExplanation, sources, confidence.",
    `Selected word: ${word}`,
    `Surrounding context: ${context}`,
    `Authoritative lexical evidence: ${JSON.stringify(lexicalData)}`,
  ].join("\n\n");

  const requestBody = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json" },
  });

  let lastError;

  // Attempt the request up to 3 times
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await fetchJson(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: requestBody,
        },
      );

      const text = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!text) throw new Error("Gemini returned no synthesis.");

      const jsonText = text.match(/```json\s*([\s\S]*?)\s*```/)?.[1] || text;
      return JSON.parse(jsonText);
    } catch (error) {
      lastError = error;

      // If Google returns a 503, wait and retry
      if (error.message.includes("503") && attempt < 3) {
        console.warn(`Gemini 503 Overloaded (Attempt ${attempt}/3). Retrying in ${attempt * 1.5}s...`);
        // Exponential backoff: Wait 1.5s, then 3.0s
        await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
        continue;
      }

      // Break immediately on non-503 errors (like 400 or 403)
      break;
    }
  }

  throw new Error(lastError.message);
}

function buildResponse(word, lexicalData, synthesis) {
  const fallback = {
    word,
    pronunciation: lexicalData.pronunciation,
    partOfSpeech: lexicalData.partOfSpeech,
    definition: lexicalData.definition,
    etymology: lexicalData.etymology || "Unavailable from authoritative sources.",
    historicalDevelopment: lexicalData.historicalDevelopment || "Unavailable from authoritative sources.",
    earliestKnownForm: lexicalData.earliestKnownForm || "Unknown",
    relatedWords: lexicalData.relatedWords,
    contextualMeaning: "Contextual synthesis is unavailable until a server-side Gemini key is configured.",
    contextualExplanation: "The authoritative lookup is shown without AI interpretation.",
    sources: lexicalData.sources,
    confidence: lexicalData.unavailable ? "low: authoritative source unavailable" : "medium: authoritative lexical source, no AI synthesis",
  };
  return { ...fallback, ...(synthesis || {}), word, sources: synthesis?.sources?.length ? synthesis.sources : lexicalData.sources };
}

async function handleLexical(request, response) {
  try {
    const input = await readJson(request);
    const word = cleanWord(input.word);
    const context = cleanContext(input.context);
    if (!word || !context) return sendJson(response, 400, { error: "A word and surrounding context are required." });

    const key = cacheKey(word, context);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return sendJson(response, 200, { ...cached.value, cached: true });

    const lexicalData = await getAuthoritativeLexicalData(word);
    let synthesis = null;
    let synthesisError = "";
    try {
      synthesis = await synthesizeWithGemini(word, context, lexicalData);
    } catch (error) {
      synthesisError = "AI synthesis unavailable; authoritative data is shown.";
      console.warn("Gemini synthesis failed:", error.message);
    }

    const value = buildResponse(word, lexicalData, synthesis);
    if (synthesisError) value.synthesisError = synthesisError;
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return sendJson(response, 200, value);
  } catch (error) {
    console.error("Lexical request failed:", error);
    return sendJson(response, 500, { error: "Lexical lookup failed. Please try again." });
  }
}

async function serveStatic(request, response) {
  const requestedPath = request.url === "/" ? "/index.html" : request.url.split("?")[0];
  const filePath = normalize(join(rootDir, requestedPath));
  if (!filePath.startsWith(rootDir + sep)) return sendJson(response, 403, { error: "Forbidden" });
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Not a file");
    const content = await readFile(filePath);
    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".pdf": "application/pdf",
    };
    const contentType = contentTypes[extname(filePath)] || "application/octet-stream";
    response.writeHead(200, { "content-type": contentType });
    response.end(content);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

createServer((request, response) => {
  if (request.method === "OPTIONS" && request.url === "/api/lexical") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "Content-Type",
    });
    return response.end();
  }
  if (request.method === "POST" && request.url === "/api/lexical") return handleLexical(request, response);
  if (request.method === "GET") return serveStatic(request, response);
  sendJson(response, 405, { error: "Method not allowed" });
}).listen(port, () => {
  console.log(`Deep Lexicon listening on http://localhost:${port}`);
});
