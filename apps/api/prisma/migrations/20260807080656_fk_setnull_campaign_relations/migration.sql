-- Migration: fk_setnull_campaign_relations
-- Non-destructive safety: Only REPLACES foreign key ON DELETE action from default (RESTRICT/NO ACTION)
-- to ON DELETE SET NULL so deletion of a referenced parent (SMTP provider, list, template,
-- segment, domain, creator user) unassigns the Campaign FK instead of causing FK violation crash.
-- NO data is dropped, NO columns altered, NO rows deleted. Entirely backward-compatible.

-- ---------------------------------------------------------------------------
-- 1. Campaign.createdBy (creator User)
-- ---------------------------------------------------------------------------
ALTER TABLE "Campaign" DROP CONSTRAINT IF EXISTS "Campaign_createdById_fkey";
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. Campaign.listId (ContactList)
-- ---------------------------------------------------------------------------
ALTER TABLE "Campaign" DROP CONSTRAINT IF EXISTS "Campaign_listId_fkey";
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_listId_fkey"
  FOREIGN KEY ("listId") REFERENCES "ContactList"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. Campaign.segmentId (Segment)
-- ---------------------------------------------------------------------------
ALTER TABLE "Campaign" DROP CONSTRAINT IF EXISTS "Campaign_segmentId_fkey";
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_segmentId_fkey"
  FOREIGN KEY ("segmentId") REFERENCES "Segment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. Campaign.templateId (Template)
-- ---------------------------------------------------------------------------
ALTER TABLE "Campaign" DROP CONSTRAINT IF EXISTS "Campaign_templateId_fkey";
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_templateId_fkey"
  FOREIGN KEY ("templateId") REFERENCES "Template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 5. Campaign.providerId (EmailProvider / SMTP)
-- ---------------------------------------------------------------------------
ALTER TABLE "Campaign" DROP CONSTRAINT IF EXISTS "Campaign_providerId_fkey";
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "EmailProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 6. Campaign.domainId (Domain)
-- ---------------------------------------------------------------------------
ALTER TABLE "Campaign" DROP CONSTRAINT IF EXISTS "Campaign_domainId_fkey";
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_domainId_fkey"
  FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE SET NULL ON UPDATE CASCADE;
