import { corsHeaders } from '../_shared/cors.ts';
import { getServiceClient } from '../_shared/auth.ts';
import { isSafeRedirectUrl, verifyClickRedirect } from '../_shared/signed-urls.ts';

const TRANSPARENT_GIF = Uint8Array.from(
  atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
  (c) => c.charCodeAt(0),
);

function parseUa(ua: string | undefined) {
  const u = (ua || '').toLowerCase();
  let device = 'desktop';
  if (/mobile|android|iphone/.test(u)) device = 'mobile';
  else if (/ipad|tablet/.test(u)) device = 'tablet';

  let emailClient = 'unknown';
  if (u.includes('googleimageproxy') || u.includes('gmail')) emailClient = 'gmail';
  else if (u.includes('outlook') || u.includes('microsoft')) emailClient = 'outlook';
  else if (u.includes('applewebkit') && u.includes('mail')) emailClient = 'apple_mail';

  return { device, emailClient };
}

function gifResponse() {
  return new Response(TRANSPARENT_GIF, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get('action')?.trim().toLowerCase();
  const campaignId = url.searchParams.get('campaignId')?.trim() ?? '';
  const contactId = url.searchParams.get('contactId')?.trim() ?? '';

  if (!campaignId || !contactId) {
    return action === 'open'
      ? gifResponse()
      : new Response('Missing campaignId or contactId', { status: 400, headers: corsHeaders });
  }

  const db = getServiceClient();
  const ua = parseUa(req.headers.get('user-agent') ?? undefined);
  const ipAddress = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

  if (action === 'open') {
    try {
      const { data: existing } = await db
        .from('TrackingEvent')
        .select('id')
        .eq('campaignId', campaignId)
        .eq('contactId', contactId)
        .eq('type', 'OPENED')
        .limit(1)
        .maybeSingle();

      await db.from('TrackingEvent').insert({
        type: 'OPENED',
        campaignId,
        contactId,
        userAgent: req.headers.get('user-agent'),
        ipAddress,
        device: ua.device,
        emailClient: ua.emailClient,
      });

      if (!existing) {
        await db
          .from('CampaignRecipient')
          .update({ openedAt: new Date().toISOString() })
          .eq('campaignId', campaignId)
          .eq('contactId', contactId);
      }
    } catch (error) {
      console.error('[email-track] open', error);
    }
    return gifResponse();
  }

  if (action === 'click') {
    const destination = url.searchParams.get('u')?.trim() ?? '';
    const signature = url.searchParams.get('s')?.trim();

    if (!isSafeRedirectUrl(destination) || !verifyClickRedirect(campaignId, contactId, destination, signature)) {
      return new Response('Invalid destination', { status: 400, headers: corsHeaders });
    }

    try {
      await db.from('TrackingEvent').insert({
        type: 'CLICKED',
        campaignId,
        contactId,
        url: destination,
        userAgent: req.headers.get('user-agent'),
        ipAddress,
        device: ua.device,
        emailClient: ua.emailClient,
      });

      await db
        .from('CampaignRecipient')
        .update({ clickedAt: new Date().toISOString() })
        .eq('campaignId', campaignId)
        .eq('contactId', contactId);
    } catch (error) {
      console.error('[email-track] click', error);
    }

    return Response.redirect(destination, 302);
  }

  return new Response('Unknown action', { status: 400, headers: corsHeaders });
});
