type EmailInput = { to: string | string[]; subject: string; html: string };

export async function sendEmail(input: EmailInput) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.PAWTRA_FROM_EMAIL;
  if (!apiKey || !from) return { skipped: true };
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ from, ...input }),
  });
  if (!response.ok) throw new Error(`Email failed: ${response.status}`);
  return response.json();
}

export function appUrl(path = "") {
  const base = process.env.NEXT_PUBLIC_APP_URL || "https://pawtra-order-manager.vercel.app";
  return `${base.replace(/\/$/, "")}${path}`;
}
