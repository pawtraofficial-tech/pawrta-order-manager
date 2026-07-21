type EmailInput = { to: string | string[]; subject: string; html: string; idempotencyKey?: string };

export function escapeEmailHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] || character);
}

export async function sendEmail(input: EmailInput) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.PAWTRA_FROM_EMAIL;
  if (!apiKey || !from) return { sent: false as const, skipped: true as const };
  const { idempotencyKey, ...body } = input;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify({ from, ...body }),
  });
  if (!response.ok) throw new Error(`Email failed: ${response.status}`);
  const result = await response.json();
  return { sent: true as const, skipped: false as const, result };
}

export function appUrl(path = "") {
  const base = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return `${base.replace(/\/$/, "")}${path}`;
}
