import { pgTable, uuid, varchar, text, timestamp } from "drizzle-orm/pg-core";
import { recoveryAttempts } from "./recovery-attempts";

import { notificationChannelEnum, notificationStatusEnum } from "./enums";
import { recoveryActions } from "./recovery-actions";

export const notifications = pgTable("notifications", {
    id: uuid("id").defaultRandom().primaryKey(),

    recoveryAttemptId: uuid("recovery_attempt_id").references(() => recoveryAttempts.id),
    recoveryActionId: uuid("recovery_action_id").references(() => recoveryActions.id),

    channel: notificationChannelEnum("channel").notNull(),
    recipient: varchar("recipient", { length: 255 }).notNull(),
    subject: varchar("subject", { length: 500 }),
    content: text("content").notNull(),

    status: notificationStatusEnum("status").notNull(),
    externalId: varchar("external_id", { length: 255 }),

    sentAt: timestamp("sent_at"),
    deliveredAt: timestamp("delivered_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});
