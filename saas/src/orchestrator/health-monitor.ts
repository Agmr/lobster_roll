import type { DbClient, TenantRow } from "../db/client.js";
import { OrchestratorService } from "./service.js";

// Intervals
const HEALTH_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute
const IDLE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const UNHEALTHY_RESTART_THRESHOLD = 3; // Restart after 3 consecutive failures

interface TenantHealthState {
	consecutiveFailures: number;
	lastCheck: Date;
	lastHealthy: Date | null;
}

/**
 * Background health monitor for tenant instances
 */
export class HealthMonitor {
	private healthCheckTimer: NodeJS.Timeout | null = null;
	private idleCheckTimer: NodeJS.Timeout | null = null;
	private running = false;
	private tenantHealthState: Map<string, TenantHealthState> = new Map();
	private orchestrator: OrchestratorService;

	constructor(private db: DbClient) {
		this.orchestrator = new OrchestratorService(db);
	}

	/**
	 * Start the health monitor
	 */
	start(): void {
		if (this.running) return;

		this.running = true;
		console.log("Health monitor started");

		// Start health check loop
		this.healthCheckTimer = setInterval(
			() => this.runHealthCheck(),
			HEALTH_CHECK_INTERVAL_MS
		);

		// Start idle check loop
		this.idleCheckTimer = setInterval(
			() => this.runIdleCheck(),
			IDLE_CHECK_INTERVAL_MS
		);

		// Run initial checks
		this.runHealthCheck();
		this.runIdleCheck();
	}

	/**
	 * Stop the health monitor
	 */
	stop(): void {
		if (!this.running) return;

		this.running = false;

		if (this.healthCheckTimer) {
			clearInterval(this.healthCheckTimer);
			this.healthCheckTimer = null;
		}

		if (this.idleCheckTimer) {
			clearInterval(this.idleCheckTimer);
			this.idleCheckTimer = null;
		}

		console.log("Health monitor stopped");
	}

	/**
	 * Run health check on all active tenants
	 */
	private async runHealthCheck(): Promise<void> {
		if (!this.running) return;

		try {
			const results = await this.orchestrator.checkAllTenantsHealth();

			for (const result of results) {
				const state = this.tenantHealthState.get(result.tenantId) ?? {
					consecutiveFailures: 0,
					lastCheck: new Date(),
					lastHealthy: null,
				};

				state.lastCheck = new Date();

				if (result.healthy) {
					state.consecutiveFailures = 0;
					state.lastHealthy = new Date();
				} else {
					state.consecutiveFailures++;

					console.warn(
						`Tenant ${result.tenantId} unhealthy (${state.consecutiveFailures} failures): ${result.error}`
					);

					// Auto-restart if threshold exceeded
					if (state.consecutiveFailures >= UNHEALTHY_RESTART_THRESHOLD) {
						await this.handleUnhealthyTenant(result.tenantId);
						state.consecutiveFailures = 0;
					}
				}

				this.tenantHealthState.set(result.tenantId, state);
			}
		} catch (error) {
			console.error("Health check failed:", error);
		}
	}

	/**
	 * Handle an unhealthy tenant
	 */
	private async handleUnhealthyTenant(tenantId: string): Promise<void> {
		console.log(`Restarting unhealthy tenant ${tenantId}`);

		try {
			// Get tenant user ID
			const result = await this.db.query<TenantRow>(
				"SELECT user_id FROM tenants WHERE id = $1",
				[tenantId]
			);

			if (result.rows.length === 0) return;

			const userId = result.rows[0]!.user_id;

			// Restart the tenant
			await this.orchestrator.restartTenant(userId);

			// Log the event
			await this.db.query(
				`INSERT INTO audit_logs (tenant_id, event_type, event_category, description)
				 VALUES ($1, 'auto_restart', 'health', 'Tenant auto-restarted due to health check failures')`,
				[tenantId]
			);
		} catch (error) {
			console.error(`Failed to restart tenant ${tenantId}:`, error);
		}
	}

	/**
	 * Check for and scale down idle tenants
	 */
	private async runIdleCheck(): Promise<void> {
		if (!this.running) return;

		try {
			const idleTenants = await this.orchestrator.findIdleTenants();

			for (const tenant of idleTenants) {
				console.log(
					`Scaling down idle tenant ${tenant.id} (last activity: ${tenant.last_activity_at})`
				);

				await this.orchestrator.scaleDownTenant(tenant.id);

				// Log the event
				await this.db.query(
					`INSERT INTO audit_logs (tenant_id, user_id, event_type, event_category, description)
					 VALUES ($1, $2, 'scale_down', 'idle', 'Tenant scaled down due to inactivity')`,
					[tenant.id, tenant.user_id]
				);
			}
		} catch (error) {
			console.error("Idle check failed:", error);
		}
	}

	/**
	 * Get health state for a tenant
	 */
	getHealthState(tenantId: string): TenantHealthState | undefined {
		return this.tenantHealthState.get(tenantId);
	}

	/**
	 * Get all health states
	 */
	getAllHealthStates(): Map<string, TenantHealthState> {
		return new Map(this.tenantHealthState);
	}
}

// Singleton instance
let healthMonitor: HealthMonitor | null = null;

export function getHealthMonitor(db: DbClient): HealthMonitor {
	if (!healthMonitor) {
		healthMonitor = new HealthMonitor(db);
	}
	return healthMonitor;
}
