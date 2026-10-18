// Tenant key management (tenant isolation phase 5): the seam the envelopes in
// rag/tenant-encryption.js are built on.
//
// A provider holds one key per key scope (rag/kms/key-scope.js), in versions:
// new writes use the current version, every version stays readable until the
// key is destroyed, and a destroyed key cannot be read again by anyone. It
// never hands out a tenant key: it wraps and unwraps the per-object data keys
// the envelopes carry. The interface, every call async:
//
//   id                                    the provider id written into every
//                                         envelope ("local")
//   getOrCreateKey(scope)               -> { keyId, version }
//                                         the current version, creating the
//                                         key on first use (and a new version
//                                         after a destroy)
//   wrapDataKey({ keyId, version, dataKey, aad })   -> wrapped bytes
//   unwrapDataKey({ keyId, version, wrapped, aad }) -> the data key; fails
//                                         with TENANT_KEY_DESTROYED,
//                                         TENANT_KEY_NOT_FOUND or
//                                         TENANT_KEY_UNWRAP_FAILED
//   rotateKey(scope, { dryRun })        -> { keyId, previousVersion, version }
//   destroyKey(scope | keyId, { dryRun }) -> { keyId, existed, destroyedVersions }
//   describeKey(scope | keyId)          -> metadata ({ keyId, state,
//                                         currentVersion, versions,
//                                         destroyedThroughVersion, ... }) or null
//   listKeys()                          -> metadata of every key
//   status()                            -> { status, keystore, masterKey,
//                                         errors, warnings }
//   invalidate(keyId?)                    drops cached key material
//
// Only `local` is implemented (rag/kms/local-provider.js): demo-grade key
// files on this machine, wrapped by a master key file. The production
// replacement is a cloud KMS or an HSM (AWS KMS, Google Cloud KMS, Azure Key
// Vault, an HSM over PKCS#11) implementing the same calls: getOrCreateKey maps
// to creating or looking up a customer key per scope (an alias named by the
// key id), wrap/unwrap to its Encrypt/Decrypt (or GenerateDataKey) with the
// AAD as encryption context, rotateKey to a new key version, and destroyKey to
// scheduling key deletion. It is documented, not implemented.
import { getTenantKmsProviderId } from "../config.js";
import { createLocalTenantKmsProvider, LOCAL_KMS_PROVIDER_ID, resolveLocalKmsPaths } from "./local-provider.js";

export { TENANT_ENCRYPTION_ERROR_CODES, createTenantEncryptionError, isTenantEncryptionError } from "./errors.js";
export {
  TENANT_KEY_SCOPE_KINDS,
  isTenantKeyId,
  resolveTenantKeyScope,
  resolveTenantKeyScopesForErase,
  toTenantKeyId,
} from "./key-scope.js";
export { LOCAL_KMS_PROVIDER_ID };

let configuredProvider = null;
let defaultProvider = null;
let defaultProviderSettings = "";

const describeDefaultSettings = () =>
  JSON.stringify([getTenantKmsProviderId(), resolveLocalKmsPaths()]);

/**
 * The provider every envelope uses: one configured by a test or a caller,
 * else the default for TENANT_KMS_PROVIDER (rebuilt, with an empty cache,
 * when its settings change). Throws TENANT_KMS_PROVIDER_INVALID for an
 * unknown provider.
 */
export const getTenantKmsProvider = () => {
  if (configuredProvider) {
    return configuredProvider;
  }

  const settings = describeDefaultSettings();

  if (!defaultProvider || settings !== defaultProviderSettings) {
    defaultProvider = createLocalTenantKmsProvider(resolveLocalKmsPaths());
    defaultProviderSettings = settings;
  }

  return defaultProvider;
};

export const configureTenantKmsProvider = (provider) => {
  configuredProvider = provider ?? null;
};

export const resetTenantKmsProvider = () => {
  configuredProvider = null;
  defaultProvider = null;
  defaultProviderSettings = "";
};
