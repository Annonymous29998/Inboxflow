const byOrg = new Map<string, string>();

/** The desktop worker has no HTTP request. Keep the latest login for that PC. */
export function rememberCloudAuthorization(
  organizationId: string | null | undefined,
  authorization: string | null | undefined,
) {
  const org = String(organizationId || '').trim();
  const header = String(authorization || '').trim();
  if (!org || !/^bearer\s+\S+/i.test(header)) return;
  byOrg.set(org, header);
}

export function cloudAuthorizationFor(organizationId: string | null | undefined): string | null {
  const org = String(organizationId || '').trim();
  return org ? byOrg.get(org) || null : null;
}
