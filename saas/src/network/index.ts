/**
 * Network module - Network security and policy management
 *
 * This module provides:
 * - Kubernetes NetworkPolicy management for tenant isolation
 * - Egress whitelisting for allowed API endpoints
 * - Cilium FQDN-based filtering support
 */

export {
	NetworkPolicyManager,
	createNetworkPolicyManager,
	DEFAULT_EGRESS_CONFIG,
	type EgressConfig,
	type PolicyType,
} from "./policy-manager.js";
