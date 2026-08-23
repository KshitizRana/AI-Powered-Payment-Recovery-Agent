import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
    PORT: z.coerce.number(),
    RAZORPAY_KEY_ID: z.string(),
    RAZORPAY_KEY_SECRET: z.string(),
    RAZORPAY_WEBHOOK_SECRET: z.string(),
    DATABASE_URL: z.string(),
    OPENAI_API_KEY: z.string(),
    FRONTEND_URL: z.string(),


});

const env = envSchema.safeParse(process.env);

if (!env.success) {
    throw new Error("Environment variables are not set");
}

const config = {
    PORT: env.data.PORT,
    RAZORPAY_KEY_ID: env.data.RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET: env.data.RAZORPAY_KEY_SECRET,
    RAZORPAY_WEBHOOK_SECRET: env.data.RAZORPAY_WEBHOOK_SECRET,
    DATABASE_URL: env.data.DATABASE_URL,
    OPENAI_API_KEY: env.data.OPENAI_API_KEY,
    FRONTEND_URL: env.data.FRONTEND_URL,

};

export default config;
