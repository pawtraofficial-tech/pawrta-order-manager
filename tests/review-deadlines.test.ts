import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET as cronGet } from "../app/api/cron/review-deadlines/route";

const migration = readFileSync(new URL("../supabase/migrations/20260721075927_add_review_deadlines.sql", import.meta.url), "utf8");

test("cron rejects missing and invalid bearer authorization", async () => {
  const original = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "test-only-cron-secret";
  try {
    const missing = await cronGet(new NextRequest("http://localhost/api/cron/review-deadlines"));
    const invalid = await cronGet(new NextRequest("http://localhost/api/cron/review-deadlines", { headers: { authorization: "Bearer wrong" } }));
    assert.equal(missing.status, 401);
    assert.equal(invalid.status, 401);
  } finally {
    process.env.CRON_SECRET = original;
  }
});

test("migration preserves historical windows and starts each new upload at exactly 72 hours", () => {
  assert.match(migration, /review_started_at timestamptz/);
  assert.match(migration, /review_deadline_at = review_started_at \+ interval '72 hours'/);
  assert.match(migration, /review_deadline_at, order_id\)\s+where review_deadline_at is not null and review_closed_at is null/);
  assert.match(migration, /review_window_started/);
});

test("revision closes the current timer and revised upload completes the open request", () => {
  assert.match(migration, /update public\.previews set review_closed_at = v_now where id = p_preview_id and review_closed_at is null/);
  assert.match(migration, /set status = 'completed', completed_at = v_now/);
  assert.match(migration, /'revision_completed'/);
});

test("manual and automatic approvals record distinct authoritative sources", () => {
  assert.match(migration, /approval_source = 'manual'/);
  assert.match(migration, /approval_source = 'automatic_72h'/);
  assert.match(migration, /'artwork_approved'/);
  assert.match(migration, /'artwork_auto_approved'/);
});

test("expiry eligibility blocks open revisions, older previews and non-preview-ready orders", () => {
  assert.match(migration, /o\.status = 'preview_ready'/);
  assert.match(migration, /status = 'open'/);
  assert.match(migration, /order by p2\.version_number desc limit 1/);
  assert.match(migration, /review_deadline_at <= v_now/);
});

test("approval, revision and cron races lock in one order and are retry-safe", () => {
  const orderLocks = migration.match(/from public\.orders where id = p_order_id for update/g) || [];
  assert.ok(orderLocks.length >= 3);
  assert.match(migration, /for update skip locked limit p_limit/);
  assert.match(migration, /where id = v_order\.id and status = 'preview_ready' and approved_at is null/);
  assert.match(migration, /unique \(preview_id, kind, review_sequence\)/);
  assert.match(migration, /on conflict \(preview_id, kind, review_sequence\) do nothing/);
});

test("existing previews are deliberately left inactive", () => {
  const schemaSection = migration.split("create or replace function")[0];
  assert.doesNotMatch(schemaSection, /update public\.previews set review_started_at/i);
  assert.match(migration, /explicit admin restart/i);
});

test("production status remains in_production", () => {
  assert.doesNotMatch(migration, /status\s*=\s*'production'/);
});
