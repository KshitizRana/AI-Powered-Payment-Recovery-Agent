const colors: Record<string, { bg: string; text: string; dot: string }> = {
    recovered: { bg: "bg-emerald-950", text: "text-emerald-400", dot: "bg-emerald-400" },
    detected: { bg: "bg-amber-950", text: "text-amber-400", dot: "bg-amber-400" },
    intervention_sent: { bg: "bg-blue-950", text: "text-blue-400", dot: "bg-blue-400" },
    abandoned: { bg: "bg-slate-800", text: "text-slate-400", dot: "bg-slate-500" },
    escalated: { bg: "bg-purple-950", text: "text-purple-400", dot: "bg-purple-400" },
};

export function StatusBadge({ status }: { status: string }) {
    const c = colors[status] || colors.detected;
    return (
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${c?.bg} ${c?.text}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${c?.dot}`} />
            {status.replace(/_/g, " ")}
        </span>
    );
}