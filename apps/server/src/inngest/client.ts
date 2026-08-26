import { Inngest } from "inngest";
import type { RecoveryEvents } from "@repo/shared";

// Create a typed Inngest client
export const inngest = new Inngest({
    id: "ai-revenue-recovery",
});
