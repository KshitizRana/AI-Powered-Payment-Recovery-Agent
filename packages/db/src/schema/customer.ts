import { pgTable, uuid, varchar, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { notificationChannelEnum } from "./enums";

export const customers = pgTable("customers", {
    id: uuid("id").defaultRandom().primaryKey(),
    razorpayCustomerId: varchar("razorpay_customer_id", { length: 255 }).unique(),

    email: varchar("email", { length: 255 }),
    phone: varchar("phone", { length: 20 }),
    name: varchar("name", { length: 255 }),

    // Recovery intelligence
    totalRecoveryAttempts: integer("total_recovery_attempts").default(0).notNull(),
    successfulRecoveries: integer("successful_recoveries").default(0).notNull(),
    optedOut: boolean("opted_out").default(false).notNull(),
    preferredChannel: notificationChannelEnum("preferred_channel"),

    lastContactedAt: timestamp("last_contacted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
