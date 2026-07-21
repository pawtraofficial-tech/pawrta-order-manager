import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

type Entry = { count: number; resetAt: number };
const buckets = new Map<string, Entry>();

export function clientAddress(req: NextRequest) {
  return req.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
}

function localRateLimit(req: NextRequest, scope: string, limit: number, windowMs: number) {
  const now = Date.now();
  const key = `${scope}:${clientAddress(req)}`;
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }
  if (current.count >= limit) {
    const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }
  current.count += 1;
  return null;
}

export async function rateLimit(req: NextRequest, scope: string, limit: number, windowMs: number) {
  const bucketKey = crypto.createHash("sha256").update(`${scope}:${clientAddress(req)}`).digest("hex");
  try {
    const result = await getSupabaseAdmin().rpc("check_rate_limit", {
      p_scope: scope,
      p_bucket_key: bucketKey,
      p_limit: limit,
      p_window_seconds: Math.ceil(windowMs / 1000),
    });
    if (result.error) throw result.error;
    const state = result.data as { allowed: boolean; retryAfter: number };
    if (state.allowed) return null;
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(state.retryAfter) } },
    );
  } catch (error) {
    console.error("Shared rate limit unavailable; using instance fallback", error instanceof Error ? error.message : "unknown");
    return localRateLimit(req, scope, limit, windowMs);
  }
}
