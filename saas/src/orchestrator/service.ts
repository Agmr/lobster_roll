import type { DbClient, TenantRow, SubscriptionRow } from "../db/client.js";
import { withTransaction } from "../db/client.js";
import { deriveTenantKey, generateSecureRandomString } from "../crypto/index.js";
import { K8sClient, getK8sClient } from "./k8s-client.js";
import type { TenantConfig } from "./k8s-client.js";

export interface ProvisionResult {
	success: boolean;
	tenantId?: string;
	namespace?: string;
	error?: string;
}

export interface TenantStatus {
	status: "provisioning" | "active" | "suspended" | "terminated" | "scaled_down" | "error";
	ready: boolean;
	namespace: string;
	podStatus?: {
		replicas: number;
		availableReplicas: number;
	};
	lastActivityAt: Date;
	error?: string;
}

// Scale-to-zero settings
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes of inactivity

/**
 * Orchestrator service for managing tenant compute resources
 */
export class OrchestratorService {
	private k8s: K8sClient;

	constructor(
		private db: DbClient,
		k8sClient?: K8sClient
	) {
		this.k8s = k8sClient ?? getK8sClient();
	}

	/**
	 * Provision a new tenant instance
	 */
	async provisionTenant(userId: string): Promise<ProvisionResult> {
		// Get user's subscription tier
		const subscriptionResult = await this.db.query<SubscriptionRow>(
			"SELECT tier FROM subscriptions WHERE user_id = $1",
			[userId]
		);

		const tier = subscriptionResult.rows[0]?.tier ?? "free";

		// Check if tenant already exists
		const existingResult = await this.db.query<TenantRow>(
			"SELECT * FROM tenants WHERE user_id = $1",
			[userId]
		);

		if (existingResult.rows.length > 0) {
			const existing = existingResult.rows[0]!;
			if (existing.status !== "terminated") {
				return {
					success: false,
					error: "Tenant already exists",
				};
			}
		}

		// Generate namespace and secrets
		const namespace = `tenant-${userId.slice(0, 8)}-${Date.now().toString(36)}`;
		const encryptionKey = deriveTenantKey(userId);
		const gatewayToken = generateSecureRandomString(32);

		// Create tenant record
		const tenantResult = await withTransaction(this.db, async (client) => {
			const result = await client.query<TenantRow>(
				`INSERT INTO tenants (user_id, namespace, status, gateway_token_hash)
				 VALUES ($1, $2, 'provisioning', $3)
				 ON CONFLICT (user_id) DO UPDATE SET
				   namespace = $2,
				   status = 'provisioning',
				   gateway_token_hash = $3,
				   updated_at = NOW()
				 RETURNING *`,
				[userId, namespace, gatewayToken]  // In production, hash the token
			);
			return result.rows[0]!;
		});

		// Provision Kubernetes resources
		try {
			const resources = this.k8s.getResourcesForTier(tier);

			const config: TenantConfig = {
				tenantId: tenantResult.id,
				userId,
				namespace,
				tier,
				cpuLimit: resources.cpu,
				memoryLimit: resources.memory,
				storageLimit: resources.storage,
				encryptionKey,
				gatewayToken,
			};

			await this.k8s.provisionTenant(config);

			// Update status to active
			await this.db.query(
				`UPDATE tenants SET status = 'active' WHERE id = $1`,
				[tenantResult.id]
			);

			return {
				success: true,
				tenantId: tenantResult.id,
				namespace,
			};
		} catch (error) {
			// Mark as failed
			await this.db.query(
				`UPDATE tenants SET status = 'suspended' WHERE id = $1`,
				[tenantResult.id]
			);

			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	/**
	 * Get tenant status
	 */
	async getTenantStatus(userId: string): Promise<TenantStatus | null> {
		const result = await this.db.query<TenantRow>(
			"SELECT * FROM tenants WHERE user_id = $1",
			[userId]
		);

		if (result.rows.length === 0) {
			return null;
		}

		const tenant = result.rows[0]!;

		// If terminated, return immediately
		if (tenant.status === "terminated") {
			return {
				status: "terminated",
				ready: false,
				namespace: tenant.namespace,
				lastActivityAt: tenant.last_activity_at,
			};
		}

		// Check if scaled down
		if (tenant.scaled_down_at) {
			return {
				status: "scaled_down",
				ready: false,
				namespace: tenant.namespace,
				lastActivityAt: tenant.last_activity_at,
			};
		}

		// Get Kubernetes status
		try {
			const k8sStatus = await this.k8s.getTenantStatus(tenant.namespace);

			return {
				status: tenant.status,
				ready: k8sStatus.ready,
				namespace: tenant.namespace,
				podStatus: {
					replicas: k8sStatus.replicas,
					availableReplicas: k8sStatus.availableReplicas,
				},
				lastActivityAt: tenant.last_activity_at,
			};
		} catch (error) {
			return {
				status: "error",
				ready: false,
				namespace: tenant.namespace,
				lastActivityAt: tenant.last_activity_at,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	/**
	 * Wake up a scaled-down tenant
	 */
	async wakeTenant(userId: string): Promise<{ success: boolean; error?: string }> {
		const result = await this.db.query<TenantRow>(
			"SELECT * FROM tenants WHERE user_id = $1",
			[userId]
		);

		if (result.rows.length === 0) {
			return { success: false, error: "Tenant not found" };
		}

		const tenant = result.rows[0]!;

		if (tenant.status === "terminated") {
			return { success: false, error: "Tenant is terminated" };
		}

		try {
			// Scale up to 1 replica
			await this.k8s.scaleTenant(tenant.namespace, 1);

			// Update database
			await this.db.query(
				`UPDATE tenants
				 SET scaled_down_at = NULL,
				     last_activity_at = NOW()
				 WHERE id = $1`,
				[tenant.id]
			);

			return { success: true };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	/**
	 * Scale down an idle tenant
	 */
	async scaleDownTenant(tenantId: string): Promise<void> {
		const result = await this.db.query<TenantRow>(
			"SELECT * FROM tenants WHERE id = $1",
			[tenantId]
		);

		if (result.rows.length === 0) return;

		const tenant = result.rows[0]!;

		if (tenant.status !== "active" || tenant.scaled_down_at) return;

		try {
			await this.k8s.scaleTenant(tenant.namespace, 0);

			await this.db.query(
				`UPDATE tenants SET scaled_down_at = NOW() WHERE id = $1`,
				[tenantId]
			);
		} catch (error) {
			console.error(`Failed to scale down tenant ${tenantId}:`, error);
		}
	}

	/**
	 * Restart tenant pod
	 */
	async restartTenant(userId: string): Promise<{ success: boolean; error?: string }> {
		const result = await this.db.query<TenantRow>(
			"SELECT * FROM tenants WHERE user_id = $1",
			[userId]
		);

		if (result.rows.length === 0) {
			return { success: false, error: "Tenant not found" };
		}

		const tenant = result.rows[0]!;

		if (tenant.status !== "active") {
			return { success: false, error: `Cannot restart tenant in ${tenant.status} state` };
		}

		try {
			await this.k8s.restartTenant(tenant.namespace);
			return { success: true };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	/**
	 * Terminate tenant (delete all resources)
	 */
	async terminateTenant(userId: string): Promise<{ success: boolean; error?: string }> {
		const result = await this.db.query<TenantRow>(
			"SELECT * FROM tenants WHERE user_id = $1",
			[userId]
		);

		if (result.rows.length === 0) {
			return { success: false, error: "Tenant not found" };
		}

		const tenant = result.rows[0]!;

		try {
			// Delete Kubernetes resources
			await this.k8s.deleteTenant(tenant.namespace);

			// Update database
			await this.db.query(
				`UPDATE tenants SET status = 'terminated' WHERE id = $1`,
				[tenant.id]
			);

			return { success: true };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	/**
	 * Get pod logs
	 */
	async getTenantLogs(
		userId: string,
		tailLines: number = 100
	): Promise<{ success: boolean; logs?: string; error?: string }> {
		const result = await this.db.query<TenantRow>(
			"SELECT * FROM tenants WHERE user_id = $1",
			[userId]
		);

		if (result.rows.length === 0) {
			return { success: false, error: "Tenant not found" };
		}

		const tenant = result.rows[0]!;

		if (tenant.status !== "active") {
			return { success: false, error: "Tenant is not running" };
		}

		try {
			const logs = await this.k8s.getPodLogs(tenant.namespace, tailLines);
			return { success: true, logs };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	/**
	 * Record activity for a tenant (resets idle timer)
	 */
	async recordActivity(userId: string): Promise<void> {
		await this.db.query(
			`UPDATE tenants SET last_activity_at = NOW() WHERE user_id = $1`,
			[userId]
		);
	}

	/**
	 * Find idle tenants that should be scaled down
	 */
	async findIdleTenants(): Promise<TenantRow[]> {
		const result = await this.db.query<TenantRow>(
			`SELECT * FROM tenants
			 WHERE status = 'active'
			   AND scaled_down_at IS NULL
			   AND last_activity_at < NOW() - INTERVAL '${IDLE_TIMEOUT_MS} milliseconds'`
		);

		return result.rows;
	}

	/**
	 * Health check for all active tenants
	 */
	async checkAllTenantsHealth(): Promise<
		Array<{ tenantId: string; healthy: boolean; error?: string }>
	> {
		const result = await this.db.query<TenantRow>(
			`SELECT * FROM tenants WHERE status = 'active' AND scaled_down_at IS NULL`
		);

		const healthResults = await Promise.all(
			result.rows.map(async (tenant) => {
				try {
					const status = await this.k8s.getTenantStatus(tenant.namespace);
					return {
						tenantId: tenant.id,
						healthy: status.ready,
					};
				} catch (error) {
					return {
						tenantId: tenant.id,
						healthy: false,
						error: error instanceof Error ? error.message : "Unknown error",
					};
				}
			})
		);

		return healthResults;
	}
}
