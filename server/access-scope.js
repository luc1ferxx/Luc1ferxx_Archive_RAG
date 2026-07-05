export const normalizeScopeText = (value) =>
  String(value ?? "").replace(/\s+/g, " ").trim();

export const normalizeScopeId = (value) =>
  normalizeScopeText(value).toLowerCase();

export const toScopeArray = (value) => {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    return value.split(",");
  }

  return value === undefined || value === null ? [] : [value];
};

export const normalizeScopeIds = (value) => [
  ...new Set(toScopeArray(value).map(normalizeScopeId).filter(Boolean)),
];

export const normalizeAccessPrincipalPermissions = (principal = {}) =>
  normalizeScopeIds(
    principal.permissionIds ??
      principal.permission_ids ??
      principal.permissions ??
      principal.permission
  );

export const normalizeAccessPrincipalRoles = (principal = {}) =>
  normalizeScopeIds(
    principal.roleIds ?? principal.role_ids ?? principal.roles ?? principal.role
  );

export const addAccessPrincipalAuthorizationMetadata = (
  target,
  principal = {}
) => {
  const permissionIds = normalizeAccessPrincipalPermissions(principal);
  const roleIds = normalizeAccessPrincipalRoles(principal);

  if (permissionIds.length > 0) {
    target.permissionIds = permissionIds;
  }

  if (roleIds.length > 0) {
    target.roleIds = roleIds;
  }

  return target;
};
