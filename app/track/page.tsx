"use client";

import { FormEvent, useMemo, useState } from "react";
import { OrderTimeline } from "./status-timeline";

type Preview = {
  id: string;
  versionNumber: number;
  label: string;
  imageUrl: string | null;
  createdAt: string;
};

type Revision = {
  id: string;
  message: string;
  status: string;
  created_at: string;
};

type Order = {
  order_number: string;
  customer_name?: string;
  status: string;
  revision_count: number;
  approved_preview_id?: string | null;
  approved_at?: string | null;
  remainingFreeRevisions: number;
  previews: Preview[];
  revisions: Revision[];
  canApprove: boolean;
  canRequestRevision: boolean;
};

const labels: Record<string, string> = {
  artwork_in_progress: "Artwork in progress",
  preview_ready: "Ready for your review",
  revision_requested: "Revision in progress",
  approved: "Artwork approved",
  in_production: "In production",
  shipped: "On its way",
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

export default function Track() {
  const [orderNumber, setOrderNumber] = useState("");
  const [email, setEmail] = useState("");
  const [order, setOrder] = useState<Order | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<"success" | "error">("error");
  const [busy, setBusy] = useState(false);

  const preview = useMemo(
    () => order?.previews.find((item) => item.id === selected) || order?.previews.at(-1),
    [order, selected],
  );
  const latestPreviewId = order?.previews.at(-1)?.id;
  const latestSelected = Boolean(selected && selected === latestPreviewId);

  async function lookup(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setMessage("");

    try {
      const response = await fetch("/api/customer/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderNumber, email }),
      });
      const body = await response.json();

      if (!response.ok) {
        setMessageKind("error");
        setMessage(body.error || "We couldn’t find that order. Please check your details and try again.");
        return;
      }

      setOrder(body.order);
      setSelected(body.order.approved_preview_id || body.order.previews.at(-1)?.id || null);
    } catch {
      setMessageKind("error");
      setMessage("We couldn’t connect just now. Please try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!selected || !window.confirm("Approve this artwork? Approval is final and production may begin.")) return;
    setBusy(true);
    setMessage("");

    try {
      const response = await fetch("/api/customer/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderNumber, email, previewId: selected }),
      });
      const body = await response.json();
      setMessageKind(response.ok ? "success" : "error");
      setMessage(response.ok ? "Your artwork is approved — we’ll take it from here." : body.error);
      if (response.ok) await lookup();
    } catch {
      setMessageKind("error");
      setMessage("Approval couldn’t be completed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function revision() {
    if (!selected) return;
    setBusy(true);
    setMessage("");

    try {
      const response = await fetch("/api/customer/revision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderNumber, email, previewId: selected, message: note }),
      });
      const body = await response.json();
      setMessageKind(response.ok ? "success" : "error");
      setMessage(response.ok ? "Your notes are with our artist. We’ll let you know when the update is ready." : body.error);
      if (response.ok) {
        setNote("");
        await lookup();
      }
    } catch {
      setMessageKind("error");
      setMessage("Your revision request couldn’t be sent. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  function resetLookup() {
    setOrder(null);
    setSelected(null);
    setMessage("");
    setNote("");
  }

  if (!order) {
    return (
      <main className="track-shell">
        <section className="track-lookup" aria-labelledby="track-heading">
          <div className="track-intro">
            <span className="track-kicker">Custom artwork portal</span>
            <h1 id="track-heading">Your portrait,<br /><em>made together.</em></h1>
            <p>Follow your order, review each artwork preview and share feedback with your Pawtra artist.</p>

            <ol className="track-benefits" aria-label="How artwork approval works">
              <li><span>1</span><div><strong>We create</strong><small>Your artist prepares a one-of-a-kind portrait.</small></div></li>
              <li><span>2</span><div><strong>You review</strong><small>Approve it or request up to three revisions.</small></div></li>
              <li><span>3</span><div><strong>We make it real</strong><small>Once approved, your piece moves to production.</small></div></li>
            </ol>
          </div>

          <div className="track-lookup-panel">
            <div className="track-panel-heading">
              <span className="track-paw" aria-hidden="true">P</span>
              <div>
                <p className="track-overline">Find your artwork</p>
                <h2>Track my order</h2>
              </div>
            </div>
            <p className="track-form-help">Use the same email address you entered at checkout.</p>

            <form className="track-form" onSubmit={lookup}>
              <label htmlFor="order-number">Order number</label>
              <div className="track-input-wrap order-input">
                <span aria-hidden="true">#</span>
                <input
                  id="order-number"
                  autoComplete="off"
                  inputMode="text"
                  placeholder="1048"
                  value={orderNumber}
                  onChange={(event) => setOrderNumber(event.target.value)}
                  required
                />
              </div>

              <label htmlFor="order-email">Email address</label>
              <input
                id="order-email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />

              <button className="track-button track-button-primary" disabled={busy} type="submit">
                {busy ? <><span className="track-spinner" aria-hidden="true" />Finding your order…</> : <>View my artwork <span aria-hidden="true">→</span></>}
              </button>

              {message && <p className={`track-alert ${messageKind}`} role="alert">{message}</p>}
            </form>

            <p className="track-secure"><span aria-hidden="true">✓</span> Your order details are private and secure</p>
            <p className="track-support">Can’t find your order? <a href="mailto:hello@pawtra.net">We’re happy to help</a>.</p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="track-shell track-order-page">
      <section className="track-order-head">
        <div>
          <button className="track-back" onClick={resetLookup} type="button">← Check another order</button>
          <p className="track-overline">Order #{order.order_number}</p>
          <h1>{order.customer_name ? `${order.customer_name}’s portrait` : "Your custom portrait"}</h1>
          <p>Every detail is made with care. Take your time and make sure it feels just right.</p>
        </div>
        <div className={`track-status-pill status-${order.status}`}>
          <span aria-hidden="true" />
          {labels[order.status] || order.status}
        </div>
      </section>

      <OrderTimeline status={order.status} />

      {message && <p className={`track-alert track-page-alert ${messageKind}`} role="status">{message}</p>}

      <div className="track-review-layout">
        <section className="track-artwork-panel" aria-label="Artwork preview">
          <div className="track-artwork-meta">
            <div>
              <p className="track-overline">Artwork preview</p>
              <h2>{preview?.label || "In the works"}</h2>
            </div>
            {preview?.createdAt && <time dateTime={preview.createdAt}>{formatDate(preview.createdAt)}</time>}
          </div>

          <div className="track-artwork-stage">
            {preview?.imageUrl ? (
              // Signed Supabase URLs are short-lived and cannot use a fixed Next Image host pattern.
              <img className="track-preview" src={preview.imageUrl} alt={`${preview.label} for order ${order.order_number}`} />
            ) : (
              <div className="track-empty-state">
                <span aria-hidden="true">✦</span>
                <h2>Your portrait is taking shape</h2>
                <p>Our artist is working on the details. We’ll email you as soon as your first preview is ready.</p>
              </div>
            )}
          </div>

          {order.previews.length > 1 && (
            <div className="track-version-picker">
              <p className="track-overline">Previous versions</p>
              <div className="track-thumbs" role="list">
                {order.previews.map((item) => (
                  <button
                    className={`track-thumb ${selected === item.id ? "active" : ""}`}
                    key={item.id}
                    onClick={() => setSelected(item.id)}
                    type="button"
                    aria-pressed={selected === item.id}
                  >
                    {item.imageUrl && (
                      <img src={item.imageUrl} alt="" />
                    )}
                    <span><strong>{item.label}</strong><small>{formatDate(item.createdAt)}</small></span>
                    {selected === item.id && <i aria-hidden="true">✓</i>}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>

        <aside className="track-decision-panel" aria-label="Artwork approval">
          {order.approved_at ? (
            <div className="track-approved-state">
              <span className="track-approved-mark" aria-hidden="true">✓</span>
              <p className="track-overline">All set</p>
              <h2>You approved this design</h2>
              <p>Your artwork is locked and ready for the next stage. We’ll keep you updated as your order moves forward.</p>
              <div><span>Approved artwork</span><strong>{preview?.label}</strong></div>
            </div>
          ) : preview ? (
            <>
              <div className="track-decision-heading">
                <p className="track-overline">Your decision</p>
                <h2>Love what you see?</h2>
                <p>Approve the latest version to send your artwork into production.</p>
              </div>

              <button className="track-button track-button-approve" disabled={!order.canApprove || busy || !latestSelected} onClick={approve} type="button">
                <span aria-hidden="true">✓</span> Approve this artwork
              </button>
              <p className="track-final-note">Approval is final, so please check every detail.</p>

              <div className="track-divider"><span>or refine it</span></div>

              <label className="track-revision-label" htmlFor="revision-note">What would you like us to change?</label>
              <textarea
                id="revision-note"
                rows={5}
                maxLength={2000}
                placeholder="For example: Please make the background a little lighter…"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                disabled={!order.canRequestRevision || busy || !latestSelected}
              />
              <div className="track-revision-meta">
                <span>{order.remainingFreeRevisions} of 3 free revisions left</span>
                <span>{note.length}/2000</span>
              </div>
              <button
                className="track-button track-button-outline"
                disabled={!order.canRequestRevision || busy || !latestSelected || note.trim().length < 5}
                onClick={revision}
                type="button"
              >
                {busy ? "Sending…" : "Send revision request"}
              </button>

              {!latestSelected && <p className="track-context-note">You’re viewing an older version. Select the latest artwork to approve it or request changes.</p>}
              {!order.canRequestRevision && order.status === "revision_requested" && <p className="track-context-note">Your artist has your notes and is preparing the next version.</p>}
            </>
          ) : (
            <div className="track-waiting-card">
              <p className="track-overline">What happens next</p>
              <h2>We’ll invite you to review</h2>
              <p>Once your preview is ready, you can approve it here or send clear revision notes to your artist.</p>
            </div>
          )}

          {order.revisions.length > 0 && (
            <details className="track-history">
              <summary>Revision history <span>{order.revisions.length}</span></summary>
              <div className="track-history-list">
                {order.revisions.map((item) => (
                  <article key={item.id}>
                    <div><strong>{item.status === "open" ? "In progress" : "Completed"}</strong><time dateTime={item.created_at}>{formatDate(item.created_at)}</time></div>
                    <p>{item.message}</p>
                  </article>
                ))}
              </div>
            </details>
          )}
        </aside>
      </div>

      <section className="track-help-bar">
        <div><span aria-hidden="true">?</span><p><strong>Need a hand?</strong><br />Our friendly team is here for you.</p></div>
        <a href="mailto:hello@pawtra.net">Contact Pawtra support →</a>
      </section>
    </main>
  );
}
