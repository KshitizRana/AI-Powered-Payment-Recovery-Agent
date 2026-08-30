"use client";

import { useRecoveryDetail } from "../../../lib/hooks";
import { StatusBadge } from "../../../components/status-badge";
import { format } from "date-fns";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Bot, Clock, CreditCard } from "lucide-react";

export default function RecoveryDetailPage() {
    const { id } = useParams<{ id: string }>();
    const { data, isLoading, error } = useRecoveryDetail(id);

    if (isLoading) {
        return <div className="min-h-screen flex items-center justify-center text-[var(--text-dim)]">Loading...</div>;
    }
    if (error || !data?.recovery) {
        return <div className="min-h-screen flex items-center justify-center text-[var(--danger)]">Recovery not found</div>;
    }

    const { recovery, customer, actions, timeline } = data;

    return (
        <main className="min-h-screen p-6 md:p-8 max-w-5xl mx-auto space-y-6">
            {/* Back */}
            <Link
                href="/"
                className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
            >
                <ArrowLeft className="w-4 h-4" /> Back
            </Link>

            {/* Header Card */}
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-6">
                <div className="flex items-start justify-between">
                    <div>
                        <h1 className="text-xl font-bold">
                            {recovery.type === "subscription_renewal" ? "Subscription" : "Checkout"} Recovery
                        </h1>
                        <p className="text-[var(--text-dim)] text-xs mt-1 font-mono">{recovery.id}</p>
                    </div>
                    <StatusBadge status={recovery.status} />
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mt-6 pt-5 border-t border-[var(--border)]">
                    <Detail label="Customer" value={customer?.email || "Guest"} />
                    <Detail label="Amount at Risk" value={`₹${(recovery.amountAtRisk / 100).toLocaleString("en-IN")}`} />
                    <Detail label="Failure" value={recovery.failureCategory?.replace(/_/g, " ") || "unknown"} />
                    <Detail label="Decline Code" value={recovery.declineCode || "—"} />
                    <Detail label="Step" value={`${recovery.currentStep} / ${recovery.maxSteps}`} />
                    <Detail label="Currency" value={recovery.currency} />
                    <Detail label="Started" value={format(new Date(recovery.createdAt), "MMM d, h:mm a")} />
                    <Detail
                        label="Recovered"
                        value={recovery.recoveredAt
                            ? `₹${(recovery.amountRecovered / 100).toLocaleString("en-IN")} on ${format(new Date(recovery.recoveredAt), "MMM d")}`
                            : "—"}
                    />
                </div>
            </div>

            {/* Two Columns: Actions + Timeline */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* AI Interventions */}
                <div className="space-y-4">
                    <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--text-dim)]">
                        AI Interventions ({actions.length})
                    </h2>

                    {actions.length === 0 ? (
                        <EmptyState text="No interventions yet — the agent hasn't acted." />
                    ) : (
                        actions.map((action: any) => (
                            <div key={action.id} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4 space-y-3">
                                <div className="flex items-center justify-between">
                                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-400 bg-blue-950 px-2.5 py-1 rounded-md">
                                        <Bot className="w-3.5 h-3.5" />
                                        Step {action.stepNumber}: {action.actionType.replace(/_/g, " ")}
                                    </span>
                                    <span className="text-[10px] text-[var(--text-dim)] uppercase">
                                        {action.channel || "—"}
                                    </span>
                                </div>

                                {/* AI Reasoning */}
                                <div className="bg-[var(--bg)] border border-[var(--border)] rounded-lg p-3 text-xs">
                                    <span className="block text-[var(--text-dim)] text-[10px] uppercase tracking-wider mb-1">AI Reasoning</span>
                                    <p className="text-[var(--text-muted)]">{action.aiReasoning}</p>
                                </div>

                                {/* Message Content */}
                                {action.messageContent && (
                                    <div className="border-l-2 border-[var(--border)] pl-3">
                                        <span className="block text-[10px] text-[var(--text-dim)] uppercase tracking-wider mb-1">Message Sent</span>
                                        <p className="text-xs text-[var(--text-muted)] whitespace-pre-wrap">{action.messageContent}</p>
                                    </div>
                                )}

                                {/* Payment Link */}
                                {action.paymentLinkUrl && (
                                    <div className="flex items-center gap-2 text-xs text-[var(--accent)]">
                                        <CreditCard className="w-3.5 h-3.5" />
                                        <a href={action.paymentLinkUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">
                                            {action.paymentLinkUrl}
                                        </a>
                                    </div>
                                )}
                            </div>
                        ))
                    )}
                </div>

                {/* Audit Timeline */}
                <div className="space-y-4">
                    <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--text-dim)]">
                        Audit Trail ({timeline.length})
                    </h2>

                    {timeline.length === 0 ? (
                        <EmptyState text="No audit entries yet." />
                    ) : (
                        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-5 space-y-5">
                            {timeline.map((log: any, i: number) => (
                                <div key={log.id} className="relative pl-5">
                                    {/* Vertical line */}
                                    {i < timeline.length - 1 && (
                                        <div className="absolute left-[7px] top-5 bottom-[-20px] w-px bg-[var(--border)]" />
                                    )}
                                    {/* Dot */}
                                    <div className={`absolute left-0 top-1.5 w-[14px] h-[14px] rounded-full border-2 border-[var(--bg-card)] ${log.eventType.includes("completed") || log.eventType.includes("recovered") ? "bg-emerald-500" :
                                        log.eventType.includes("abandoned") || log.eventType.includes("blocked") ? "bg-amber-500" :
                                            log.eventType.includes("escalated") ? "bg-purple-500" :
                                                "bg-blue-500"
                                        }`} />

                                    <div>
                                        <p className="text-xs text-[var(--text)]">{log.action}</p>
                                        <div className="flex items-center gap-3 mt-1">
                                            <span className="flex items-center gap-1 text-[10px] text-[var(--text-dim)]">
                                                <Clock className="w-3 h-3" />
                                                {format(new Date(log.createdAt), "MMM d, h:mm:ss a")}
                                            </span>
                                            <span className="text-[10px] text-[var(--text-dim)] uppercase bg-[var(--bg)] px-1.5 py-0.5 rounded font-medium">
                                                {log.actor}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </main>
    );
}

// ─── Small components ───

function Detail({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <p className="text-[10px] text-[var(--text-dim)] uppercase tracking-wider">{label}</p>
            <p className="text-sm font-medium mt-0.5 capitalize">{value}</p>
        </div>
    );
}

function EmptyState({ text }: { text: string }) {
    return (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-8 text-center">
            <p className="text-xs text-[var(--text-dim)] italic">{text}</p>
        </div>
    );
}