import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, "../../k8s/templates");

export interface TenantConfig {
	tenantId: string;
	userId: string;
	namespace: string;
	tier: "free" | "starter" | "pro" | "enterprise";
	cpuLimit: string;
	memoryLimit: string;
	storageLimit: string;
	encryptionKey: string;
	gatewayToken: string;
}

interface K8sResource {
	apiVersion: string;
	kind: string;
	metadata: {
		name: string;
		namespace?: string;
	};
}

// Resource limits by tier
const TIER_RESOURCES: Record<
	TenantConfig["tier"],
	{ cpu: string; memory: string; storage: string }
> = {
	free: { cpu: "500m", memory: "512Mi", storage: "1Gi" },
	starter: { cpu: "1000m", memory: "1Gi", storage: "5Gi" },
	pro: { cpu: "2000m", memory: "2Gi", storage: "10Gi" },
	enterprise: { cpu: "4000m", memory: "4Gi", storage: "50Gi" },
};

/**
 * Kubernetes client for managing tenant resources
 */
export class K8sClient {
	private apiServer: string;
	private token: string;
	private caCert: string | null;
	private agentImage: string;
	private storageClass: string;

	constructor(options?: {
		apiServer?: string;
		token?: string;
		caCert?: string;
		agentImage?: string;
		storageClass?: string;
	}) {
		if (env.KUBERNETES_IN_CLUSTER) {
			// In-cluster configuration
			this.apiServer = "https://kubernetes.default.svc";
			this.token = fs.readFileSync(
				"/var/run/secrets/kubernetes.io/serviceaccount/token",
				"utf-8"
			);
			this.caCert = fs.readFileSync(
				"/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
				"utf-8"
			);
		} else {
			// External configuration
			this.apiServer =
				options?.apiServer ?? process.env["KUBERNETES_API_SERVER"] ?? "https://localhost:6443";
			this.token = options?.token ?? process.env["KUBERNETES_TOKEN"] ?? "";
			this.caCert = options?.caCert ?? null;
		}

		this.agentImage =
			options?.agentImage ??
			process.env["MOLTBOT_AGENT_IMAGE"] ??
			"moltbot/agent:latest";
		this.storageClass =
			options?.storageClass ??
			process.env["KUBERNETES_STORAGE_CLASS"] ??
			"standard";
	}

	/**
	 * Render a template with values
	 */
	private renderTemplate(
		templateName: string,
		values: Record<string, string>
	): string {
		const templatePath = path.join(TEMPLATES_DIR, templateName);
		let content = fs.readFileSync(templatePath, "utf-8");

		for (const [key, value] of Object.entries(values)) {
			content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
		}

		return content;
	}

	/**
	 * Make a request to the Kubernetes API
	 */
	private async request<T>(
		method: string,
		apiPath: string,
		body?: unknown
	): Promise<T> {
		const url = `${this.apiServer}${apiPath}`;

		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.token}`,
			"Content-Type": "application/json",
		};

		const response = await fetch(url, {
			method,
			headers,
			body: body ? JSON.stringify(body) : undefined,
			// In production, you'd configure TLS properly
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(
				`Kubernetes API error: ${response.status} - ${error}`
			);
		}

		if (response.status === 204) {
			return {} as T;
		}

		return response.json() as Promise<T>;
	}

	/**
	 * Apply a YAML manifest (create or update)
	 */
	private async applyManifest(yaml: string): Promise<void> {
		// Parse YAML (simple single-document parsing)
		const resource = this.parseYaml(yaml) as K8sResource;

		const apiPath = this.getApiPath(resource);

		try {
			// Try to create
			await this.request("POST", apiPath, resource);
		} catch (error) {
			// If already exists, try to patch
			if (error instanceof Error && error.message.includes("409")) {
				const patchPath = `${apiPath}/${resource.metadata.name}`;
				await this.request("PATCH", patchPath, resource);
			} else {
				throw error;
			}
		}
	}

	/**
	 * Delete a resource
	 */
	private async deleteResource(
		kind: string,
		name: string,
		namespace?: string
	): Promise<void> {
		const apiPath = this.getApiPathForKind(kind, namespace);
		try {
			await this.request("DELETE", `${apiPath}/${name}`);
		} catch (error) {
			// Ignore 404 errors
			if (error instanceof Error && !error.message.includes("404")) {
				throw error;
			}
		}
	}

	/**
	 * Simple YAML parser for Kubernetes manifests
	 */
	private parseYaml(yaml: string): unknown {
		// This is a simplified parser - in production, use a proper YAML library
		const lines = yaml.split("\n");
		const result: Record<string, unknown> = {};
		const stack: Array<{ obj: Record<string, unknown>; indent: number }> = [
			{ obj: result, indent: -1 },
		];

		for (const line of lines) {
			if (line.trim() === "" || line.trim().startsWith("#")) continue;

			const indent = line.search(/\S/);
			const content = line.trim();

			// Pop stack to correct level
			while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) {
				stack.pop();
			}

			const current = stack[stack.length - 1]!.obj;

			if (content.includes(": ")) {
				const [key, ...valueParts] = content.split(": ");
				const value = valueParts.join(": ").replace(/^["']|["']$/g, "");
				current[key!] = value === "true" ? true : value === "false" ? false : value;
			} else if (content.endsWith(":")) {
				const key = content.slice(0, -1);
				const newObj: Record<string, unknown> = {};
				current[key] = newObj;
				stack.push({ obj: newObj, indent });
			} else if (content.startsWith("- ")) {
				// Array item - simplified handling
				const parentKey = Object.keys(current).pop();
				if (parentKey && !Array.isArray(current[parentKey])) {
					current[parentKey] = [];
				}
			}
		}

		return result;
	}

	/**
	 * Get API path for a resource
	 */
	private getApiPath(resource: K8sResource): string {
		return this.getApiPathForKind(
			resource.kind,
			resource.metadata.namespace
		);
	}

	/**
	 * Get API path for a resource kind
	 */
	private getApiPathForKind(kind: string, namespace?: string): string {
		const kindMap: Record<string, { api: string; resource: string }> = {
			Namespace: { api: "/api/v1", resource: "namespaces" },
			Secret: { api: "/api/v1", resource: "secrets" },
			Service: { api: "/api/v1", resource: "services" },
			ServiceAccount: { api: "/api/v1", resource: "serviceaccounts" },
			PersistentVolumeClaim: {
				api: "/api/v1",
				resource: "persistentvolumeclaims",
			},
			Deployment: { api: "/apis/apps/v1", resource: "deployments" },
			NetworkPolicy: {
				api: "/apis/networking.k8s.io/v1",
				resource: "networkpolicies",
			},
			Role: { api: "/apis/rbac.authorization.k8s.io/v1", resource: "roles" },
			RoleBinding: {
				api: "/apis/rbac.authorization.k8s.io/v1",
				resource: "rolebindings",
			},
		};

		const info = kindMap[kind];
		if (!info) {
			throw new Error(`Unknown resource kind: ${kind}`);
		}

		if (namespace && kind !== "Namespace") {
			return `${info.api}/namespaces/${namespace}/${info.resource}`;
		}

		return `${info.api}/${info.resource}`;
	}

	/**
	 * Get resource limits for a tier
	 */
	getResourcesForTier(tier: TenantConfig["tier"]): {
		cpu: string;
		memory: string;
		storage: string;
	} {
		return TIER_RESOURCES[tier];
	}

	/**
	 * Provision all resources for a tenant
	 */
	async provisionTenant(config: TenantConfig): Promise<void> {
		const resources = this.getResourcesForTier(config.tier);

		const values: Record<string, string> = {
			tenantId: config.tenantId,
			userId: config.userId,
			namespace: config.namespace,
			tier: config.tier,
			cpuLimit: config.cpuLimit || resources.cpu,
			memoryLimit: config.memoryLimit || resources.memory,
			storageLimit: config.storageLimit || resources.storage,
			storageClass: this.storageClass,
			agentImage: this.agentImage,
			encryptionKeyBase64: Buffer.from(config.encryptionKey).toString(
				"base64"
			),
			gatewayTokenBase64: Buffer.from(config.gatewayToken).toString("base64"),
			createdAt: new Date().toISOString(),
		};

		// Apply resources in order
		const templates = [
			"namespace.yaml",
			"service-account.yaml",
			"secret.yaml",
			"pvc.yaml",
			"network-policy.yaml",
			"deployment.yaml",
			"service.yaml",
		];

		for (const template of templates) {
			const manifest = this.renderTemplate(template, values);
			// Handle multi-document YAML
			const documents = manifest.split(/^---$/m).filter((d) => d.trim());
			for (const doc of documents) {
				await this.applyManifest(doc);
			}
		}
	}

	/**
	 * Delete all resources for a tenant
	 */
	async deleteTenant(namespace: string): Promise<void> {
		// Delete namespace (cascades to all resources within)
		await this.deleteResource("Namespace", namespace);
	}

	/**
	 * Scale tenant deployment
	 */
	async scaleTenant(namespace: string, replicas: number): Promise<void> {
		const path = `/apis/apps/v1/namespaces/${namespace}/deployments/moltbot-agent/scale`;
		await this.request("PATCH", path, {
			spec: { replicas },
		});
	}

	/**
	 * Get tenant deployment status
	 */
	async getTenantStatus(namespace: string): Promise<{
		ready: boolean;
		replicas: number;
		availableReplicas: number;
		conditions: Array<{ type: string; status: string }>;
	}> {
		const path = `/apis/apps/v1/namespaces/${namespace}/deployments/moltbot-agent`;
		const deployment = await this.request<{
			status: {
				replicas?: number;
				availableReplicas?: number;
				readyReplicas?: number;
				conditions?: Array<{ type: string; status: string }>;
			};
		}>("GET", path);

		return {
			ready: (deployment.status.readyReplicas ?? 0) > 0,
			replicas: deployment.status.replicas ?? 0,
			availableReplicas: deployment.status.availableReplicas ?? 0,
			conditions: deployment.status.conditions ?? [],
		};
	}

	/**
	 * Restart tenant pod
	 */
	async restartTenant(namespace: string): Promise<void> {
		// Update deployment annotation to trigger rollout
		const path = `/apis/apps/v1/namespaces/${namespace}/deployments/moltbot-agent`;
		await this.request("PATCH", path, {
			spec: {
				template: {
					metadata: {
						annotations: {
							"moltbot.io/restartedAt": new Date().toISOString(),
						},
					},
				},
			},
		});
	}

	/**
	 * Get pod logs
	 */
	async getPodLogs(
		namespace: string,
		tailLines: number = 100
	): Promise<string> {
		// First get the pod name
		const podsPath = `/api/v1/namespaces/${namespace}/pods?labelSelector=app=moltbot-agent`;
		const pods = await this.request<{
			items: Array<{ metadata: { name: string } }>;
		}>("GET", podsPath);

		if (pods.items.length === 0) {
			return "No pods found";
		}

		const podName = pods.items[0]!.metadata.name;
		const logsPath = `/api/v1/namespaces/${namespace}/pods/${podName}/log?tailLines=${tailLines}`;

		const response = await fetch(`${this.apiServer}${logsPath}`, {
			headers: { Authorization: `Bearer ${this.token}` },
		});

		return response.text();
	}

	/**
	 * Check if cluster is reachable
	 */
	async isHealthy(): Promise<boolean> {
		try {
			await this.request("GET", "/healthz");
			return true;
		} catch {
			return false;
		}
	}
}

// Singleton instance
let k8sClient: K8sClient | null = null;

export function getK8sClient(): K8sClient {
	if (!k8sClient) {
		k8sClient = new K8sClient();
	}
	return k8sClient;
}
