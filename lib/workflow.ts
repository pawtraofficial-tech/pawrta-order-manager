export const ORDER_STATUSES = [
  "artwork_in_progress",
  "preview_ready",
  "revision_requested",
  "approved",
  "in_production",
  "shipped",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const MAX_FREE_REVISIONS = 3;
export const MAX_PREVIEW_VERSION = MAX_FREE_REVISIONS + 1;
export const MAX_PREVIEW_FILE_SIZE = 12 * 1024 * 1024;
export const PREVIEW_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const REVIEW_WINDOW_HOURS = 72;
export const REVIEW_WINDOW_MS = REVIEW_WINDOW_HOURS * 60 * 60 * 1000;

export function reviewDeadline(start: Date | string | number) {
  const startedAt = new Date(start);
  if (!Number.isFinite(startedAt.getTime())) throw new Error("Invalid review start time.");
  return new Date(startedAt.getTime() + REVIEW_WINDOW_MS);
}

export function remainingReviewMs(deadline: Date | string | number, now: Date | string | number = Date.now()) {
  return Math.max(0, new Date(deadline).getTime() - new Date(now).getTime());
}

export function formatCountdown(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return days > 0
    ? `${days}d ${hours}h ${minutes}m ${seconds}s`
    : `${hours}h ${minutes}m ${seconds}s`;
}

export function normalizeOrderNumber(value: string) {
  return value.trim().replace(/^#/, "");
}

export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] || character);
}

export function isValidStatusTransition(current: OrderStatus, next: OrderStatus) {
  return (
    (current === "approved" && next === "in_production") ||
    (current === "in_production" && next === "shipped")
  );
}

export function previewLabel(version: number) {
  if (!Number.isInteger(version) || version < 1 || version > MAX_PREVIEW_VERSION) {
    throw new Error("Invalid preview version.");
  }
  return version === 1 ? "Initial Design" : `Revision ${version - 1}`;
}

export function hasValidImageSignature(bytes: Uint8Array, mimeType: string) {
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/png") return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
  if (mimeType === "image/webp") {
    return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  }
  return false;
}
