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
  editorJson?: { blocks?: Array<{ id: string; type: string; content: string }> } | null;
};

export const templateService = {
  async list(): Promise<EmailTemplateSummary[]> {
    const data = await api.get<{ templates: EmailTemplateSummary[] }>('/api/templates');
    return data.templates;
  },

  async get(id: string): Promise<EmailTemplate> {
    const data = await api.get<{ template: EmailTemplate }>(`/api/templates/${id}`);
    return data.template;
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
    }>('/api/import/html', input);
  },
};

export function templateHtmlToBlocks(html: string) {
  return [{ id: crypto.randomUUID(), type: 'html', content: html }];
}
