"use client";
import { FormEvent, useMemo, useState } from "react";

type Preview = { id: string; versionNumber: number; label: string; imageUrl: string | null; createdAt: string };
type Revision = { id: string; message: string; status: string; created_at: string };
type Order = {
  order_number: string; customer_name?: string; status: string; revision_count: number;
  approved_preview_id?: string | null; approved_at?: string | null; remainingFreeRevisions: number;
  previews: Preview[]; revisions: Revision[]; canApprove: boolean; canRequestRevision: boolean;
};

const labels: Record<string, string> = {
  artwork_in_progress: "Artwork in progress", preview_ready: "Preview ready", revision_requested: "Revision requested",
  approved: "Approved", in_production: "In production", shipped: "Shipped",
};

export default function Track() {
  const [orderNumber, setOrderNumber] = useState("");
  const [email, setEmail] = useState("");
  const [order, setOrder] = useState<Order | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const preview = useMemo(() => order?.previews.find((item) => item.id === selected) || order?.previews.at(-1), [order, selected]);

  async function lookup(e?: FormEvent) {
    e?.preventDefault(); setBusy(true); setMessage("");
    const response = await fetch("/api/customer/lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderNumber, email }) });
    const body = await response.json(); setBusy(false);
    if (!response.ok) { setMessage(body.error || "Order not found."); return; }
    setOrder(body.order); setSelected(body.order.approved_preview_id || body.order.previews.at(-1)?.id || null);
  }

  async function approve() {
    if (!selected || !confirm("Approve this artwork? Approval is final and production may begin.")) return;
    setBusy(true); setMessage("");
    const response = await fetch("/api/customer/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderNumber, email, previewId: selected }) });
    const body = await response.json(); setBusy(false); setMessage(response.ok ? "Your artwork has been approved. Thank you!" : body.error);
    if (response.ok) await lookup();
  }

  async function revision() {
    if (!selected) return;
    setBusy(true); setMessage("");
    const response = await fetch("/api/customer/revision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderNumber, email, previewId: selected, message: note }) });
    const body = await response.json(); setBusy(false); setMessage(response.ok ? "Your revision request has been sent." : body.error);
    if (response.ok) { setNote(""); await lookup(); }
  }

  if (!order) return <main className="container page-space">
    <section className="hero compact"><span className="eyebrow">PAWTRA ARTWORK PORTAL</span><h1>Track My Order</h1><p className="muted">Enter the order number and email used at checkout.</p></section>
    <form className="card lookup-card grid" onSubmit={lookup}>
      <label>Order number<input placeholder="#1048" value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} required /></label>
      <label>Email address<input type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
      <button className="btn primary" disabled={busy}>{busy ? "Checking…" : "View Artwork"}</button>
      {message && <p className="notice error">{message}</p>}
    </form>
  </main>;

  return <main className="container page-space">
    <div className="topline"><div><span className="eyebrow">ORDER #{order.order_number}</span><h1>{order.customer_name ? `${order.customer_name}'s Artwork` : "Your Artwork"}</h1></div><button className="btn secondary" onClick={() => { setOrder(null); setMessage(""); }}>Check another order</button></div>
    <div className="status-strip"><strong>{labels[order.status] || order.status}</strong><span>{order.approved_at ? "Artwork approval completed" : `${order.remainingFreeRevisions} free revision round${order.remainingFreeRevisions === 1 ? "" : "s"} remaining`}</span></div>
    {message && <p className="notice success">{message}</p>}
    <div className="layout">
      <section className="card artwork-card">
        {preview?.imageUrl ? <img className="preview" src={preview.imageUrl} alt={preview.label} /> : <div className="empty-state"><h2>Your preview is being prepared</h2><p>We will email you as soon as it is ready.</p></div>}
        {order.previews.length > 1 && <div className="thumbs">{order.previews.map((item) => <button className={`thumb ${selected === item.id ? "active" : ""}`} key={item.id} onClick={() => setSelected(item.id)}>{item.imageUrl && <img src={item.imageUrl} alt="" />}<small>{item.label}</small></button>)}</div>}
      </section>
      <aside className="card action-card grid">
        <div><span className="eyebrow">SELECTED VERSION</span><h2>{preview?.label || "Not ready"}</h2></div>
        {order.approved_at ? <div className="approved-box"><strong>Approved</strong><p>This design is locked and ready for production.</p></div> : <>
          <button className="btn gold" disabled={!order.canApprove || busy} onClick={approve}>Approve selected design</button>
          <div className="divider"><span>or request changes</span></div>
          <textarea rows={6} placeholder="Describe exactly what you would like changed…" value={note} onChange={(e) => setNote(e.target.value)} disabled={!order.canRequestRevision || busy} />
          <button className="btn primary" disabled={!order.canRequestRevision || busy || note.trim().length < 5} onClick={revision}>Request revision</button>
          {!order.canRequestRevision && order.status === "revision_requested" && <p className="muted small">Your current revision request is being worked on.</p>}
        </>}
        {order.revisions.length > 0 && <details><summary>Revision history</summary>{order.revisions.map((item) => <div className="history" key={item.id}><strong>{item.status === "open" ? "Open request" : "Completed"}</strong><p>{item.message}</p></div>)}</details>}
      </aside>
    </div>
  </main>;
}
