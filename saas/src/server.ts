import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { timing } from "hono/timing";
import { HTTPException } from "hono/http-exception";
import { env } from "./config/env.js";
import { createDbClient } from "./db/client.js";
import { createAuthRoutes } from "./api/routes/auth.js";
import { createAgentRoutes } from "./api/routes/agent.js";
import { createUsageRoutes } from "./api/routes/usage.js";
import { createBillingRoutes } from "./api/routes/billing.js";
import { getHealthMonitor } from "./orchestrator/health-monitor.js";

// Create database client
const db = createDbClient();

// Health monitor (only in production with Kubernetes)
const healthMonitor = env.KUBERNETES_IN_CLUSTER ? getHealthMonitor(db) : null;

// Create Hono app
const app = new Hono();

// Global middleware
app.use("*", logger());
app.use("*", timing());
app.use("*", secureHeaders());
app.use(
	"*",
	cors({
		origin: env.FRONTEND_URL,
		credentials: true,
		allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
		exposeHeaders: ["X-Request-Id", "X-RateLimit-Remaining"],
		maxAge: 86400,
	})
);

// Health check
app.get("/health", (c) => {
	return c.json({
		status: "ok",
		timestamp: new Date().toISOString(),
		version: process.env["npm_package_version"] ?? "unknown",
	});
});

// API routes
app.route("/api/auth", createAuthRoutes(db));
app.route("/api/agent", createAgentRoutes(db));
app.route("/api/usage", createUsageRoutes(db));
app.route("/api/billing", createBillingRoutes(db));

// 404 handler
app.notFound((c) => {
	return c.json(
		{
			error: "Not Found",
			message: `Route ${c.req.method} ${c.req.path} not found`,
		},
		404
	);
});

// Global error handler
app.onError((err, c) => {
	console.error("Unhandled error:", err);

	if (err instanceof HTTPException) {
		return c.json(
			{
				error: err.message,
			},
			err.status
		);
	}

	// Don't expose internal errors in production
	const message =
		env.NODE_ENV === "production"
			? "Internal server error"
			: err.message;

	return c.json(
		{
			error: message,
		},
		500
	);
});

// Start server
console.log(`Starting Moltbot SaaS API server...`);
console.log(`Environment: ${env.NODE_ENV}`);
console.log(`Listening on http://${env.HOST}:${env.PORT}`);

serve({
	fetch: app.fetch,
	hostname: env.HOST,
	port: env.PORT,
});

// Start health monitor in production
if (healthMonitor) {
	healthMonitor.start();
	console.log("Health monitor started");
}

// Graceful shutdown
process.on("SIGTERM", async () => {
	console.log("SIGTERM received, shutting down...");
	healthMonitor?.stop();
	await db.end();
	process.exit(0);
});

process.on("SIGINT", async () => {
	console.log("SIGINT received, shutting down...");
	healthMonitor?.stop();
	await db.end();
	process.exit(0);
});

export { app };
