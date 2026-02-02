import { Hono } from "hono";
import { authMiddleware } from "../../auth/middleware.js";
import type { DbClient } from "../../db/client.js";
import { OrchestratorService } from "../../orchestrator/service.js";

export function createAgentRoutes(db: DbClient): Hono {
	const app = new Hono();
	const orchestrator = new OrchestratorService(db);

	// All agent routes require authentication
	app.use("*", authMiddleware);

	// GET /agent/status - Get tenant agent status
	app.get("/status", async (c) => {
		const user = c.get("user");

		const status = await orchestrator.getTenantStatus(user.sub);

		if (!status) {
			return c.json({
				status: "not_provisioned",
				message: "No agent instance found. Please provision one.",
			});
		}

		return c.json({
			status: status.status,
			ready: status.ready,
			namespace: status.namespace,
			podStatus: status.podStatus,
			lastActivityAt: status.lastActivityAt,
			error: status.error,
		});
	});

	// POST /agent/provision - Provision a new agent instance
	app.post("/provision", async (c) => {
		const user = c.get("user");

		const result = await orchestrator.provisionTenant(user.sub);

		if (!result.success) {
			return c.json({ error: result.error }, 400);
		}

		return c.json(
			{
				message: "Agent provisioning started",
				tenantId: result.tenantId,
				namespace: result.namespace,
			},
			202
		);
	});

	// POST /agent/wake - Wake up a scaled-down agent
	app.post("/wake", async (c) => {
		const user = c.get("user");

		const status = await orchestrator.getTenantStatus(user.sub);

		if (!status) {
			return c.json({ error: "No agent instance found" }, 404);
		}

		if (status.status === "active" && status.ready) {
			return c.json({ message: "Agent is already running" });
		}

		if (status.status === "terminated") {
			return c.json(
				{ error: "Agent has been terminated. Please provision a new one." },
				400
			);
		}

		const result = await orchestrator.wakeTenant(user.sub);

		if (!result.success) {
			return c.json({ error: result.error }, 500);
		}

		return c.json({
			message: "Agent wake-up initiated",
			status: "waking",
		});
	});

	// POST /agent/restart - Restart the agent
	app.post("/restart", async (c) => {
		const user = c.get("user");

		const result = await orchestrator.restartTenant(user.sub);

		if (!result.success) {
			return c.json({ error: result.error }, 400);
		}

		return c.json({
			message: "Agent restart initiated",
		});
	});

	// DELETE /agent - Terminate the agent instance
	app.delete("/", async (c) => {
		const user = c.get("user");

		const result = await orchestrator.terminateTenant(user.sub);

		if (!result.success) {
			return c.json({ error: result.error }, 400);
		}

		return c.json({
			message: "Agent termination initiated",
		});
	});

	// GET /agent/logs - Get recent agent logs
	app.get("/logs", async (c) => {
		const user = c.get("user");
		const lines = parseInt(c.req.query("lines") ?? "100", 10);

		const result = await orchestrator.getTenantLogs(user.sub, lines);

		if (!result.success) {
			return c.json({ error: result.error }, 400);
		}

		return c.json({
			logs: result.logs,
		});
	});

	// POST /agent/activity - Record activity (used by gateway proxy)
	app.post("/activity", async (c) => {
		const user = c.get("user");

		await orchestrator.recordActivity(user.sub);

		return c.json({ message: "Activity recorded" });
	});

	return app;
}
