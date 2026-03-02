import pdf from "pdf-parse";

const RATE_LIMIT_WINDOW = 60000; // 1 min
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

async function extractText(base64, mime) {
  const buffer = Buffer.from(base64, "base64");

  if (mime === "application/pdf") {
    const data = await pdf(buffer);
    return data.text || "";
  }

  // TXT (or unknown treated as text)
  return buffer.toString("utf8");
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

    const { fileBase64, mimeType, role, notes, template } = req.body || {};
    if (!fileBase64) return res.status(400).json({ error: "Missing fileBase64" });

    // Only allow PDF/TXT
    const allowed = ["application/pdf", "text/plain", ""];
    if (!allowed.includes(mimeType || "")) {
      return res.status(400).json({ error: "Only PDF or TXT is supported." });
    }

    let resumeText = await extractText(fileBase64, mimeType || "");
    // Safety cap (keeps it fast + cheaper)
    if (resumeText.length > 18000) resumeText = resumeText.slice(0, 18000);

    const systemPrompt = `
You are a premium portfolio website generator.

OUTPUT RULES:
- Output ONLY complete standalone HTML (no markdown / no backticks).
- body { margin: 0; font-family: system-ui; }
- Center content max-width: 900px.
- Compact, recruiter-friendly layout.

HEADER (MANDATORY):
- Full-width dark navy bar (#0B2D45).
- Large white name centered.
- One-line contact row: Location | Phone | Email | LinkedIn

SKILLS:
- MUST be multi-column grid:
.skills-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; }

PDF/PRINT:
- Wrap each experience item and each project item in <div class="keep-together">...</div>
- Add CSS:
.keep-together { break-inside: avoid; page-break-inside: avoid; }

Template Style: ${template || "Modern Minimal"}
`.trim();

    const userPrompt = `
Target Role: ${role || "Not specified"}
Extra Notes: ${notes || "None"}

RESUME:
${resumeText}
`.trim();

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.2,
        max_tokens: 1400
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || "OpenAI request failed",
        raw: data
      });
    }

    const text = data?.choices?.[0]?.message?.content || "";
    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}