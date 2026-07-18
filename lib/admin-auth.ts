import crypto from "crypto";
import { NextRequest } from "next/server";

const COOKIE_NAME = "pawtra_admin_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12;

function secret() {
  return process.env.PAWTRA_ADMIN_KEY || "";
}

function sign(value: string) {
  return crypto.createHmac("sha256", secret()).update(value).digest("base64url");
}

export function createAdminSession() {
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = String(expires);
  return `${payload}.${sign(payload)}`;
}

export function verifyAdminSession(token?: string | null) {
  if (!token || !secret()) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const expires = Number(payload);
  return Number.isFinite(expires) && expires > Math.floor(Date.now() / 1000);
}

export function isAdminRequest(req: NextRequest) {
  const cookie = req.cookies.get(COOKIE_NAME)?.value;
  if (verifyAdminSession(cookie)) return true;
  const header = req.headers.get("x-pawtra-admin-key");
  const expected = secret();
  if (!header || !expected) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const adminCookie = {
  name: COOKIE_NAME,
  maxAge: SESSION_TTL_SECONDS,
};
