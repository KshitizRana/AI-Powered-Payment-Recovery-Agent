import { pgTable, uuid, varchar, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { recoveryAttempts } from "./recovery-attempts";
import { actionTypeEnum, actionStatusEnum, notificationChannelEnum } from "./enums";

export const recoveryActions = pgTable("recovery_actions", {
    id: uuid("id").defaultRandom().primaryKey(),

    recoveryAttemptId: uuid("recovery_attempt_id")
        .references(() => recoveryAttempts.id)
        .notNull(),

    stepNumber: integer("step_number").notNull(),
    actionType: actionTypeEnum("action_type").notNull(),
    status: actionStatusEnum("status").notNull(),

    aiReasoning: text("ai_reasoning"),
    channel: notificationChannelEnum("channel"),
    messageContent: text("message_content"),

    paymentLinkId: varchar("payment_link_id", { length: 255 }),
    paymentLinkUrl: varchar("payment_link_url", { length: 1024 }),

    response: jsonb("response"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});