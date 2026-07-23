import { corsHeaders, jsonResponse } from '../_shared/cors.ts';
import { processCampaignBatch } from '../_shared/background-worker.ts';

function isServiceRole(req: Request): boolean {
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const serviceKey =
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY') ?? '';
  return Boolean(token && serviceKey && token === serviceKey);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  if (!isServiceRole(req)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  try {
    const body = await req.json() as { campaignId?: string };
    const campaignId = String(body.campaignId ?? '').trim();
    if (!campaignId) {
      return jsonResponse({ error: 'campaignId is required' }, 400);
    }

    const result = await processCampaignBatch(campaignId);
    return jsonResponse({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Worker failed';
    console.error('[campaign-background-worker]', message);
    return jsonResponse({ error: message }, 500);
  }
});
