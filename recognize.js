// Food recognition: a photo and/or a text description -> food items with grams and nutrients.
// Called straight from the phone with the user's own key (same approach as VoiceToText).

import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.129.0/+esm";

export const NUTRIENT_FIELDS = ["kcal", "protein", "fat", "carbs", "fiber", "sugar", "alcohol"];

const SYSTEM_PROMPT = `You are a nutrition estimator inside a calorie-tracking app. The user is on a fat-loss diet and relies on your numbers, so be realistic, not optimistic.

You get a photo of a meal, a text description, or both. List every distinct food or drink as a separate item and estimate for each:
- grams: the edible portion as served (cooked weight for cooked foods; ml ≈ g for drinks);
- kcal, protein, fat, carbs, fiber, sugar (total sugars) in grams, based on standard food composition data (USDA-like values);
- alcohol: grams of pure ethanol (0 for non-alcoholic items).

Estimating portions from a photo:
- Use plate, cutlery, hands, cups and packaging as size references.
- Include cooking fat and sauces you can see or that the dish normally contains (fried food, dressed salad, buttered rice). Add them as separate items like "Sunflower oil (frying)" when that makes the numbers clearer.
- Typical home and restaurant dishes from any cuisine are expected, including Russian and Eastern European ones.

Text from the user:
- It may be in any language (often Russian). Always write item names in short, plain English, e.g. "Buckwheat, boiled", "Chicken cutlet, fried".
- Explicit amounts in the text ("200 g", "2 eggs", "a tablespoon of oil") override what you see.
- A correction to an earlier estimate replaces the matching part of it.

confidence per item: "high" if clearly visible or stated, "medium" for a typical guess, "low" if the portion or ingredients are mostly guessed.

question: ONE short question about the biggest remaining uncertainty, only if the answer could change the total by more than about 15 % (e.g. "Was it fried in oil or baked?"). Otherwise an empty string.

If the photo shows no food or drink, return no items and explain briefly in question.`;

const ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "grams", ...NUTRIENT_FIELDS, "confidence"],
  properties: {
    name: { type: "string" },
    grams: { type: "number" },
    ...Object.fromEntries(NUTRIENT_FIELDS.map((n) => [n, { type: "number" }])),
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
};

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items", "question"],
  properties: {
    items: { type: "array", items: ITEM_SCHEMA },
    question: { type: "string" },
  },
};

// imageBase64: JPEG without the data: prefix. text: what the user typed. note: a correction.
export async function estimate({ apiKey, model, imageBase64, text, note }) {
  const content = [];
  if (imageBase64) {
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } });
  }
  const parts = [];
  if (text) parts.push(`What I ate: ${text}`);
  if (note) parts.push(`Correction to your previous estimate: ${note}`);
  if (!parts.length) parts.push("Estimate this meal.");
  content.push({ type: "text", text: parts.join("\n") });

  // The key comes from this phone's storage, never from the published page.
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
    output_config: {
      format: { type: "json_schema", schema: RESULT_SCHEMA },
      // No effort setting for Haiku 4.5: it doesn't support it.
      ...(model.startsWith("claude-haiku") ? {} : { effort: "medium" }),
    },
  });

  if (response.stop_reason === "refusal") throw new Error("Claude declined this request.");
  if (response.stop_reason === "max_tokens") throw new Error("The answer was cut off. Try again.");
  const json = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const result = JSON.parse(json);
  result.items = result.items.map((item) => ({ ...item, estimated: true }));
  return result;
}

// Turns an API error into a short message and says whether the entry should wait for the network.
export function describeError(error) {
  if (error instanceof Anthropic.AuthenticationError) return { message: "The API key was rejected. Check it in ⚙︎ Settings.", retryLater: false };
  if (error instanceof Anthropic.PermissionDeniedError) return { message: "This API key can't use the selected model.", retryLater: false };
  if (error instanceof Anthropic.RateLimitError) return { message: "Too many requests or no credit left. Try again in a minute.", retryLater: true };
  if (error instanceof Anthropic.APIConnectionError) return { message: "No connection. The photo is saved and will wait.", retryLater: true };
  if (error instanceof Anthropic.InternalServerError) return { message: "Claude is temporarily unavailable. Try again shortly.", retryLater: true };
  return { message: error?.message || "Recognition failed.", retryLater: true };
}
