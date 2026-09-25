import "dotenv/config";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile, unlink } from "node:fs/promises";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 3000);
const cache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000;
const PDF_FILE_PATH = join(rootDir, "active_document.pdf");
const METADATA_PATH = join(rootDir, "active_document.json");
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

async function getValidPdf() {
  try {
    const metaRaw = await readFile(METADATA_PATH, "utf-8");
    const meta = JSON.parse(metaRaw);

    // Check if 24 hours have passed
    if (Date.now() - meta.uploadedAt > TWENTY_FOUR_HOURS_MS) {
      await clearActivePdf();
      return null;
    }

    const pdfBuffer = await readFile(PDF_FILE_PATH);
    return { buffer: pdfBuffer, fileName: meta.fileName };
  } catch {
    return null; // File doesn't exist or is invalid
  }
}

// Helper to clear stored PDF
async function clearActivePdf() {
  try {
    await unlink(PDF_FILE_PATH);
  } catch {}
  try {
    await unlink(METADATA_PATH);
  } catch {}
}

// Handler: POST /api/pdf/upload
async function handlePdfUpload(request, response) {
  try {
    const chunks = [];
    let totalSize = 0;

    for await (const chunk of request) {
      chunks.push(chunk);
      totalSize += chunk.length;
      if (totalSize > 25_000_000) {
        // Limit to 25MB
        return sendJson(response, 413, {
          error: "PDF exceeds 25MB size limit.",
        });
      }
    }

    const bodyBuffer = Buffer.concat(chunks);
    const fileName = request.headers["x-file-name"] || "uploaded_document.pdf";

    // Overwrite the single active PDF and save upload timestamp
    await writeFile(PDF_FILE_PATH, bodyBuffer);
    await writeFile(
      METADATA_PATH,
      JSON.stringify({ fileName, uploadedAt: Date.now() }),
    );

    return sendJson(response, 200, {
      message: "PDF uploaded successfully. Expires in 24 hours.",
    });
  } catch (error) {
    console.error("PDF upload error:", error);
    return sendJson(response, 500, { error: "Failed to store PDF." });
  }
}

// Handler: GET /api/pdf/current
async function handlePdfRetrieve(request, response) {
  const activePdf = await getValidPdf();

  if (!activePdf) {
    return sendJson(response, 404, {
      error: "No active PDF found or the 24-hour retention window has expired.",
    });
  }

  response.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="${activePdf.fileName}"`,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(activePdf.buffer);
}

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
async function handleGenre(request, response) {
  try {
    const input = await readJson(request);
    const sample = String(input.text || "").slice(0, 1500);
    if (!sample)
      return sendJson(response, 200, {
        theme: "dark-classic",
        label: "Classic Dark",
      });

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey)
      return sendJson(response, 200, {
        theme: "dark-classic",
        label: "Classic Dark",
      });

    const prompt = [
      "Analyze the following excerpt from a book and determine its literary genre and aesthetic mood.",
      "Select the single best visual theme key from this list:",
      '- "scifi" (Science Fiction, Tech, Cyberpunk, Quantum, Space)',
      '- "fantasy" (Fantasy, Magic, Medieval, Adventure, Lore)',
      '- "romance" (Romance, Relationships, Drama, Passion)',
      '- "academic" (Non-Fiction, Textbooks, Science, Research, Philosophy)',
      '- "sepia" (Classics, Historical Fiction, Vintage, Old Literature)',
      '- "midnight" (Thriller, Horror, Mystery, Crime, Dark Suspense)',
      '- "dark-classic" (General Fiction, Modern Standard)',
      "",
      'Return ONLY a valid JSON object in this exact format: {"theme": "<theme_key>", "label": "<Emoji + Short Genre Name>"}',
      `Excerpt: "${sample}"`,
    ].join("\n");

    const result = await fetchJson(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "openrouter/free",
          messages: [{ role: "user", content: prompt }],
        }),
      },
    );

    const text = result.choices?.[0]?.message?.content?.trim() || "";
    const jsonText = text.match(/```json\s*([\s\S]*?)\s*```/)?.[1] || text;
    const parsed = JSON.parse(jsonText);

    return sendJson(response, 200, {
      theme: parsed.theme || "dark-classic",
      label: parsed.label || "Auto-detected Theme",
    });
  } catch (error) {
    console.warn("AI genre detection failed:", error.message);
    return sendJson(response, 200, {
      theme: "dark-classic",
      label: "Classic Dark",
    });
  }
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
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9'-]/g, "")
    .slice(0, 80);
}

function cleanContext(value) {
  return String(value || "")
    .trim()
    .slice(0, 2000);
}

function cacheKey(word, context) {
  return createHash("sha256")
    .update(`${word.toLowerCase()}\n${context}`)
    .digest("hex");
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`${response.status}${response.statusText}`);
  return response.json();
}

async function getAuthoritativeLexicalData(word) {
  const encodedWord = encodeURIComponent(word);
  const [dictionaryResult, wiktionaryResult] = await Promise.allSettled([
    fetchJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodedWord}`),
    fetchJson(
      `https://en.wiktionary.org/api/rest_v1/page/summary/${encodedWord}`,
    ),
  ]);

  const sources = [];
  const dictionary =
    dictionaryResult.status === "fulfilled" ? dictionaryResult.value[0] : null;
  const wiktionary =
    wiktionaryResult.status === "fulfilled" ? wiktionaryResult.value : null;

  if (dictionary) {
    const meanings = dictionary.meanings || [];
    const definitions = meanings.flatMap(
      (meaning) => meaning.definitions || [],
    );
    const etymology = dictionary.origin || "";
    sources.push({
      name: "Dictionary API",
      url: `https://api.dictionaryapi.dev/api/v2/entries/en/${encodedWord}`,
    });
    return {
      pronunciation:
        dictionary.phonetic ||
        dictionary.phonetics?.find((item) => item.text)?.text ||
        "",
      partOfSpeech: meanings[0]?.partOfSpeech || "",
      definition: definitions[0]?.definition || "",
      etymology,
      historicalDevelopment: "",
      earliestKnownForm: "",
      relatedWords: definitions
        .flatMap((item) => item.synonyms || [])
        .slice(0, 12),
      sources,
      wiktionary,
    };
  }

  if (wiktionary) {
    sources.push({
      name: "Wiktionary",
      url:
        wiktionary.content_urls?.desktop?.page ||
        `https://en.wiktionary.org/wiki/${encodedWord}`,
    });
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
  // We look for an OpenRouter key instead of Gemini
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey)
    throw new Error(
      "OPENROUTER_API_KEY is missing from environment variables.",
    );

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
    model: "openrouter/free",
    messages: [{ role: "user", content: prompt }],
  });

  try {
    const result = await fetchJson(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: requestBody,
      },
    );

    const text = result.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("AI returned no synthesis.");

    // Fallback JSON parser in case the AI wraps it in markdown blocks
    const jsonText = text.match(/```json\s*([\s\S]*?)\s*```/)?.[1] || text;
    return JSON.parse(jsonText);
  } catch (error) {
    console.warn("AI synthesis failed:", error.message);
    throw error;
  }
}

function buildResponse(word, lexicalData, synthesis) {
  const fallback = {
    word,
    pronunciation: lexicalData.pronunciation,
    partOfSpeech: lexicalData.partOfSpeech,
    definition: lexicalData.definition,
    etymology:
      lexicalData.etymology || "Unavailable from authoritative sources.",
    historicalDevelopment:
      lexicalData.historicalDevelopment ||
      "Unavailable from authoritative sources.",
    earliestKnownForm: lexicalData.earliestKnownForm || "Unknown",
    relatedWords: lexicalData.relatedWords,
    contextualMeaning:
      "Contextual synthesis is unavailable until a valid server-side OpenRouter API key is configured.",
    contextualExplanation:
      "The authoritative lookup is shown without AI interpretation.",
    sources: lexicalData.sources,
    confidence: lexicalData.unavailable
      ? "low: authoritative source unavailable"
      : "medium: authoritative lexical source, no AI synthesis",
  };
  return {
    ...fallback,
    ...(synthesis || {}),
    word,
    sources: synthesis?.sources?.length
      ? synthesis.sources
      : lexicalData.sources,
  };
}

async function handleLexical(request, response) {
  try {
    const input = await readJson(request);
    const word = cleanWord(input.word);
    const context = cleanContext(input.context);
    if (!word || !context)
      return sendJson(response, 400, {
        error: "A word and surrounding context are required.",
      });

    const key = cacheKey(word, context);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now())
      return sendJson(response, 200, { ...cached.value, cached: true });

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
    return sendJson(response, 500, {
      error: "Lexical lookup failed. Please try again.",
    });
  }
}

async function serveStatic(request, response) {
  const requestedPath =
    request.url === "/" ? "/index.html" : request.url.split("?")[0];
  const filePath = normalize(join(rootDir, requestedPath));
  if (!filePath.startsWith(rootDir + sep))
    return sendJson(response, 403, { error: "Forbidden" });
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
    const contentType =
      contentTypes[extname(filePath)] || "application/octet-stream";
    response.writeHead(200, { "content-type": contentType });
    response.end(content);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

createServer((request, response) => {
  const url = request.url?.split("?")[0] || "/";
  if (
    request.method === "OPTIONS" &&
    ["/api/lexical", "/api/genre", "/api/pdf/upload", "/api/pdf/current"].includes(url)
  ) {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Content-Type, X-File-Name",
    });
    return response.end();
  }
  if (request.method === "POST" && url === "/api/pdf/upload") return handlePdfUpload(request, response);
  if (request.method === "GET" && url === "/api/pdf/current") return handlePdfRetrieve(request, response);
  if (request.method === "POST" && url === "/api/lexical") return handleLexical(request, response);
  if (request.method === "POST" && url === "/api/genre") return handleGenre(request, response);
  if (request.method === "GET") return serveStatic(request, response); 
  sendJson(response, 405, { error: "Method not allowed" });
}).listen(port, () => {
  console.log(`Deep Lexicon listening on http://localhost:${port}`);
});
