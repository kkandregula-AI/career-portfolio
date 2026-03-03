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
      temperature: 0.15,
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

function clampText(text, maxLen) {
  if (text.length <= maxLen) return text;
  // Keep head + tail (experience often appears mid/late; tail is important)
  const head = text.slice(0, Math.floor(maxLen * 0.55));
  const tail = text.slice(-Math.floor(maxLen * 0.45));
  return head + "\n\n---\n\n" + tail;
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

    // 1) Get resume text
    let text = (resumeText || "").trim();
    if (!text) {
      if (!fileBase64) return res.status(400).json({ error: "Missing resume input." });
      text = await extractTextFromFileBase64(fileBase64, mimeType || "");
    }

    // Basic sanity
    if (text.replace(/\s/g, "").length < 150) {
      return res.status(400).json({
        error: "Not enough readable text extracted. Try Print→Save as PDF (text-based) or upload TXT."
      });
    }

    // 2) Clamp text to avoid huge prompts (still keep experience + tail)
    const HARD_LIMIT = 45_000;
    text = clampText(text, HARD_LIMIT);

    // 3) System prompt focused on NOT losing content
    const systemPrompt = `
You extract a resume into STRICT JSON for a portfolio generator.

ABSOLUTE RULES:
- Output ONLY valid JSON. No markdown. No commentary.
- Do NOT drop any experience roles or project entries that appear in the resume text.
- Preserve ALL roles, ALL companies, ALL date ranges, and ALL bullet points.
- You may rewrite bullets for clarity/impact, but do NOT reduce bullet count or remove entries.
- Use empty arrays if a section is missing.

If the resume is long:
- Keep every role and project.
- If a bullet is extremely long, shorten wording while preserving meaning.

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

    // 4) Try to get full JSON, then "continue" if cut off
    let out = "";
    let parsed = null;

    // Pass 1
    let r = await callOpenAI({ key, messages: baseMessages, maxTokens: 3000 });
    out += (r?.choices?.[0]?.message?.content || "");
    parsed = safeJsonParse(out);

    // Continue passes if model cut off mid-JSON
    let passes = 1;
    const maxPasses = 6;

    while (!parsed && passes < maxPasses) {
      const contMsgs = [
        ...baseMessages,
        { role: "assistant", content: out },
        { role: "user", content: "Continue the JSON EXACTLY where you stopped. Output ONLY JSON. Do not repeat earlier JSON." }
      ];
      r = await callOpenAI({ key, messages: contMsgs, maxTokens: 2200 });
      out += (r?.choices?.[0]?.message?.content || "");
      parsed = safeJsonParse(out);
      passes++;
    }

    // 5) If still not parseable, attempt JSON repair once
    if (!parsed) {
      const repairMsgs = [
        {
          role: "system",
          content: "Convert the following into VALID JSON only matching the schema. Do not remove sections. No markdown."
        },
        { role: "user", content: out }
      ];
      const rr = await callOpenAI({ key, messages: repairMsgs, maxTokens: 2600 });
      const repaired = rr?.choices?.[0]?.message?.content || "";
      parsed = safeJsonParse(repaired);

      // If repair succeeded, set out to repaired (optional)
      if (parsed) out = repaired;
    }

    if (!parsed) {
      return res.status(500).json({
        error:
          "Model output could not be parsed as JSON (likely truncated). Try again, or upload a TXT resume, or shorten the resume slightly."
      });
    }

    // 6) Final sanity: ensure experience/projects arrays exist
    if (!Array.isArray(parsed.experience)) parsed.experience = [];
    if (!Array.isArray(parsed.projects)) parsed.projects = [];
    if (!Array.isArray(parsed.skills)) parsed.skills = [];

    return res.status(200).json({ data: parsed });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}