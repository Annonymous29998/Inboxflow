import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';

/**
 * Remove contacts from the audience without wiping campaign open/click history.
 * - Always removes list memberships + tags
 * - Contacts that appear on any campaign keep their rows + tracking (status → CLEANED)
 * - Contacts with no campaign history are hard-deleted
 */
export async function removeContactsFromAudience(orgId: string, contactIds: string[]) {
  const ids = [...new Set(contactIds.filter(Boolean))];
  if (!ids.length) {
    return { removed: 0, archived: 0, deleted: 0 };
  }

  await prisma.contactListMember.deleteMany({ where: { contactId: { in: ids } } });
  await prisma.contactTag.deleteMany({ where: { contactId: { in: ids } } });

  const withHistory = await prisma.campaignRecipient.findMany({
    where: { contactId: { in: ids } },
    select: { contactId: true },
    distinct: ['contactId'],
  });
  const hist = new Set(withHistory.map((r) => r.contactId));
  const toArchive = ids.filter((id) => hist.has(id));
  const toDelete = ids.filter((id) => !hist.has(id));

  if (toArchive.length) {
    await prisma.contact.updateMany({
      where: { organizationId: orgId, id: { in: toArchive } },
      data: { status: 'CLEANED' },
    });
  }

  if (toDelete.length) {
    // No campaign recipients → safe to hard-delete. TrackingEvent uses SetNull.
    await prisma.contact.deleteMany({
      where: { organizationId: orgId, id: { in: toDelete } },
    });
  }

  return {
    removed: ids.length,
    archived: toArchive.length,
    deleted: toDelete.length,
  };
}

export function audienceContactWhere(
  orgId: string,
  extra: Prisma.ContactWhereInput = {},
  opts: { includeCleaned?: boolean } = {},
): Prisma.ContactWhereInput {
  const where: Prisma.ContactWhereInput = { organizationId: orgId, ...extra };
  if (!opts.includeCleaned && !extra.status) {
    where.status = { not: 'CLEANED' };
  }
  return where;
}
