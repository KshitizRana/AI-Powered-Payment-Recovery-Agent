import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import "dotenv/config";
import config from "./config/config";
import { AppError } from "./utils/appError";


const app = new Hono();

app.use("*", logger());
app.use(
    "*",
    cors({
        origin: ["http://localhost:3000"],
        allowMethods: ["GET", "POST", "PUT", "DELETE"],
        allowHeaders: ["Content-Type", "Authorization"],
    })
);

app.get("/", (c) => {
    return c.json({
        name: "AI Revenue Recovery Agent",
        version: "0.0.1",
        status: "running",
        timestamp: new Date().toISOString(),
    });
});

app.onError((err, c) => {
    if (err instanceof AppError) {
        return c.json({ success: false, error: err.message }, 500);
    }
    console.error("Unhandled error:", err);
    return c.json({ success: false, error: "Internal Server Error" }, 500);
});

const port = config.PORT;

console.log(`
AI Revenue Recovery Agent Server running on port: ${port}
`);

export default {
    port,
    fetch: app.fetch,
};
