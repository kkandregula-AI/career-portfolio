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
    throw new Error(j?.error?.message || "OpenAI request failed");
  }
  return j;
}

function stripMarkdownFences(s) {
  return String(s || "").replace(/```html/gi, "").replace(/```/g, "").trim();
}

function hasHtmlClose(s) {
  const t = String(s || "").toLowerCase();
  return t.includes("</html>");
}

function ensureHtmlClosed(s) {
  // If model forgot closings, append safe closings.
  let out = String(s || "").trim();
  const low = out.toLowerCase();
  if (!low.includes("</body>")) out += "\n</body>";
  if (!low.includes("</html>")) out += "\n</html>";
  return out;
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

    const allowed = ["application/pdf", "text/plain", ""];
    if (mimeType && !allowed.includes(mimeType)) {
      return res.status(400).json({ error: "Only PDF or TXT is supported." });
    }

    let text = (resumeText || "").trim();

    // Fallback: server extraction
    if (!text) {
      if (!fileBase64) return res.status(400).json({ error: "Missing resume input." });
      text = await extractTextFromFileBase64(fileBase64, mimeType || "");
    }

    // Too little text => image/protected PDF or extraction failure
    if (text.replace(/\s/g, "").length < 120) {
      return res.status(400).json({
        error:
          "We could not extract enough readable text from this PDF. " +
          "Try: Print → Save as PDF (text-based), or upload a TXT version."
      });
    }

    /**
     * IMPORTANT:
     * Don’t chop too aggressively. We want full experience/projects.
     * Still protect token usage by using head+tail if huge.
     */
    const HARD_LIMIT = 28_000; // increased from 18k
    if (text.length > HARD_LIMIT) {
      const head = text.slice(0, 18_000);
      const tail = text.slice(-10_000);
      text = head + "\n\n---\n\n" + tail;
    }

    const systemPrompt = `
You are a premium portfolio website generator.

OUTPUT:
- Output ONLY complete standalone HTML (no markdown/backticks).
- Use natural document flow.
- Do NOT use fixed heights (no 100vh).
- Do NOT use overflow:hidden on body or major containers.
- Center layout with max-width: 900px.
- Use compact spacing.

COMPLETENESS (CRITICAL):
- NEVER omit Professional Experience entries found in the resume.
- NEVER omit Projects found in the resume.
- If many bullets, keep ALL roles/projects but limit to max 2 bullets each (do not drop items).
- You MUST return a COMPLETE HTML document with closing tags </body></html>.

HEADER:
- Full-width dark navy bar (#0B2D45).
- Large white name centered.
- One-line contact row: Location | Phone | Email | LinkedIn

SKILLS:
.skills-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; }

PDF:
- Wrap each experience item and each project item in <div class="keep-together">...</div>
- .keep-together { break-inside: avoid; page-break-inside: avoid; }

Template Style: ${template || "Modern Minimal"}
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

    /**
     * Robust continuation loop:
     * Keep asking to continue if model hit token limit.
     * Stop when:
     *  - finish_reason != "length" AND we have </html>
     *  - OR we reach maxPasses
     */
    let out = "";
    let passes = 0;
    const maxPasses = 4;          // up to 4 chunks
    const firstMaxTokens = 3000;  // bigger initial chunk
    const nextMaxTokens = 1800;   // continuation chunks

    // First pass
    const first = await callOpenAI({ key, messages: baseMessages, maxTokens: firstMaxTokens });
    let chunk = stripMarkdownFences(first?.choices?.[0]?.message?.content || "");
    out += chunk;
    let finish = first?.choices?.[0]?.finish_reason;
    passes++;

    // Continue while truncated OR missing closing
    while (passes < maxPasses && (finish === "length" || !hasHtmlClose(out))) {
      const continueMessages = [
        ...baseMessages,
        { role: "assistant", content: out },
        {
          role: "user",
          content:
            "Continue EXACTLY from where you stopped. Output ONLY the remaining HTML. " +
            "Do NOT repeat earlier content. Ensure final output ends with </body></html>."
        }
      ];

      const nxt = await callOpenAI({ key, messages: continueMessages, maxTokens: nextMaxTokens });
      const nxtChunk = stripMarkdownFences(nxt?.choices?.[0]?.message?.content || "");
      out += "\n" + nxtChunk;
      finish = nxt?.choices?.[0]?.finish_reason;
      passes++;
    }

    // Final safety: force closings if still missing
    out = ensureHtmlClosed(out);

    return res.status(200).json({ text: out });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}