import { api } from '@/lib/api';

export type EmailTemplateSummary = {
  id: string;
  name: string;
  description?: string | null;
  isPublic?: boolean;
  updatedAt?: string;
};

export type EmailTemplate = EmailTemplateSummary & {
  htmlContent?: string | null;
  plainText?: string | null;
  editorJson?: {
    blocks?: Array<{ id: string; type: string; content: string }>;
    placeholderMap?: Record<string, string>;
  } | null;
};

export const templateService = {
  async list(): Promise<EmailTemplateSummary[]> {
    const data = await api.get<{ templates: EmailTemplateSummary[] }>('/api/templates');
    return Array.isArray(data.templates) ? data.templates : [];
  },

  async get(id: string): Promise<EmailTemplate> {
    const data = await api.get<{ template: EmailTemplate }>(`/api/templates/${id}`);
    const template = data.template;
    const raw = template?.editorJson as unknown;
    let editorJson: EmailTemplate['editorJson'] = template?.editorJson ?? null;
    if (typeof raw === 'string') {
      try {
        editorJson = (JSON.parse(raw) as EmailTemplate['editorJson']) ?? null;
      } catch {
        editorJson = null;
      }
    }
    return { ...template, editorJson: editorJson ?? null };
  },

  async update(
    id: string,
    input: {
      name?: string;
      description?: string | null;
      htmlContent?: string | null;
      plainText?: string | null;
      editorJson?: EmailTemplate['editorJson'];
    },
  ) {
    return api.patch<{ template: EmailTemplate }>(`/api/templates/${id}`, input);
  },

  async importHtml(input: {
    filename?: string;
    content: string;
    format?: 'html' | 'mjml';
    name?: string;
    templateName?: string;
    campaignId?: string;
    saveAsTemplate?: boolean;
  }) {
    return api.post<{
      html: string;
      plainText: string;
      template?: EmailTemplate;
      validation: { warnings: string[]; flags: string[] };
      scrubbed?: boolean;
      removed?: string[];
    }>('/api/import/html', input);
  },
};

export function templateHtmlToBlocks(html: string) {
  return [{ id: crypto.randomUUID(), type: 'html', content: html }];
}
