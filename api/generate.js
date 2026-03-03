import pdf from "pdf-parse";

const RATE_LIMIT_WINDOW = 60_000;
const MAX_REQUESTS = 5;
const ipStore = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  if (!ipStore.has(ip)) ipStore.set(ip, []);
  const timestamps = ipStore.get(ip).filter(t => now - t < RATE_LIMIT_WINDOW);
  timestamps.push(now);
  ipStore.set(ip, timestamps);
  return timestamps.length <= MAX_REQUESTS;
}

async function extractTextFromFileBase64(fileBase64, mimeType) {
  const buffer = Buffer.from(fileBase64, "base64");
  if (mimeType === "application/pdf") {
    const data = await pdf(buffer);
    return data.text || "";
  }
  return buffer.toString("utf8");
}

async function callOpenAI({ key, messages, maxTokens }) {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`
    },
    body: JSON.stringify({
      model: "gpt-3.5-turbo",
      messages,
      temperature: 0.1,
      max_tokens: maxTokens
    })
  });

  const j = await resp.json();
  if (!resp.ok) throw new Error(j?.error?.message || "OpenAI request failed");
  return j;
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const ip = req.headers["x-forwarded-for"] || "local";
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: "Too many requests. Try again later." });
  }

  try {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    const { resumeText, fileBase64, mimeType, role, notes } = req.body || {};

    const allowed = ["application/pdf", "text/plain", ""];
    if (mimeType && !allowed.includes(mimeType)) {
      return res.status(400).json({ error: "Only PDF or TXT is supported." });
    }

    let text = (resumeText || "").trim();
    if (!text) {
      if (!fileBase64) return res.status(400).json({ error: "Missing resume input." });
      text = await extractTextFromFileBase64(fileBase64, mimeType || "");
    }

    if (text.replace(/\s/g, "").length < 120) {
      return res.status(400).json({
        error:
          "Not enough readable text extracted. Try Print→Save as PDF (text-based) or upload TXT."
      });
    }

    // Bigger input allowance (still safe)
    const HARD_LIMIT = 30_000;
    if (text.length > HARD_LIMIT) {
      const head = text.slice(0, 19_000);
      const tail = text.slice(-11_000);
      text = head + "\n\n---\n\n" + tail;
    }

    const systemPrompt = `
You extract a resume into STRICT JSON for a portfolio generator.

Rules:
- Output ONLY valid JSON. No markdown. No commentary.
- Include ALL Professional Experience roles found.
- Include ALL Projects found.
- If many bullets, keep all roles/projects but max 3 bullets each.
- Use empty arrays if a section is missing.

JSON schema:
{
  "name": "",
  "title": "",
  "contact": { "location":"", "phone":"", "email":"", "linkedin":"", "website":"" },
  "summary": "",
  "skills": [ "..." ],
  "experience": [
    { "company":"", "role":"", "location":"", "start":"", "end":"", "bullets":[ "..." ] }
  ],
  "projects": [
    { "name":"", "link":"", "tech":[ "..." ], "bullets":[ "..." ] }
  ],
  "education": [
    { "school":"", "degree":"", "start":"", "end":"", "details":"" }
  ],
  "certifications": [ "..." ],
  "links": [ { "label":"", "url":"" } ]
}
`.trim();

    const userPrompt = `
Target Role: ${role || "Not specified"}
Notes: ${notes || "None"}

RESUME:
${text}
`.trim();

    const baseMessages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ];

    let out = "";
    let parsed = null;
    let passes = 0;
    const maxPasses = 4;

    // pass 1
    let r = await callOpenAI({ key, messages: baseMessages, maxTokens: 2600 });
    out += (r?.choices?.[0]?.message?.content || "");
    parsed = safeJsonParse(out);
    passes++;

    // continue until JSON parses (or max passes)
    while (!parsed && passes < maxPasses) {
      const contMsgs = [
        ...baseMessages,
        { role: "assistant", content: out },
        { role: "user", content: "Continue the JSON EXACTLY where you stopped. Output ONLY JSON (no repeats, no markdown)." }
      ];
      r = await callOpenAI({ key, messages: contMsgs, maxTokens: 1800 });
      out += (r?.choices?.[0]?.message?.content || "");
      parsed = safeJsonParse(out);
      passes++;
    }

    if (!parsed) {
      return res.status(500).json({
        error: "Model output could not be parsed as JSON. Try again (or use a shorter resume)."
      });
    }

    return res.status(200).json({ data: parsed });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}