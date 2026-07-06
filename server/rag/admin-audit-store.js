import {
  getAdminAuditRetentionDays,
  getAdminAuditStoreConfigStatus,
} from "./config.js";
import {
  createAdminAuditService,
  createInMemoryAdminAuditStore,
} from "./admin-audit.js";
import { createPostgresAdminAuditStore } from "./postgres-admin-audit-store.js";

export const createDefaultAdminAuditService = ({
  memory = {},
  postgres = {},
  service = {},
} = {}) => {
  const configStatus = getAdminAuditStoreConfigStatus();
  const store =
    configStatus.backend === "postgres"
      ? createPostgresAdminAuditStore({
          retentionDays: getAdminAuditRetentionDays(),
          ...postgres,
        })
      : createInMemoryAdminAuditStore(memory);

  return createAdminAuditService({
    store,
    ...service,
  });
};
