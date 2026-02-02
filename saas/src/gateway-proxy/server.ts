import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "node:http";
import { parse as parseUrl } from "node:url";
import { verifyAccessToken } from "../auth/jwt.js";
import type { DbClient, TenantRow } from "../db/client.js";
import { env } from "../config/env.js";

interface ClientConnection {
	userId: string;
	tenantNamespace: string;
	clientWs: WebSocket;
	tenantWs: WebSocket | null;
	lastActivity: number;
}

const connections = new Map<string, ClientConnection>();

// Activity recording interval
const ACTIVITY_RECORD_INTERVAL = 60 * 1000; // 1 minute

export function createGatewayProxy(db: DbClient, port: number = 3001) {
	const server = createServer();
	const wss = new WebSocketServer({ server });

	wss.on("connection", async (ws, req) => {
		const url = parseUrl(req.url || "", true);
		const token = url.query["token"] as string;

		if (!token) {
			ws.close(4001, "Missing token");
			return;
		}

		// Verify JWT
		const payload = await verifyAccessToken(token);
		if (!payload) {
			ws.close(4001, "Invalid token");
			return;
		}

		const userId = payload.sub;

		// Get tenant info
		const tenantResult = await db.query<TenantRow>(
			"SELECT * FROM tenants WHERE user_id = $1 AND status = 'active'",
			[userId]
		);

		if (tenantResult.rows.length === 0) {
			ws.close(4004, "No active tenant");
			return;
		}

		const tenant = tenantResult.rows[0]!;

		// Create connection object
		const connectionId = crypto.randomUUID();
		const connection: ClientConnection = {
			userId,
			tenantNamespace: tenant.namespace,
			clientWs: ws,
			tenantWs: null,
			lastActivity: Date.now(),
		};

		connections.set(connectionId, connection);

		// Connect to tenant gateway
		const tenantWsUrl = getTenantWsUrl(tenant.namespace);
		try {
			connection.tenantWs = await connectToTenant(tenantWsUrl, tenant.gateway_token_hash);

			// Relay messages from tenant to client
			connection.tenantWs.on("message", (data) => {
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(data.toString());
				}
			});

			connection.tenantWs.on("close", () => {
				if (ws.readyState === WebSocket.OPEN) {
					ws.close(4002, "Tenant connection closed");
				}
			});

			connection.tenantWs.on("error", (error) => {
				console.error(`Tenant WebSocket error for ${userId}:`, error);
				if (ws.readyState === WebSocket.OPEN) {
					ws.close(4003, "Tenant connection error");
				}
			});
		} catch (error) {
			console.error(`Failed to connect to tenant ${tenant.namespace}:`, error);
			ws.close(4002, "Failed to connect to agent");
			connections.delete(connectionId);
			return;
		}

		// Handle messages from client
		ws.on("message", (data) => {
			connection.lastActivity = Date.now();

			if (connection.tenantWs?.readyState === WebSocket.OPEN) {
				connection.tenantWs.send(data.toString());
			}
		});

		// Handle client disconnect
		ws.on("close", () => {
			connection.tenantWs?.close();
			connections.delete(connectionId);
		});

		ws.on("error", (error) => {
			console.error(`Client WebSocket error for ${userId}:`, error);
			connection.tenantWs?.close();
			connections.delete(connectionId);
		});

		// Send connected message
		ws.send(
			JSON.stringify({
				type: "connected",
				payload: { tenantId: tenant.id },
			})
		);
	});

	// Record activity periodically
	setInterval(async () => {
		const now = Date.now();

		for (const [, connection] of connections) {
			if (now - connection.lastActivity < ACTIVITY_RECORD_INTERVAL * 2) {
				await db.query(
					"UPDATE tenants SET last_activity_at = NOW() WHERE user_id = $1",
					[connection.userId]
				).catch(() => {});
			}
		}
	}, ACTIVITY_RECORD_INTERVAL);

	server.listen(port, () => {
		console.log(`Gateway proxy listening on port ${port}`);
	});

	return {
		server,
		wss,
		close: () => {
			// Close all connections
			for (const [, connection] of connections) {
				connection.clientWs.close();
				connection.tenantWs?.close();
			}
			connections.clear();

			wss.close();
			server.close();
		},
	};
}

function getTenantWsUrl(namespace: string): string {
	// In Kubernetes, services are accessible via DNS
	if (env.KUBERNETES_IN_CLUSTER) {
		return `ws://moltbot-agent.${namespace}.svc.cluster.local:18789/ws`;
	}

	// For local development, use port forwarding or direct connection
	return `ws://localhost:18789/ws`;
}

async function connectToTenant(
	url: string,
	token: string | null
): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url, {
			headers: token ? { Authorization: `Bearer ${token}` } : {},
		});

		const timeout = setTimeout(() => {
			ws.close();
			reject(new Error("Connection timeout"));
		}, 10000);

		ws.on("open", () => {
			clearTimeout(timeout);
			resolve(ws);
		});

		ws.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
	});
}

// Export for use in main server
export { connections };
