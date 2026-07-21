import { audit } from "@/lib/audit";
import { appUrl, escapeEmailHtml, sendEmail } from "@/lib/email";
import { syncOrderState } from "@/lib/shopify";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

type Delivery = {
  id: string;
  order_id: string;
  preview_id: string;
  kind: "preview_ready" | "revision_ready" | "reminder_24h" | "reminder_6h" | "automatic_approval";
};

function deadlineText(value: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "full", timeStyle: "long", timeZone: "UTC",
  }).format(new Date(value));
}

function reviewEmail(kind: Delivery["kind"], order: { order_number: string; customer_name: string | null }, deadline: string) {
  const name = escapeEmailHtml(order.customer_name || "there");
  const number = escapeEmailHtml(order.order_number);
  const exact = escapeEmailHtml(deadlineText(deadline));
  const track = appUrl("/track");
  const common = `<p>Hello ${name},</p><p>Order <strong>#${number}</strong></p>`;
  if (kind === "automatic_approval") return {
    subject: `Your Pawtra artwork was approved — #${number}`,
    html: `${common}<p>The 72-hour review window ended without a revision request, so the latest artwork was automatically approved. Pawtra will begin production only after our team completes the production step.</p><p><a href="${track}">View your order</a></p>`,
  };
  if (kind === "reminder_24h" || kind === "reminder_6h") {
    const remaining = kind === "reminder_24h" ? "24 hours" : "6 hours";
    return {
      subject: `${remaining} left to review your Pawtra artwork — #${number}`,
      html: `${common}<p>About ${remaining} remain in your artwork review window. Please approve the latest artwork or request a revision before <strong>${exact}</strong>. If no action is taken, it will be automatically approved.</p><p><a href="${track}">Review your artwork</a></p>`,
    };
  }
  return {
    subject: `${kind === "revision_ready" ? "Your revised" : "Your"} Pawtra artwork is ready — #${number}`,
    html: `${common}<p>Your ${kind === "revision_ready" ? "revised " : ""}artwork is ready and a new 72-hour review window has started.</p><p>Please approve your artwork or request a revision before <strong>${exact}</strong>. If no action is taken, the latest artwork will be automatically approved. Three revision rounds are included.</p><p><a href="${track}">Review your artwork</a></p>`,
  };
}

async function markWarning(orderId: string, code: string) {
  const db = getSupabaseAdmin();
  const current = await db.from("orders").select("last_external_warning").eq("id", orderId).single();
  if (!current.error && current.data.last_external_warning === code) return;
  await db.from("orders").update({ last_external_warning: code }).eq("id", orderId);
  await audit(orderId, "external_integration_warning", { code });
}

export async function deliverReviewNotifications(limit = 25) {
  const db = getSupabaseAdmin();
  const claimed = await db.rpc("claim_review_notifications", { p_limit: limit });
  if (claimed.error) throw new Error(`Notification claim failed: ${claimed.error.message}`);
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const delivery of (claimed.data || []) as Delivery[]) {
    const [orderResult, previewResult, latestPreviewResult] = await Promise.all([
      db.from("orders").select("order_number,customer_email,customer_name,status,approved_preview_id,approval_source").eq("id", delivery.order_id).single(),
      db.from("previews").select("review_deadline_at,review_closed_at").eq("id", delivery.preview_id).single(),
      db.from("previews").select("id").eq("order_id", delivery.order_id).order("version_number", { ascending: false }).limit(1).single(),
    ]);
    if (orderResult.error || previewResult.error || latestPreviewResult.error || !previewResult.data.review_deadline_at) {
      failed += 1;
      await db.from("notification_deliveries").update({ status: "failed", last_error_code: "record_unavailable", updated_at: new Date().toISOString() }).eq("id", delivery.id);
      await markWarning(delivery.order_id, "email_record_unavailable");
      continue;
    }
    const automaticIsCurrent = delivery.kind === "automatic_approval"
      && orderResult.data.approval_source === "automatic_72h"
      && orderResult.data.approved_preview_id === delivery.preview_id;
    const reviewIsCurrent = delivery.kind !== "automatic_approval"
      && orderResult.data.status === "preview_ready"
      && !previewResult.data.review_closed_at
      && latestPreviewResult.data.id === delivery.preview_id;
    if (!automaticIsCurrent && !reviewIsCurrent) {
      await db.from("notification_deliveries").update({ status: "cancelled", last_error_code: "review_state_changed", updated_at: new Date().toISOString() }).eq("id", delivery.id);
      continue;
    }
    try {
      const content = reviewEmail(delivery.kind, orderResult.data, previewResult.data.review_deadline_at);
      const result = await sendEmail({
        to: orderResult.data.customer_email,
        ...content,
        idempotencyKey: `pawtra-review-${delivery.id}`,
      });
      if (!result.sent) {
        skipped += 1;
        await db.from("notification_deliveries").update({ status: "failed", last_error_code: "email_not_configured", updated_at: new Date().toISOString() }).eq("id", delivery.id);
        await markWarning(delivery.order_id, "email_not_configured");
      } else {
        sent += 1;
        await db.from("notification_deliveries").update({ status: "sent", sent_at: new Date().toISOString(), last_error_code: null, updated_at: new Date().toISOString() }).eq("id", delivery.id);
      }
    } catch {
      failed += 1;
      await db.from("notification_deliveries").update({ status: "failed", last_error_code: "email_delivery_failed", available_at: new Date(Date.now() + 15 * 60_000).toISOString(), updated_at: new Date().toISOString() }).eq("id", delivery.id);
      await markWarning(delivery.order_id, "email_delivery_failed");
      console.error(JSON.stringify({ event: "review_email_failed", orderId: delivery.order_id, deliveryId: delivery.id }));
    }
  }
  return { claimed: (claimed.data || []).length, sent, failed, skipped };
}

export async function processReviewDeadlines(limit = 25, includeNotifications = true) {
  const db = getSupabaseAdmin();
  const reminders = await db.rpc("queue_due_review_reminders");
  if (reminders.error) throw new Error(`Reminder queue failed: ${reminders.error.message}`);
  const expiry = await db.rpc("process_expired_review_windows", { p_limit: limit });
  if (expiry.error) throw new Error(`Deadline processing failed: ${expiry.error.message}`);
  const result = expiry.data as { processed: number; orderIds: string[] };
  let shopifySynced = 0;
  let shopifyFailed = 0;
  for (const orderId of result.orderIds || []) {
    const orderResult = await db.from("orders").select("shopify_order_id,revision_count").eq("id", orderId).single();
    if (orderResult.error) continue;
    try {
      await syncOrderState(orderResult.data.shopify_order_id, {
        status: "approved", revisionCount: orderResult.data.revision_count, approved: true, productionReady: true,
      });
      shopifySynced += 1;
    } catch {
      shopifyFailed += 1;
      await markWarning(orderId, "shopify_sync_failed");
      console.error(JSON.stringify({ event: "shopify_sync_failed", orderId, transition: "automatic_approval" }));
    }
  }
  const notifications = includeNotifications ? await deliverReviewNotifications(limit) : null;
  console.info(JSON.stringify({ event: "review_deadline_run", processed: result.processed, shopifySynced, shopifyFailed, notificationCounts: notifications }));
  return { processed: result.processed, shopifySynced, shopifyFailed, notifications };
}
