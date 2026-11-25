/**
 * Discord webhooks are posting credentials, so failures report Discord's
 * complaint without ever echoing the URL that authorized the request.
 */

export async function sendDiscord(webhook: string, content: string): Promise<string> {
  const url = `${webhook}${webhook.includes("?") ? "&" : "?"}wait=true`;
  let response: Response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(scrubWebhook(`discord webhook POST failed: ${errorText(err)}`, webhook));
  }

  const body = await response.text();
  if (!response.ok) {
    throw new Error(scrubWebhook(`discord webhook POST failed with status ${response.status}: ${body}`, webhook));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(scrubWebhook(`discord webhook response was not JSON: ${errorText(err)}; received ${body}`, webhook));
  }

  if (!isRecord(parsed) || typeof parsed["id"] !== "string") {
    throw new Error(scrubWebhook(`discord webhook response id must be a string; received ${describeUnknown(parsed)}`, webhook));
  }
  return parsed["id"];
}

export function scrubWebhook(message: string, webhook: string): string {
  let scrubbed = message;
  if (webhook !== "") scrubbed = scrubbed.split(webhook).join("[discord-webhook]");
  return scrubbed.replace(/https:\/\/discord(?:app)?\.com\/api\/webhooks\/[^\s"'<>]+/g, "[discord-webhook]");
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return describeUnknown(err);
}

function describeUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  const encoded = JSON.stringify(value);
  return encoded ?? String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
