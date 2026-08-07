import { corsHeaders, jsonResponse } from '../_shared/cors.ts';
import { encryptPayload, parseProviderConfig } from '../_shared/crypto.ts';
import { getServiceClient, requireOrg, verifyInboxFlowJwt } from '../_shared/auth.ts';
import { resolveSmtpProvider, sendViaSmtp, verifySmtpConnection } from '../_shared/smtp.ts';
import {
  detectSmtpConfigIssues,
  detectSmtpDeliverabilityWarnings,
} from '../_shared/deliverability.ts';

function normalizeConfig(config: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) {
    if (v === undefined || v === null) continue;
    out[k] = String(v);
  }
  for (const key of ['secure', 'requireTLS', 'ignoreTLS']) {
    if (out[key] !== undefined) {
      out[key] = ['true', '1', 'yes', 'on'].includes(out[key].toLowerCase()) ? 'true' : 'false';
    }
  }
  if (out.encryption) {
    const enc = out.encryption.toUpperCase();
    if (enc === 'SSL' || enc === 'TLS') {
      out.secure = 'true';
      out.requireTLS = 'false';
    } else if (enc === 'STARTTLS') {
      out.secure = 'false';
      out.requireTLS = 'true';
    }
  }
  return out;
}

function mapPublicProvider(row: Record<string, unknown>, encryptionKey: string) {
  const config = parseProviderConfig(row.config, encryptionKey);
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    type: row.type,
    isDefault: row.isDefault,
    isActive: row.isActive,
    priority: row.priority,
    dailyLimit: row.dailyLimit,
    hourlyLimit: row.hourlyLimit,
    notes: row.notes,
    lastTestStatus: row.lastTestStatus || 'Pending',
    lastTestAt: row.lastTestAt,
    lastTestError: row.lastTestError,
    sentToday: row.sentToday,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    host: config.host,
    port: config.port,
    encryption: config.encryption || (config.secure === 'true' ? 'SSL' : 'STARTTLS'),
    fromEmail: config.fromEmail,
    fromName: config.fromName,
    replyTo: config.replyTo,
    user: config.user,
    hasPassword: Boolean(config.pass),
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const auth = await verifyInboxFlowJwt(req);
    if (auth instanceof Response) return auth;

    const encryptionKey = Deno.env.get('ENCRYPTION_KEY');
    if (!encryptionKey || encryptionKey.length < 32) {
      return jsonResponse({ error: 'ENCRYPTION_KEY is not configured on Edge Functions' }, 500);
    }

    const orgId = requireOrg(auth.organizationId);
    const db = getServiceClient();
    const body = await req.json() as Record<string, unknown>;
    const action = String(body.action ?? 'list').trim().toLowerCase();

    if (action === 'list') {
      const { data, error } = await db
        .from('EmailProvider')
        .select('*')
        .eq('organizationId', orgId)
        .eq('type', 'SMTP')
        .order('createdAt', { ascending: false });

      if (error) throw error;

      const accounts = (data ?? []).map((row) => mapPublicProvider(row, encryptionKey));
      return jsonResponse({ ok: true, accounts });
    }

    if (action === 'create') {
      const config = normalizeConfig((body.config || {}) as Record<string, string>);
      if (!config.host || !config.user || !config.pass) {
        return jsonResponse({ error: 'host, user, and pass are required' }, 400);
      }

      const issues = detectSmtpConfigIssues(config);
      const deliverabilityWarnings = detectSmtpDeliverabilityWarnings(config);

      if (issues.length > 0) {
        return jsonResponse({
          ok: false,
          success: false,
          error: 'Fix SMTP configuration issues before saving.',
          issues,
          deliverabilityWarnings,
        }, 400);
      }

      let testPassed = false;
      let testMessage = '';
      try {
        await verifySmtpConnection({
          id: 'test',
          host: config.host,
          port: Number(config.port || 587),
          secure: config.secure === 'true' || config.encryption === 'SSL' || String(config.port || '587') === '465',
          user: config.user,
          pass: config.pass,
          fromName: config.fromName || '',
          fromEmail: config.fromEmail || config.user,
          isDefault: Boolean(body.isDefault),
        });
        testPassed = true;
      } catch (error) {
        testMessage = error instanceof Error ? error.message : 'Connection failed';
      }

      if (!testPassed) {
        return jsonResponse({
          ok: false,
          success: false,
          error: `SMTP was NOT saved — connection test failed. Fix credentials first.\n\n${testMessage}`,
          issues,
          deliverabilityWarnings,
        }, 400);
      }

      const isActive = Boolean(body.isActive);
      const { data, error } = await db
        .from('EmailProvider')
        .insert({
          name: String(body.name || config.fromEmail || config.user || 'SMTP'),
          label: body.label ? String(body.label) : null,
          type: 'SMTP',
          isDefault: Boolean(body.isDefault),
          isActive,
          priority: Number(body.priority ?? 0),
          dailyLimit: body.dailyLimit ? Number(body.dailyLimit) : null,
          hourlyLimit: body.hourlyLimit ? Number(body.hourlyLimit) : null,
          notes: body.notes ? String(body.notes) : null,
          lastTestStatus: 'Connected',
          lastTestAt: new Date().toISOString(),
          lastTestError: null,
          organizationId: orgId,
          config: { encrypted: encryptPayload(JSON.stringify(config), encryptionKey) },
        })
        .select('*')
        .single();

      if (error) throw error;
      return jsonResponse({
        ok: true,
        account: mapPublicProvider(data, encryptionKey),
        issues,
        deliverabilityWarnings,
      });
    }

    if (action === 'update') {
      const id = String(body.id ?? '').trim();
      if (!id) return jsonResponse({ error: 'id is required' }, 400);

      const { data: existing, error: existingError } = await db
        .from('EmailProvider')
        .select('*')
        .eq('id', id)
        .eq('organizationId', orgId)
        .maybeSingle();

      if (existingError) throw existingError;
      if (!existing) return jsonResponse({ error: 'SMTP profile not found' }, 404);

      const currentConfig = parseProviderConfig(existing.config, encryptionKey);
      const patch = normalizeConfig((body.config || {}) as Record<string, string>);
      const merged = { ...currentConfig, ...patch };
      if (!patch.pass || patch.pass === '••••••••') merged.pass = currentConfig.pass;

      const credentialsChanged =
        patch.pass && patch.pass !== '••••••••' && patch.pass !== currentConfig.pass ||
        (patch.host && String(patch.host).trim() !== String(currentConfig.host || '').trim()) ||
        (patch.user && String(patch.user).trim() !== String(currentConfig.user || '').trim()) ||
        (patch.port && String(patch.port).trim() !== String(currentConfig.port || '').trim()) ||
        (patch.fromEmail && String(patch.fromEmail).trim() !== String(currentConfig.fromEmail || '').trim());

      const issues = detectSmtpConfigIssues(merged);
      const deliverabilityWarnings = detectSmtpDeliverabilityWarnings(merged);

      if (issues.length) {
        return jsonResponse({
          ok: false,
          success: false,
          error: 'Fix SMTP configuration issues before saving.',
          issues,
          deliverabilityWarnings,
        }, 400);
      }

      const update: Record<string, unknown> = {
        config: { encrypted: encryptPayload(JSON.stringify(merged), encryptionKey) },
        updatedAt: new Date().toISOString(),
      };

      for (const key of ['name', 'label', 'notes', 'isDefault', 'priority', 'dailyLimit', 'hourlyLimit']) {
        if (body[key] !== undefined) update[key] = body[key];
      }

      if (body.isActive !== undefined) {
        if (credentialsChanged || Boolean(body.isActive)) {
          try {
            await verifySmtpConnection({
              id,
              host: merged.host,
              port: Number(merged.port || 587),
              secure: merged.secure === 'true' || merged.encryption === 'SSL' || String(merged.port || '587') === '465',
              user: merged.user,
              pass: merged.pass,
              fromName: merged.fromName || '',
              fromEmail: merged.fromEmail || merged.user,
              isDefault: Boolean(body.isDefault),
            });
          } catch (error) {
            return jsonResponse({
              ok: false,
              success: false,
              error: 'Saved, but activation blocked — connection test failed',
              issues,
              deliverabilityWarnings,
            }, 400);
          }
        }
        update.isActive = body.isActive;
        update.lastTestStatus = 'Connected';
        update.lastTestAt = new Date().toISOString();
        update.lastTestError = null;
      }

      const { data, error } = await db
        .from('EmailProvider')
        .update(update)
        .eq('id', id)
        .select('*')
        .single();

      if (error) throw error;
      return jsonResponse({
        ok: true,
        account: mapPublicProvider(data, encryptionKey),
        issues,
        deliverabilityWarnings,
      });
    }

    if (action === 'delete') {
      const id = String(body.id ?? '').trim();
      if (!id) return jsonResponse({ error: 'id is required' }, 400);

      const { error } = await db
        .from('EmailProvider')
        .delete()
        .eq('id', id)
        .eq('organizationId', orgId);

      if (error) throw error;
      return jsonResponse({ ok: true });
    }

    if (action === 'test') {
      const providerId = body.providerId ? String(body.providerId) : null;
      const inlineConfig = body.config ? normalizeConfig(body.config as Record<string, string>) : null;
      const sendTestEmail = Boolean(body.sendTestEmail);
      const skipLiveVerify = Boolean(body.skipLiveVerify);
      const testEmailTo = body.testEmailTo ? String(body.testEmailTo).trim() : '';

      if (sendTestEmail && !testEmailTo) {
        return jsonResponse({ error: 'testEmailTo is required when sendTestEmail is true' }, 400);
      }

      let smtp;
      if (providerId && providerId !== 'default') {
        const base = await resolveSmtpProvider(db, orgId, providerId, encryptionKey);
        const pass =
          inlineConfig?.pass && inlineConfig.pass !== '••••••••'
            ? inlineConfig.pass
            : base.pass;
        const port = Number(inlineConfig?.port || base.port || 587);
        smtp = {
          ...base,
          host: String(inlineConfig?.host || base.host),
          port,
          secure:
            inlineConfig?.secure === 'true' ||
            inlineConfig?.encryption === 'SSL' ||
            inlineConfig?.encryption === 'TLS' ||
            (inlineConfig?.encryption === 'STARTTLS' ? false : base.secure !== false && port === 465),
          user: String(inlineConfig?.user || base.user || ''),
          pass,
          fromName: String(inlineConfig?.fromName || base.fromName || '').trim(),
          fromEmail: String(inlineConfig?.fromEmail || base.fromEmail || inlineConfig?.user || base.user || ''),
        };
      } else if (inlineConfig?.host) {
        const port = Number(inlineConfig.port || 587);
        smtp = {
          id: 'test',
          host: inlineConfig.host,
          port,
          secure: inlineConfig.secure === 'true' || port === 465,
          user: String(inlineConfig.user || ''),
          pass: String(inlineConfig.pass || ''),
          fromName: String(inlineConfig.fromName || '').trim(),
          fromEmail: String(inlineConfig.fromEmail || inlineConfig.user || ''),
          isDefault: false,
        };
      } else {
        smtp = await resolveSmtpProvider(db, orgId, providerId, encryptionKey);
      }

      const issues = detectSmtpConfigIssues({
        host: smtp.host,
        port: smtp.port,
        user: smtp.user,
        pass: smtp.pass,
      });
      const deliverabilityWarnings = detectSmtpDeliverabilityWarnings({
        host: smtp.host,
        port: smtp.port,
        fromEmail: smtp.fromEmail,
        user: smtp.user,
      });

      if (skipLiveVerify && !sendTestEmail) {
        const success = issues.length === 0;
        const message = success ? 'Static checks passed' : `Static issues detected: ${issues.join(', ')}`;
        return jsonResponse({
          ok: true,
          success,
          message,
          error: success ? undefined : issues.join('\n'),
          issues,
          deliverabilityWarnings,
        });
      }

      const started = Date.now();
      try {
        await verifySmtpConnection(smtp);

        let messageId: string | undefined;
        let message = 'SMTP connection verified';

        if (sendTestEmail) {
          const notes = String(body.notes || inlineConfig?.notes || '').trim();
          const bodyText = notes || 'Your SMTP connection is working.';
          const bodyHtml = notes
            ? `<p>${notes.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>')}</p>`
            : '<p>Your SMTP connection is working.</p>';
          const fromName = String(smtp.fromName || '').trim();
          const sent = await sendViaSmtp(
            {
              to: testEmailTo,
              subject: 'SMTP connection test',
              text: bodyText,
              html: bodyHtml,
              fromEmail: smtp.fromEmail || smtp.user || 'noreply@localhost',
              fromName,
              replyTo: smtp.replyTo,
            },
            smtp,
          );
          messageId = sent.messageId;
          message = `Connected and sent test email to ${testEmailTo}`;
        }

        const status = 'Connected';
        if (providerId && providerId !== 'default') {
          await db.from('EmailProvider').update({
            lastTestStatus: status,
            lastTestAt: new Date().toISOString(),
            lastTestError: null,
          }).eq('id', providerId);
        }
        return jsonResponse({
          ok: true,
          success: true,
          message,
          messageId,
          issues,
          deliverabilityWarnings,
          details: {
            host: smtp.host,
            port: smtp.port,
            secure: smtp.secure,
            authenticated: true,
            responseTimeMs: Date.now() - started,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Connection failed';
        if (providerId && providerId !== 'default') {
          await db.from('EmailProvider').update({
            lastTestStatus: 'Failed',
            lastTestAt: new Date().toISOString(),
            lastTestError: message,
          }).eq('id', providerId);
        }
        return jsonResponse({
          ok: false,
          success: false,
          error: message,
          issues,
          deliverabilityWarnings,
        }, 400);
      }
    }

    return jsonResponse({ error: `Unknown action: ${action}` }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal error';
    console.error('[manage-smtp]', message);
    return jsonResponse({ error: message }, 500);
  }
});

