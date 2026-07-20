import assert from "node:assert/strict";
import test from "node:test";
import {
  escapeHtml,
  hasValidImageSignature,
  isValidStatusTransition,
  MAX_FREE_REVISIONS,
  MAX_PREVIEW_VERSION,
  normalizeEmail,
  normalizeOrderNumber,
  previewLabel,
} from "../lib/workflow";

test("the initial preview is version 1 and three revisions end at version 4", () => {
  assert.equal(MAX_FREE_REVISIONS, 3);
  assert.equal(MAX_PREVIEW_VERSION, 4);
  assert.equal(previewLabel(1), "Initial Design");
  assert.equal(previewLabel(2), "Revision 1");
  assert.equal(previewLabel(4), "Revision 3");
  assert.throws(() => previewLabel(5));
});

test("only approved orders enter production and only production orders ship", () => {
  assert.equal(isValidStatusTransition("approved", "in_production"), true);
  assert.equal(isValidStatusTransition("in_production", "shipped"), true);
  assert.equal(isValidStatusTransition("preview_ready", "in_production"), false);
  assert.equal(isValidStatusTransition("approved", "shipped"), false);
});

test("customer identifiers normalize without broad matching", () => {
  assert.equal(normalizeOrderNumber(" #1048 "), "1048");
  assert.equal(normalizeEmail(" Buyer+Pet@Example.COM "), "buyer+pet@example.com");
});

test("customer content is escaped for HTML email", () => {
  assert.equal(escapeHtml(`<b>"Milo" & 'Otis'</b>`), "&lt;b&gt;&quot;Milo&quot; &amp; &#39;Otis&#39;&lt;/b&gt;");
});

test("preview MIME claims require matching file signatures", () => {
  assert.equal(hasValidImageSignature(Uint8Array.from([0xff, 0xd8, 0xff]), "image/jpeg"), true);
  assert.equal(hasValidImageSignature(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"), true);
  assert.equal(hasValidImageSignature(new TextEncoder().encode("RIFF0000WEBP"), "image/webp"), true);
  assert.equal(hasValidImageSignature(new TextEncoder().encode("not an image"), "image/png"), false);
});
