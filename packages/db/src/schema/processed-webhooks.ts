import { pgTable, varchar, timestamp, uuid } from "drizzle-orm/pg-core";

export const processedWebhooks = pgTable("processed_webhooks", {
    id: uuid("id").defaultRandom().primaryKey(),
    webhookId: varchar("webhook_id", { length: 512 }).notNull().unique(),
    eventType: varchar("event_type", { length: 100 }).notNull(),
    processedAt: timestamp("processed_at").defaultNow().notNull(),
});
