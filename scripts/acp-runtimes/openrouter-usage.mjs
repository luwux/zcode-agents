#!/usr/bin/env node
// Prints the cumulative USD usage of the OpenRouter key in OPENROUTER_API_KEY as JSON
// ({"usage": <number>}), using GET /api/v1/key. Run before and after the live tests; the
// difference is the cost of the run. Never prints the key.
const key = process.env.OPENROUTER_API_KEY?.trim();
if (!key) {
  console.log(JSON.stringify({ usage: null, reason: "OPENROUTER_API_KEY not set" }));
  process.exit(0);
}
const response = await fetch("https://openrouter.ai/api/v1/key", {
  headers: { authorization: `Bearer ${key}` },
});
if (!response.ok) {
  console.log(JSON.stringify({ usage: null, reason: `HTTP ${response.status}` }));
  process.exit(0);
}
const body = await response.json();
console.log(
  JSON.stringify({ usage: typeof body?.data?.usage === "number" ? body.data.usage : null }),
);
