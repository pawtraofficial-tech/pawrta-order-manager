import { NextRequest, NextResponse } from "next/server";
import { adminCookie, createAdminSession } from "@/lib/admin-auth";
import { isAdminAuthorized } from "@/lib/security";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (!isAdminAuthorized(typeof body.key === "string" ? body.key : null)) {
    return NextResponse.json({ error: "Incorrect admin key." }, { status: 401 });
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(adminCookie.name, createAdminSession(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: adminCookie.maxAge,
  });
  return response;
}
