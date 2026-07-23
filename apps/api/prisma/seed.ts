import bcrypt from 'bcryptjs';
import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { PrismaClient } from '@prisma/client';

for (const path of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
  if (existsSync(path)) {
    dotenvConfig({ path });
    break;
  }
}

const prisma = new PrismaClient();

async function main() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL?.trim();
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    throw new Error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in apps/api/.env before seeding.');
  }

  const plans = [
    {
      name: 'Starter',
      slug: 'starter',
      description: 'For individuals getting started',
      priceCents: 0,
      contactLimit: 1000,
      emailLimit: 5000,
      features: ['1 domain', 'Basic analytics', 'Deliverability analyzer'],
    },
    {
      name: 'Growth',
      slug: 'growth',
      description: 'For growing teams',
      priceCents: 4900,
      contactLimit: 10000,
      emailLimit: 50000,
      features: ['5 domains', 'AI assistant', 'Advanced analytics', 'Priority support'],
    },
    {
      name: 'Business',
      slug: 'business',
      description: 'For high-volume senders',
      priceCents: 14900,
      contactLimit: 100000,
      emailLimit: 500000,
      features: ['Unlimited domains', 'SSO', 'Dedicated IP guidance', 'Custom tracking'],
    },
  ];

  for (const plan of plans) {
    await prisma.plan.upsert({
      where: { slug: plan.slug },
      create: plan,
      update: plan,
    });
  }

  const passwordHash = await bcrypt.hash(adminPassword, 12);

  const org = await prisma.organization.upsert({
    where: { slug: 'inboxflow' },
    create: {
      name: 'Inbox Flow',
      slug: 'inboxflow',
      website: 'https://inboxflow.io',
    },
    update: {
      name: 'Inbox Flow',
      website: 'https://inboxflow.io',
    },
  });

  const legacyEmails = ['demo@inboxflow.io', 'demo@i-coffee.ng'].filter((e) => e !== adminEmail);
  if (legacyEmails.length) {
    await prisma.user.deleteMany({ where: { email: { in: legacyEmails } } });
  }

  const user = await prisma.user.upsert({
    where: { email: adminEmail },
    create: {
      email: adminEmail,
      passwordHash,
      firstName: 'Admin',
      lastName: 'User',
      role: 'ADMIN',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      organizationId: org.id,
    },
    update: {
      passwordHash,
      organizationId: org.id,
      status: 'ACTIVE',
      role: 'ADMIN',
    },
  });

  const starter = await prisma.plan.findUnique({ where: { slug: 'starter' } });
  if (starter) {
    await prisma.subscription.upsert({
      where: { organizationId: org.id },
      create: {
        organizationId: org.id,
        planId: starter.id,
        status: 'ACTIVE',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
      update: {},
    });
  }

  console.log('Seed complete');
  console.log(`Admin login: ${adminEmail}`);
  console.log('User id:', user.id);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
