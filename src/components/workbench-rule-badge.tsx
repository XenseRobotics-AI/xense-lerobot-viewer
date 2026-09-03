import type { WorkbenchRewardPreview } from "@/utils/workbenchRewards";

const RULE_TONE_CLASSES: Record<WorkbenchRewardPreview["symbol"], string> = {
  "✅": "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  "❌": "border-red-400/30 bg-red-400/10 text-red-200",
  "…": "border-amber-400/30 bg-amber-400/10 text-amber-200",
  "—": "border-white/10 bg-white/[0.04] text-slate-400",
};

export default function WorkbenchRuleBadge({
  label,
  symbol,
}: {
  label?: string | null;
  symbol: WorkbenchRewardPreview["symbol"];
}) {
  const text = label?.trim() || symbol;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium ${RULE_TONE_CLASSES[symbol]}`}
      title={`${text} ${symbol}`}
    >
      <span aria-hidden="true">{symbol}</span>
      <span>{text}</span>
    </span>
  );
}
