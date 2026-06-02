import { generateText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { auth } from "@/auth";
import { getProviderApiKeys } from "@agent/_lib/config/keys";

export const maxDuration = 30;

// Voice input: transcribe a short audio clip with Gemini, return the text.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "unauthorized" }, { status: 401 });

  const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY || getProviderApiKeys().google;
  if (!key) {
    return Response.json(
      { error: "Voice needs a Gemini API key. Add GOOGLE_GENERATIVE_AI_API_KEY to .env.local.", text: "" },
      { status: 503 },
    );
  }

  const { audio, mimeType } = (await req.json().catch(() => ({}))) as {
    audio?: string;
    mimeType?: string;
  };
  if (!audio) return Response.json({ text: "" });

  const model = process.env.GEMINI_TRANSCRIBE_MODEL || "gemini-2.5-flash";
  const mediaType = (mimeType || "audio/webm").split(";")[0];

  try {
    const google = createGoogleGenerativeAI({ apiKey: key });
    const { text } = await generateText({
      model: google(model),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Transcribe this audio to text. The speaker is searching for products to shop for in India. " +
                "Return ONLY the spoken words as plain text — no quotes, no commentary, no preamble. " +
                "If there is no clear speech, return an empty string.",
            },
            { type: "file", data: Buffer.from(audio, "base64"), mediaType },
          ],
        },
      ],
    });
    return Response.json({ text: text.trim() });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Transcription failed", text: "" },
      { status: 200 },
    );
  }
}
