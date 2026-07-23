import type { FastifyInstance } from 'fastify';
import { OpenAI } from 'openai';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { sendError } from '../../utils/errors.js';
import { authenticate } from '../../middleware/auth.js';

const tones = ['professional', 'friendly', 'luxury', 'sales', 'educational'] as const;
const contentTypes = [
  'subject_lines',
  'headlines',
  'product_descriptions',
  'ctas',
  'email_body',
  'follow_ups',
  'welcome_emails',
  'promotional_emails',
  'newsletters',
] as const;

export async function aiRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.post('/generate', async (request, reply) => {
    try {
      const body = z
        .object({
          type: z.enum(contentTypes),
          tone: z.enum(tones).default('professional'),
          prompt: z.string().min(1),
          context: z.string().optional(),
          count: z.number().min(1).max(10).default(3),
        })
        .parse(request.body);

      if (!env.OPENAI_API_KEY) {
        return reply.send({
          results: getFallbackContent(body.type, body.tone, body.prompt, body.count),
          source: 'fallback',
          notice: 'OPENAI_API_KEY not configured. Returning template suggestions.',
        });
      }

      const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
      const system = `You are an expert email marketing copywriter focused on deliverability-safe messaging.
Avoid spam trigger phrases (act now, free!!!, guarantee, winner, etc.).
Tone: ${body.tone}.
Return valid JSON: { "results": string[] } with exactly ${body.count} alternatives.
Do not promise inbox placement. Write clear, honest, engaging copy.`;

      const completion = await client.chat.completions.create({
        model: env.OPENAI_MODEL,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: `Generate ${body.type.replace(/_/g, ' ')}.\nBrief: ${body.prompt}\n${body.context ? `Context: ${body.context}` : ''}`,
          },
        ],
        temperature: 0.8,
      });

      const raw = completion.choices[0]?.message?.content || '{"results":[]}';
      const parsed = JSON.parse(raw) as { results: string[] };
      return reply.send({ results: parsed.results || [], source: 'openai' });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/improve-subject', async (request, reply) => {
    try {
      const body = z.object({ subject: z.string(), tone: z.enum(tones).default('professional') }).parse(request.body);

      if (!env.OPENAI_API_KEY) {
        return reply.send({
          results: [
            body.subject.replace(/!+/g, '').trim(),
            `{{firstName}}, ${body.subject.replace(/!+/g, '').toLowerCase()}`.slice(0, 55),
            `A note about ${body.subject.replace(/!+/g, '').slice(0, 40)}`,
          ],
          source: 'fallback',
        });
      }

      const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
      const completion = await client.chat.completions.create({
        model: env.OPENAI_MODEL,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'Improve email subject lines for clarity, mobile length (<=50 chars preferred), and low spam risk. Return JSON { "results": string[] } with 5 options. Tone: ' +
              body.tone,
          },
          { role: 'user', content: body.subject },
        ],
      });
      const parsed = JSON.parse(completion.choices[0]?.message?.content || '{"results":[]}') as {
        results: string[];
      };
      return reply.send({ results: parsed.results, source: 'openai' });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

function getFallbackContent(
  type: (typeof contentTypes)[number],
  tone: string,
  prompt: string,
  count: number,
): string[] {
  const base = prompt.slice(0, 80);
  const map: Record<string, string[]> = {
    subject_lines: [
      `{{firstName}}, ${base}`,
      `Quick update: ${base}`,
      `Something we thought you would like`,
    ],
    headlines: [`Meet ${base}`, `Introducing a better way`, `Built for people like you`],
    product_descriptions: [
      `${base} helps you work smarter with less friction.`,
      `Designed for clarity and everyday use: ${base}.`,
      `A thoughtful take on ${base}.`,
    ],
    ctas: ['See the details', 'Explore the collection', 'Continue reading'],
    email_body: [
      `Hi {{firstName}},\n\nWe wanted to share an update about ${base}.\n\nHere is what is new and why it matters.\n\nBest regards`,
    ],
    follow_ups: [`Hi {{firstName}}, following up on ${base}. Happy to answer any questions.`],
    welcome_emails: [
      `Welcome aboard, {{firstName}}! Here is how to get started with ${base}.`,
    ],
    promotional_emails: [
      `{{firstName}}, enjoy a curated offer on ${base}. No pressure — available through Friday.`,
    ],
    newsletters: [`This week: insights on ${base}, tips from our team, and a resource you can use today.`],
  };
  return (map[type] || map.email_body).slice(0, count).map((s) => `[${tone}] ${s}`);
}
