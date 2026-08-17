/**
 * The quiet stand-in every limits-over-time view shows before quota history
 * has accumulated.
 *
 * History only starts building once the collection layer has seen a probe, so
 * an empty state here is the normal first-run condition rather than a fault.
 * It says so plainly and takes up roughly the height of the chart it replaces,
 * so filling in later does not shove the rest of the page around.
 */
export function QuotaHistoryEmpty({
  message = "No quota history yet",
  detail,
  short = false,
}: {
  readonly message?: string;
  readonly detail?: string;
  readonly short?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-1 border border-dashed border-border px-4 text-center ${
        short ? "py-6" : "py-16"
      }`}
    >
      <span className="text-xs text-muted-foreground">{message}</span>
      {detail === undefined ? null : (
        <span className="text-[10px] text-muted-foreground/80">{detail}</span>
      )}
    </div>
  );
}
