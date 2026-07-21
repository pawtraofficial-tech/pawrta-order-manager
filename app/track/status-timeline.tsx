const steps = [
  { key: "artwork_in_progress", label: "Order received" },
  { key: "preview_ready", label: "Artwork review" },
  { key: "approved", label: "Approved" },
  { key: "in_production", label: "In production" },
  { key: "shipped", label: "Shipped" },
] as const;

const statusPosition: Record<string, number> = {
  artwork_in_progress: 0,
  preview_ready: 1,
  revision_requested: 1,
  approved: 2,
  in_production: 3,
  shipped: 4,
};

interface OrderTimelineProps {
  status: string;
}

export function OrderTimeline({ status }: OrderTimelineProps) {
  const current = statusPosition[status] ?? 0;

  return (
    <nav className="track-timeline" aria-label="Order progress">
      <ol>
        {steps.map((step, index) => {
          const complete = index < current;
          const active = index === current;
          return (
            <li className={complete ? "complete" : active ? "active" : ""} key={step.key} aria-current={active ? "step" : undefined}>
              <span className="track-step-dot" aria-hidden="true">{complete ? "✓" : index + 1}</span>
              <span>{step.label}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
