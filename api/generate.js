import pdf from "pdf-parse";

const RATE_LIMIT_WINDOW = 60_000; // 1 minute
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
  return buffer.toString("utf8"); // txt
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
      temperature: 0.2,
      max_tokens: maxTokens
    })
  });

  const j = await resp.json();
  if (!resp.ok) {
    const msg = j?.error?.message || "OpenAI request failed";
    throw new Error(msg);
  }
  return j;
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

    const { resumeText, fileBase64, mimeType, role, notes, template } = req.body || {};

    // PDF/TXT only
    const allowed = ["application/pdf", "text/plain", ""];
    if (mimeType && !allowed.includes(mimeType)) {
      return res.status(400).json({ error: "Only PDF or TXT is supported." });
    }

    let text = (resumeText || "").trim();

    // fallback: server extraction if browser extraction not provided
    if (!text) {
      if (!fileBase64) return res.status(400).json({ error: "Missing resume input." });
      text = await extractTextFromFileBase64(fileBase64, mimeType || "");
    }

    // Too little text => image-based/protected PDF
    if (text.replace(/\s/g, "").length < 120) {
      return res.status(400).json({
        error:
          "We could not extract enough readable text from this PDF. " +
          "Try: Print → Save as PDF (text-based), or upload a TXT version."
      });
    }

    // Keep head + tail (prevents losing Projects/Certifications at end)
    if (text.length > 18_000) {
      const head = text.slice(0, 12_000);
      const tail = text.slice(-6_000);
      text = head + "\n\n---\n\n" + tail;
    }

    const systemPrompt = `
You are a premium portfolio website generator.

OUTPUT:
- Output ONLY complete standalone HTML (no markdown/backticks).
- Use natural document flow.
- Do NOT use fixed heights (no height:..., no 100vh).
- Do NOT use overflow:hidden on body or major containers.
- Use max-width: 900px and centered layout.

MUST PRESERVE CONTENT:
- NEVER omit any Professional Experience entries found in the resume text.
- NEVER omit Projects found in the resume text.
- If too many bullets, keep ALL roles/projects but limit to max 2 bullets each (do not drop roles).

HEADER:
- Full-width dark navy bar (#0B2D45).
- Large white name centered.
- One-line contact row: Location | Phone | Email | LinkedIn

SKILLS:
.skills-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; }

PDF:
- Wrap each experience item and each project item in <div class="keep-together">...</div>
- .keep-together { break-inside: avoid; page-break-inside: avoid; }

STYLE:
- Keep sections concise. Avoid long paragraphs.
- Prefer compact spacing.
- Template Style: ${template || "Modern Minimal"}
`.trim();

    const userPrompt = `
Target Role: ${role || "Not specified"}
Extra Notes: ${notes || "None"}

RESUME (DO NOT DROP EXPERIENCE/PROJECTS):
${text}
`.trim();

    const baseMessages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ];

    // 1) First pass
    let out = "";
    const first = await callOpenAI({ key, messages: baseMessages, maxTokens: 2800 });
    out += first?.choices?.[0]?.message?.content || "";
    const finish1 = first?.choices?.[0]?.finish_reason;

    // 2) Continue if truncated by token limit
    if (finish1 === "length") {
      const contMsgs = [
        ...baseMessages,
        { role: "assistant", content: out },
        {
          role: "user",
          content:
            "Continue EXACTLY where you stopped. Output ONLY the remaining HTML. " +
            "Do not repeat earlier content. Ensure proper closing tags (including </body></html>)."
        }
      ];

      const second = await callOpenAI({ key, messages: contMsgs, maxTokens: 1800 });
      out += "\n" + (second?.choices?.[0]?.message?.content || "");
    }

    // Safety: if still missing closing tags, attempt one more short continuation
    if (!out.includes("</html>")) {
      const contMsgs2 = [
        ...baseMessages,
        { role: "assistant", content: out },
        { role: "user", content: "Finish the HTML document by outputting ONLY missing closing tags/ending content. No repeats." }
      ];
      const third = await callOpenAI({ key, messages: contMsgs2, maxTokens: 400 });
      out += "\n" + (third?.choices?.[0]?.message?.content || "");
    }

    return res.status(200).json({ text: out });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}