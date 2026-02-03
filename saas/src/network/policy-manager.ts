import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { KubernetesClient } from "../orchestrator/k8s-client.js";

/**
 * Allowed egress domains configuration
 */
export interface EgressConfig {
	// AI provider APIs (always allowed)
	aiProviders: string[];
	// Messaging platforms (based on tenant config)
	telegram: boolean;
	discord: boolean;
	slack: boolean;
	whatsApp: boolean;
	// Custom domains (tenant-specific)
	customDomains: string[];
}

export const DEFAULT_EGRESS_CONFIG: EgressConfig = {
	aiProviders: [
		"api.anthropic.com",
		"api.openai.com",
		"generativelanguage.googleapis.com",
	],
	telegram: false,
	discord: false,
	slack: false,
	whatsApp: false,
	customDomains: [],
};

/**
 * Network policy types
 */
export type PolicyType =
	| "deny-all"
	| "tenant-isolation"
	| "egress-whitelist"
	| "cilium-fqdn";

/**
 * Network Policy Manager
 * Handles creation and management of Kubernetes NetworkPolicies for tenant isolation
 */
export class NetworkPolicyManager {
	private templatesDir: string;

	constructor(
		private k8sClient: KubernetesClient,
		templatesDir?: string
	) {
		this.templatesDir =
			templatesDir ?? join(process.cwd(), "k8s", "templates");
	}

	/**
	 * Apply all network policies for a tenant namespace
	 */
	async applyTenantPolicies(
		tenantId: string,
		namespace: string,
		egressConfig: EgressConfig = DEFAULT_EGRESS_CONFIG
	): Promise<void> {
		// Check if Cilium is available
		const hasCilium = await this.checkCiliumAvailable();

		// Apply standard NetworkPolicies
		await this.applyStandardPolicies(tenantId, namespace);

		// Apply Cilium policies if available (for FQDN filtering)
		if (hasCilium) {
			await this.applyCiliumPolicies(tenantId, namespace, egressConfig);
		}
	}

	/**
	 * Apply standard Kubernetes NetworkPolicies
	 */
	private async applyStandardPolicies(
		tenantId: string,
		namespace: string
	): Promise<void> {
		const templatePath = join(this.templatesDir, "network-policy.yaml");
		const template = await readFile(templatePath, "utf-8");

		// Split YAML documents
		const documents = template.split("---").filter((doc) => doc.trim());

		for (const doc of documents) {
			const rendered = this.renderTemplate(doc, {
				namespace,
				tenantId,
			});

			await this.k8sClient.applyManifest(rendered);
		}
	}

	/**
	 * Apply Cilium NetworkPolicies for FQDN-based filtering
	 */
	private async applyCiliumPolicies(
		tenantId: string,
		namespace: string,
		egressConfig: EgressConfig
	): Promise<void> {
		const templatePath = join(
			this.templatesDir,
			"cilium-network-policy.yaml"
		);

		let template: string;
		try {
			template = await readFile(templatePath, "utf-8");
		} catch {
			console.warn("Cilium policy template not found, skipping");
			return;
		}

		// Render template with conditional blocks
		const rendered = this.renderCiliumTemplate(template, {
			namespace,
			tenantId,
			enableTelegram: egressConfig.telegram,
			enableDiscord: egressConfig.discord,
			enableSlack: egressConfig.slack,
			enableWhatsApp: egressConfig.whatsApp,
			customDomains: egressConfig.customDomains,
		});

		// Split and apply each document
		const documents = rendered.split("---").filter((doc) => doc.trim());

		for (const doc of documents) {
			try {
				await this.k8sClient.applyManifest(doc);
			} catch (error) {
				console.error("Failed to apply Cilium policy:", error);
			}
		}
	}

	/**
	 * Check if Cilium CRDs are available in the cluster
	 */
	private async checkCiliumAvailable(): Promise<boolean> {
		try {
			const response = await this.k8sClient.request(
				"GET",
				"/apis/cilium.io/v2"
			);
			return response.status === 200;
		} catch {
			return false;
		}
	}

	/**
	 * Remove all network policies for a tenant
	 */
	async removeTenantPolicies(
		tenantId: string,
		namespace: string
	): Promise<void> {
		// Delete standard NetworkPolicies
		const policies = ["deny-all-baseline", "tenant-isolation", "egress-api-whitelist"];

		for (const policyName of policies) {
			try {
				await this.k8sClient.request(
					"DELETE",
					`/apis/networking.k8s.io/v1/namespaces/${namespace}/networkpolicies/${policyName}`
				);
			} catch {
				// Policy may not exist
			}
		}

		// Delete Cilium policies if they exist
		const ciliumPolicies = ["tenant-egress-fqdn", "tenant-ingress"];

		for (const policyName of ciliumPolicies) {
			try {
				await this.k8sClient.request(
					"DELETE",
					`/apis/cilium.io/v2/namespaces/${namespace}/ciliumnetworkpolicies/${policyName}`
				);
			} catch {
				// Policy may not exist or Cilium not installed
			}
		}
	}

	/**
	 * Update egress configuration for a tenant
	 */
	async updateEgressConfig(
		tenantId: string,
		namespace: string,
		egressConfig: EgressConfig
	): Promise<void> {
		// Remove existing policies
		await this.removeTenantPolicies(tenantId, namespace);

		// Reapply with new config
		await this.applyTenantPolicies(tenantId, namespace, egressConfig);
	}

	/**
	 * Get current network policy status for a tenant
	 */
	async getPolicyStatus(
		namespace: string
	): Promise<{ policies: string[]; ciliumPolicies: string[] }> {
		const policies: string[] = [];
		const ciliumPolicies: string[] = [];

		// Get standard policies
		try {
			const response = await this.k8sClient.request<{
				items: Array<{ metadata: { name: string } }>;
			}>(
				"GET",
				`/apis/networking.k8s.io/v1/namespaces/${namespace}/networkpolicies`
			);

			if (response.data?.items) {
				for (const item of response.data.items) {
					policies.push(item.metadata.name);
				}
			}
		} catch {
			// Namespace may not exist
		}

		// Get Cilium policies
		try {
			const response = await this.k8sClient.request<{
				items: Array<{ metadata: { name: string } }>;
			}>(
				"GET",
				`/apis/cilium.io/v2/namespaces/${namespace}/ciliumnetworkpolicies`
			);

			if (response.data?.items) {
				for (const item of response.data.items) {
					ciliumPolicies.push(item.metadata.name);
				}
			}
		} catch {
			// Cilium may not be installed
		}

		return { policies, ciliumPolicies };
	}

	/**
	 * Validate that required policies are in place
	 */
	async validatePolicies(namespace: string): Promise<{
		valid: boolean;
		missing: string[];
	}> {
		const required = ["deny-all-baseline", "tenant-isolation"];
		const { policies } = await this.getPolicyStatus(namespace);

		const missing = required.filter((p) => !policies.includes(p));

		return {
			valid: missing.length === 0,
			missing,
		};
	}

	/**
	 * Render a simple template with variable substitution
	 */
	private renderTemplate(
		template: string,
		vars: Record<string, string>
	): string {
		let result = template;
		for (const [key, value] of Object.entries(vars)) {
			result = result.replace(new RegExp(`{{${key}}}`, "g"), value);
		}
		return result;
	}

	/**
	 * Render Cilium template with conditional blocks
	 */
	private renderCiliumTemplate(
		template: string,
		vars: {
			namespace: string;
			tenantId: string;
			enableTelegram: boolean;
			enableDiscord: boolean;
			enableSlack: boolean;
			enableWhatsApp: boolean;
			customDomains: string[];
		}
	): string {
		let result = template;

		// Replace simple variables
		result = result.replace(/{{namespace}}/g, vars.namespace);
		result = result.replace(/{{tenantId}}/g, vars.tenantId);

		// Handle conditional blocks
		result = this.processConditionalBlock(
			result,
			"enableTelegram",
			vars.enableTelegram
		);
		result = this.processConditionalBlock(
			result,
			"enableDiscord",
			vars.enableDiscord
		);
		result = this.processConditionalBlock(
			result,
			"enableSlack",
			vars.enableSlack
		);
		result = this.processConditionalBlock(
			result,
			"enableWhatsApp",
			vars.enableWhatsApp
		);

		// Handle custom domains loop
		if (vars.customDomains.length > 0) {
			const domainBlock = vars.customDomains
				.map(
					(domain) => `    - toFQDNs:
        - matchName: "${domain}"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP`
				)
				.join("\n\n");

			result = result.replace(
				/{{#each customDomains}}[\s\S]*?{{\/each}}/g,
				domainBlock
			);
		} else {
			result = result.replace(
				/{{#each customDomains}}[\s\S]*?{{\/each}}/g,
				""
			);
		}

		return result;
	}

	/**
	 * Process a conditional block in the template
	 */
	private processConditionalBlock(
		template: string,
		condition: string,
		value: boolean
	): string {
		const pattern = new RegExp(
			`{{#if ${condition}}}([\\s\\S]*?){{/if}}`,
			"g"
		);

		if (value) {
			// Keep the content, remove the tags
			return template.replace(pattern, "$1");
		} else {
			// Remove the entire block
			return template.replace(pattern, "");
		}
	}
}

/**
 * Create a network policy manager instance
 */
export function createNetworkPolicyManager(
	k8sClient: KubernetesClient,
	templatesDir?: string
): NetworkPolicyManager {
	return new NetworkPolicyManager(k8sClient, templatesDir);
}
