/**
 * Crypto module - Encryption and key management for tenant data
 *
 * This module provides:
 * - Low-level encryption primitives
 * - Per-tenant key management with Vault integration
 * - Encrypted storage for config, blobs, messages, and credentials
 * - Key rotation with automatic re-encryption
 */

// Low-level encryption primitives
export {
	encrypt,
	decrypt,
	encryptToBase64,
	decryptFromBase64,
	encryptObject,
	decryptObject,
	deriveTenantKey,
	generateSecureRandomString,
	secureCompare,
	sha256,
	sha512,
} from "./encryption.js";

// Vault integration
export { VaultClient, getVaultClient, tenantVaultPath } from "./vault.js";

// Tenant key management
export {
	TenantKeyManager,
	getTenantKeyManager,
	type EncryptedData,
} from "./tenant-keys.js";

// Encrypted storage
export {
	EncryptedConfigStore,
	EncryptedBlobStore,
	type TenantBlob,
} from "./encrypted-storage.js";

// Encrypted messages
export {
	EncryptedMessageStore,
	type ChatMessage,
} from "./encrypted-messages.js";

// Encrypted credentials
export {
	EncryptedCredentialStore,
	getAnthropicKey,
	getOpenAIKey,
	type Credential,
	type CredentialProvider,
	type AnthropicCredential,
	type OpenAICredential,
	type OAuthCredential,
} from "./encrypted-credentials.js";

// Key rotation
export {
	KeyRotationService,
	getKeyRotationService,
	type KeyRotationStatus,
	type KeyRotationProgress,
} from "./key-rotation.js";
