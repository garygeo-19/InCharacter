// Plain-word API error wording for the client.
// Server messages are already plain ("Too many classes this hour.") and pass
// through untouched; technical shapes (bare statuses, forwarded Meta/Voice
// API detail, network TypeErrors) are mapped to something a learner can act
// on. Never includes a key, audio, or transcript — only the message shape.

/** Map a raw API/client error to display wording. Never throws. */
export function friendlyErrorMessage(raw: unknown): string {
  const text = (
    typeof raw === 'string' ? raw : raw instanceof Error ? raw.message : String(raw ?? '')
  ).trim();
  if (!text) return 'Something went wrong. Try again.';
  if (/failed to fetch|networkerror|network request failed|load failed/i.test(text)) {
    return "Couldn't reach the server. Check your connection and try again.";
  }
  const requestFailed = text.match(/request failed(?::\s*|\s+with\s+status\s+)(\d{3})?/i);
  if (requestFailed) {
    const status = requestFailed[1] ? Number(requestFailed[1]) : 0;
    if (status === 429) return 'Too many tries right now. Wait a bit and try again.';
    if (status === 503) return 'The class is full today. Come back tomorrow.';
    return 'Something went wrong on our side. Try again.';
  }
  if (/transcription failed/i.test(text)) {
    return "That recording didn't transcribe. Try again.";
  }
  if (/timed out after/i.test(text)) {
    return 'That took too long. Try again.';
  }
  return text;
}
