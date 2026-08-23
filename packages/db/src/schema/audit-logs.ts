import { pgTable, uuid, varchar, text, timestamp, jsonb } from "drizzle-orm/pg-core";

import { auditActorEnum } from "./enums";
import { recoveryAttempts } from "./recovery-attempts";

export const auditLogs = pgTable("audit_logs", {
    id: uuid("id").defaultRandom().primaryKey(),

    recoveryAttemptId: uuid("recovery_attempt_id").references(() => recoveryAttempts.id),

    eventType: varchar("event_type", { length: 100 }).notNull(),
    actor: auditActorEnum("actor").notNull(),
    action: text("action").notNull(),
    details: jsonb("details"),

    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
