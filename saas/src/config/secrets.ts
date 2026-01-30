import crypto from "node:crypto";
import { getVaultClient } from "../crypto/vault.js";

const SECRETS_PATH = "moltbot/api-secrets";

interface ApiSecrets {
	jwtAccessSecret: string;
	jwtRefreshSecret: string;
	encryptionKey: string;
	createdAt: string;
	rotatedAt?: string;
}

/**
 * Generate cryptographically secure secrets
 */
export function generateSecrets(): ApiSecrets {
	return {
		jwtAccessSecret: crypto.randomBytes(32).toString("base64"),
		jwtRefreshSecret: crypto.randomBytes(32).toString("base64"),
		encryptionKey: crypto.randomBytes(32).toString("base64"),
		createdAt: new Date().toISOString(),
	};
}

/**
 * Initialize secrets - either load from Vault or generate new ones
 * For production: loads from Vault
 * For development: uses environment variables or generates ephemeral secrets
 */
export async function initializeSecrets(): Promise<ApiSecrets> {
	const useVault = process.env["VAULT_ADDR"] && process.env["VAULT_TOKEN"];

	if (useVault) {
		return loadOrCreateSecretsFromVault();
	}

	// Development mode: use env vars
	return {
		jwtAccessSecret: process.env["JWT_ACCESS_SECRET"] ?? generateSecrets().jwtAccessSecret,
		jwtRefreshSecret: process.env["JWT_REFRESH_SECRET"] ?? generateSecrets().jwtRefreshSecret,
		encryptionKey: process.env["ENCRYPTION_KEY"] ?? generateSecrets().encryptionKey,
		createdAt: new Date().toISOString(),
	};
}

/**
 * Load secrets from Vault, or create them if they don't exist
 */
async function loadOrCreateSecretsFromVault(): Promise<ApiSecrets> {
	const vault = getVaultClient();

	// Try to load existing secrets
	const existing = await vault.kvGet(SECRETS_PATH);

	if (existing) {
		console.log("Loaded API secrets from Vault");
		return existing as ApiSecrets;
	}

	// Generate and store new secrets
	console.log("Generating new API secrets and storing in Vault");
	const secrets = generateSecrets();
	await vault.kvPut(SECRETS_PATH, secrets as unknown as Record<string, unknown>);

	return secrets;
}

/**
 * Rotate JWT secrets with a grace period
 * Old tokens remain valid until they expire naturally
 */
export async function rotateSecrets(): Promise<{
	current: ApiSecrets;
	previous?: ApiSecrets;
}> {
	const vault = getVaultClient();

	// Load current secrets
	const current = await vault.kvGet(SECRETS_PATH) as ApiSecrets | null;

	// Generate new secrets
	const newSecrets = generateSecrets();
	newSecrets.rotatedAt = new Date().toISOString();

	// Store new secrets
	await vault.kvPut(SECRETS_PATH, newSecrets as unknown as Record<string, unknown>);

	// Optionally store previous secrets for grace period validation
	if (current) {
		await vault.kvPut(`${SECRETS_PATH}-previous`, current as unknown as Record<string, unknown>);
	}

	console.log("API secrets rotated successfully");

	return {
		current: newSecrets,
		previous: current ?? undefined,
	};
}

/**
 * CLI helper to generate secrets for initial setup
 */
export function printGeneratedSecrets(): void {
	const secrets = generateSecrets();

	console.log("Generated API Secrets (add to .env or Vault):\n");
	console.log(`JWT_ACCESS_SECRET=${secrets.jwtAccessSecret}`);
	console.log(`JWT_REFRESH_SECRET=${secrets.jwtRefreshSecret}`);
	console.log(`ENCRYPTION_KEY=${secrets.encryptionKey}`);
	console.log("\nStore these securely - they cannot be recovered if lost.");
}

// CLI entry point
if (process.argv[1]?.endsWith("secrets.ts") && process.argv[2] === "generate") {
	printGeneratedSecrets();
}
