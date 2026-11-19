/** Admin / operator control panel vs created-user mailer (inboxflow-mailer). */

export function isStaffRole(role?: string | null) {
  return role === 'SUPER_ADMIN' || role === 'ADMIN';
}

/** Users the admin creates (role USER) — they get the mailer UI, not the operator dashboard. */
export function isMailerTenant(role?: string | null) {
  return Boolean(role) && !isStaffRole(role);
}

/** Created users must Bind PC on the EXE before the mailer. Staff never bind. */
export function tenantNeedsBind(user?: { role?: string | null; boundIp?: string | null } | null) {
  return isMailerTenant(user?.role) && !user?.boundIp;
}
