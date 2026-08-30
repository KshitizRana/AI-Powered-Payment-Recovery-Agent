"use client";

import { useMetrics, useRecoveryList } from "../lib/hooks";
import { endpoints } from "../lib/api";
import { StatusBadge } from "../components/status-badge";
import { formatDistanceToNow } from "date-fns";
import Link from "next/link";
import { useState } from "react";
import {
  IndianRupee, TrendingUp, Activity, CheckCircle2,
  ArrowUpRight, Zap, RotateCcw,
} from "lucide-react";

export default function Dashboard() {
  const { data: metrics, isLoading: metricsLoading } = useMetrics();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const { data: listData, isLoading: listLoading } = useRecoveryList(page, statusFilter);

  return (
    <main className="min-h-screen p-6 md:p-8 max-w-[1400px] mx-auto space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">AI Recovery Agent</h1>
          <p className="text-[var(--text-muted)] text-sm mt-1">
            Autonomous payment recovery — live dashboard
          </p>
        </div>
        <SimulateButton />
      </div>

      {/* Hero Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard
          label="₹ Recovered"
          value={metrics ? `₹${(metrics.totalRecoveredPaise / 100).toLocaleString("en-IN")}` : "—"}
          icon={<IndianRupee className="w-4 h-4" />}
          color="text-emerald-400"
          loading={metricsLoading}
        />
        <MetricCard
          label="Recovery Rate"
          value={metrics ? `${metrics.recoveryRate}%` : "—"}
          icon={<TrendingUp className="w-4 h-4" />}
          color="text-blue-400"
          loading={metricsLoading}
        />
        <MetricCard
          label="Active Workflows"
          value={metrics?.activeWorkflows ?? "—"}
          icon={<Activity className="w-4 h-4" />}
          color="text-purple-400"
          loading={metricsLoading}
        />
        <MetricCard
          label="₹ at Risk"
          value={metrics ? `₹${(metrics.totalAtRiskPaise / 100).toLocaleString("en-IN")}` : "—"}
          icon={<Zap className="w-4 h-4" />}
          color="text-amber-400"
          loading={metricsLoading}
        />
      </div>

      {/* Status Filter Tabs */}
      <div className="flex gap-2 flex-wrap">
        {[undefined, "recovered", "intervention_sent", "detected", "abandoned", "escalated"].map((s) => (
          <button
            key={s || "all"}
            onClick={() => { setStatusFilter(s); setPage(1); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${statusFilter === s
                ? "bg-[var(--accent)] text-white border-[var(--accent)]"
                : "bg-[var(--bg-card)] text-[var(--text-muted)] border-[var(--border)] hover:bg-[var(--bg-card-hover)]"
              }`}
          >
            {s ? s.replace(/_/g, " ") : "all"}
          </button>
        ))}
      </div>

      {/* Recoveries Table */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[var(--text-dim)] text-xs uppercase tracking-wider">
                <th className="px-5 py-3 text-left">Customer</th>
                <th className="px-5 py-3 text-left">Type</th>
                <th className="px-5 py-3 text-left">Amount</th>
                <th className="px-5 py-3 text-left">Status</th>
                <th className="px-5 py-3 text-left">Step</th>
                <th className="px-5 py-3 text-left">Time</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {listLoading && (
                <tr><td colSpan={7} className="px-5 py-10 text-center text-[var(--text-dim)]">Loading...</td></tr>
              )}
              {listData?.data?.map((item: any) => (
                <tr key={item.id} className="border-b border-[var(--border)] hover:bg-[var(--bg-card-hover)] transition-colors">
                  <td className="px-5 py-3.5 font-medium">{item.customerEmail || "Guest"}</td>
                  <td className="px-5 py-3.5 text-[var(--text-muted)]">
                    {item.type === "subscription_renewal" ? "Subscription" : "Checkout"}
                  </td>
                  <td className="px-5 py-3.5 font-mono">
                    ₹{(item.amountAtRisk / 100).toLocaleString("en-IN")}
                  </td>
                  <td className="px-5 py-3.5">
                    <StatusBadge status={item.status} />
                  </td>
                  <td className="px-5 py-3.5 text-[var(--text-muted)]">
                    {item.currentStep}/{item.maxSteps}
                  </td>
                  <td className="px-5 py-3.5 text-[var(--text-dim)] whitespace-nowrap">
                    {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <Link
                      href={`/recovery/${item.id}`}
                      className="inline-flex items-center gap-1 text-[var(--accent)] hover:text-[var(--accent-hover)] text-xs font-medium transition-colors"
                    >
                      View <ArrowUpRight className="w-3.5 h-3.5" />
                    </Link>
                  </td>
                </tr>
              ))}
              {listData?.data?.length === 0 && (
                <tr><td colSpan={7} className="px-5 py-10 text-center text-[var(--text-dim)] italic">No recovery attempts yet. Use the Simulate button to create one.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {listData?.pagination && listData.pagination.totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-[var(--border)]">
            <span className="text-xs text-[var(--text-dim)]">
              Page {listData.pagination.page} of {listData.pagination.totalPages} ({listData.pagination.total} total)
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(Math.max(1, page - 1))}
                disabled={page === 1}
                className="px-3 py-1 text-xs rounded-md bg-[var(--bg)] border border-[var(--border)] disabled:opacity-30"
              >
                Previous
              </button>
              <button
                onClick={() => setPage(page + 1)}
                disabled={page >= listData.pagination.totalPages}
                className="px-3 py-1 text-xs rounded-md bg-[var(--bg)] border border-[var(--border)] disabled:opacity-30"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

// ─── Components ───

function MetricCard({ label, value, icon, color, loading }: {
  label: string; value: string | number; icon: React.ReactNode; color: string; loading: boolean;
}) {
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-[var(--text-dim)] uppercase tracking-wider">{label}</span>
        <span className={color}>{icon}</span>
      </div>
      <span className={`text-2xl font-bold tracking-tight ${loading ? "animate-pulse text-[var(--text-dim)]" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function SimulateButton() {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);

  const simulate = async (type: string, extra?: Record<string, any>) => {
    setSending(true);
    try {
      await fetch(endpoints.simulate, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, ...extra }),
      });
    } catch (e) {
      console.error("Simulation failed:", e);
    } finally {
      setSending(false);
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--accent)] text-white text-sm font-medium hover:bg-[var(--accent-hover)] transition-colors"
      >
        <Zap className="w-4 h-4" /> Simulate
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-72 bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl p-4 z-50 space-y-2">
          <p className="text-xs text-[var(--text-dim)] mb-3 font-medium uppercase tracking-wider">Trigger Test Event</p>
          <SimButton
            label="Soft Decline (₹999)"
            desc="Insufficient balance — AI will retry"
            onClick={() => simulate("subscription_soft_decline", { amount: 99900 })}
            disabled={sending}
          />
          <SimButton
            label="Hard Decline (₹1,499)"
            desc="Card expired — AI sends payment link"
            onClick={() => simulate("subscription_hard_decline", { amount: 149900 })}
            disabled={sending}
          />
          <SimButton
            label="High-Value (₹7,500)"
            desc="Will escalate to human after 5 steps"
            onClick={() => simulate("subscription_soft_decline", { amount: 750000 })}
            disabled={sending}
          />
          <SimButton
            label="Checkout Abandoned (₹2,499)"
            desc="UPI checkout drop-off"
            onClick={() => simulate("checkout_abandoned", { amount: 249900, method: "upi" })}
            disabled={sending}
          />
        </div>
      )}
    </div>
  );
}

function SimButton({ label, desc, onClick, disabled }: {
  label: string; desc: string; onClick: () => void; disabled: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full text-left p-3 rounded-lg border border-[var(--border)] hover:bg-[var(--bg-card-hover)] transition-colors disabled:opacity-50"
    >
      <span className="block text-sm font-medium">{label}</span>
      <span className="block text-xs text-[var(--text-dim)] mt-0.5">{desc}</span>
    </button>
  );
}