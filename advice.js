// Daily advice from Claude: in the morning, a plan for today based on yesterday, the last week and
// the weight trend; in the evening, a short review of today. One small request, cached per day.

import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.129.0/+esm";

const SYSTEM_PROMPT = `You are a sports nutrition coach inside a calorie-tracking app. The user is on a cut: losing fat while keeping muscle. You get their profile, daily targets, recent days and weight trend as JSON.

Write advice that is specific to these numbers, not generic. Rules:
- Protein first: hitting the protein target matters most for keeping muscle in a deficit.
- Compare with the targets: calories, protein, fiber, water. Mention the biggest gap or win, with numbers.
- Use the weight trend: on track, slower than planned, or faster than 1 % a week (then suggest eating a bit more to protect muscle).
- Suggest concrete foods and portions from the user's usual foods list when possible ("200 g cottage cheese", "your chicken cutlet + buckwheat").
- If days are missing from the log, encourage logging rather than guessing.
- Be supportive and short. No medical claims. Plain text inside each field, no Markdown.

kind "morning": a plan for TODAY based on yesterday and the last week.
kind "evening": a review of TODAY so far and what to do with what is left of it (and one thing for tomorrow).

Output: headline (one sentence, max 90 characters) and 2-3 tips (each one or two short sentences).`;

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "tips"],
  properties: {
    headline: { type: "string" },
    tips: { type: "array", items: { type: "string" } },
  },
};

export async function dailyAdvice({ apiKey, model, kind, context }) {
  // The key comes from this phone's storage, never from the published page.
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: JSON.stringify({ kind, ...context }) }],
    output_config: {
      format: { type: "json_schema", schema: RESULT_SCHEMA },
      // No effort setting for Haiku 4.5: it doesn't support it.
      ...(model.startsWith("claude-haiku") ? {} : { effort: "low" }),
    },
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined this request.");
  if (response.stop_reason === "max_tokens") throw new Error("The answer was cut off. Try again.");
  const result = JSON.parse(response.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
  return { headline: result.headline, tips: result.tips.slice(0, 3) };
}
