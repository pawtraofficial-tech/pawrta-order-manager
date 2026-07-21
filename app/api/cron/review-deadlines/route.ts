import { NextRequest, NextResponse } from "next/server";
import { processReviewDeadlines } from "@/lib/review-processing";
import { isCronAuthorized } from "@/lib/security";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await processReviewDeadlines(25, true);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error(JSON.stringify({ event: "review_deadline_run_failed", message: error instanceof Error ? error.message : "unknown" }));
    return NextResponse.json({ error: "Deadline processing failed." }, { status: 500 });
  }
}
