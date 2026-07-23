import { AppError } from './errors.js';

export function requireOrg(orgId: string | null | undefined): string {
  if (!orgId) throw new AppError(400, 'No organization');
  return orgId;
}
