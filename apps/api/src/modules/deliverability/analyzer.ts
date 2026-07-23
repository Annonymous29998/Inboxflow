export type IssueSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface DeliverabilityIssue {
  id: string;
  category:
    | 'content'
    | 'subject'
    | 'html'
    | 'links'
    | 'images'
    | 'authentication'
    | 'compliance'
    | 'accessibility'
    | 'mobile'
    | 'personalization'
    | 'size';
  severity: IssueSeverity;
  title: string;
  explanation: string;
  suggestedFix: string;
  scoreImpact: number;
}

export interface CategoryScore {
  category: string;
  score: number;
  maxScore: number;
}

export interface DeliverabilityReport {
  score: number;
  rating: 'excellent' | 'good' | 'needs_improvement' | 'high_risk';
  issues: DeliverabilityIssue[];
  categories: CategoryScore[];
  inboxReadiness: {
    overall: number;
    breakdown: Record<string, number>;
    recommendations: string[];
  };
  subjectAnalysis?: SubjectLineAnalysis;
  analyzedAt: string;
}

export interface SubjectLineAnalysis {
  score: number;
  length: number;
  hasPersonalization: boolean;
  mobileFriendly: boolean;
  spamRisk: number;
  alternatives: string[];
  issues: string[];
}

export interface AnalyzeInput {
  subject?: string | null;
  previewText?: string | null;
  htmlContent?: string | null;
  plainTextContent?: string | null;
  senderName?: string | null;
  senderEmail?: string | null;
  physicalAddress?: string | null;
  authStatus?: {
    spf: boolean;
    dkim: boolean;
    dmarc: boolean;
    bimi?: boolean;
  };
}

const SPAM_PHRASES = [
  { phrase: 'act now', severity: 'medium' as const, fix: 'Use a specific deadline instead, e.g. "Offer ends Friday".' },
  { phrase: 'limited time', severity: 'low' as const, fix: 'State the actual end date to reduce urgency spam signals.' },
  { phrase: 'buy now', severity: 'medium' as const, fix: 'Try a softer CTA like "Shop the collection" or "See what\'s new".' },
  { phrase: 'click here', severity: 'medium' as const, fix: 'Use descriptive link text that explains the destination.' },
  { phrase: 'free!!!', severity: 'high' as const, fix: 'Avoid stacked punctuation; say "Complimentary" or "Included at no cost".' },
  { phrase: 'congratulations', severity: 'medium' as const, fix: 'Use a specific, credible reason for congratulations.' },
  { phrase: 'no obligation', severity: 'medium' as const, fix: 'Explain terms clearly instead of using stock sales phrases.' },
  { phrase: 'risk free', severity: 'medium' as const, fix: 'Describe your guarantee in plain language.' },
  { phrase: 'order now', severity: 'low' as const, fix: 'Prefer "Complete your order" or product-specific CTAs.' },
  { phrase: 'winner', severity: 'high' as const, fix: 'Avoid prize/winner language unless the recipient truly won something.' },
  { phrase: 'cash bonus', severity: 'high' as const, fix: 'Remove financial incentive phrasing that triggers spam filters.' },
  { phrase: 'double your', severity: 'high' as const, fix: 'Avoid exaggerated claims; use measurable, truthful benefits.' },
  { phrase: '100% free', severity: 'high' as const, fix: 'Say what is included without absolute free claims.' },
  { phrase: 'urgent', severity: 'medium' as const, fix: 'Replace with a concrete reason and deadline.' },
  { phrase: 'asap', severity: 'medium' as const, fix: 'Specify timing instead of vague urgency.' },
  { phrase: 'guaranteed', severity: 'medium' as const, fix: 'Qualify claims with accurate conditions.' },
  { phrase: 'no credit check', severity: 'high' as const, fix: 'Avoid financial spam trigger phrases.' },
  { phrase: 'make money', severity: 'critical' as const, fix: 'Remove get-rich-quick language entirely.' },
  { phrase: 'dear friend', severity: 'high' as const, fix: 'Use the recipient\'s name or a relevant greeting.' },
  { phrase: 'this is not spam', severity: 'critical' as const, fix: 'Never claim "not spam" — it increases filter suspicion.' },
];

const SEVERITY_WEIGHT: Record<IssueSeverity, number> = {
  info: 1,
  low: 3,
  medium: 6,
  high: 12,
  critical: 20,
};

function extractLinks(html: string): string[] {
  const matches = html.matchAll(/href=["']([^"']+)["']/gi);
  return [...matches].map((m) => m[1]).filter((u) => u && !u.startsWith('mailto:') && !u.startsWith('#'));
}

function extractImages(html: string): { src: string; alt: string | null }[] {
  const matches = [...html.matchAll(/<img[^>]*>/gi)];
  return matches.map((m) => {
    const tag = m[0];
    const src = tag.match(/src=["']([^"']+)["']/i)?.[1] ?? '';
    const altMatch = tag.match(/alt=["']([^"']*)["']/i);
    return { src, alt: altMatch ? altMatch[1] : null };
  });
}

function countExclamations(text: string): number {
  return (text.match(/!/g) || []).length;
}

function percentCaps(text: string): number {
  const letters = text.replace(/[^a-zA-Z]/g, '');
  if (!letters.length) return 0;
  const caps = letters.replace(/[^A-Z]/g, '').length;
  return (caps / letters.length) * 100;
}

function hasUnsubscribe(html: string, text: string): boolean {
  const combined = `${html} ${text}`.toLowerCase();
  return (
    combined.includes('unsubscribe') ||
    combined.includes('opt-out') ||
    combined.includes('opt out') ||
    combined.includes('list-unsubscribe')
  );
}

function hasPersonalization(content: string): boolean {
  return /\{\{\s*(firstName|first_name|name|email)\s*\}\}/i.test(content) ||
    /%recipient\./i.test(content);
}

function ratingFromScore(score: number): DeliverabilityReport['rating'] {
  if (score >= 85) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 50) return 'needs_improvement';
  return 'high_risk';
}

export function analyzeSubjectLine(subject: string): SubjectLineAnalysis {
  const issues: string[] = [];
  let score = 100;
  const length = subject.length;

  if (length === 0) {
    issues.push('Subject line is empty.');
    score -= 40;
  } else if (length < 20) {
    issues.push('Subject is short; consider 30–50 characters for clarity.');
    score -= 10;
  } else if (length > 60) {
    issues.push('Subject may truncate on mobile (aim for ≤60 characters).');
    score -= 15;
  } else if (length > 50) {
    issues.push('Subject is a bit long for some mobile clients.');
    score -= 5;
  }

  if (subject === subject.toUpperCase() && subject.length > 5) {
    issues.push('All-caps subjects look spammy and reduce opens.');
    score -= 25;
  }

  if (countExclamations(subject) > 1) {
    issues.push('Multiple exclamation marks increase spam risk.');
    score -= 15;
  } else if (countExclamations(subject) === 1) {
    score -= 3;
  }

  let spamRisk = 0;
  for (const { phrase } of SPAM_PHRASES) {
    if (subject.toLowerCase().includes(phrase)) {
      issues.push(`Subject contains trigger phrase: "${phrase}".`);
      spamRisk += 15;
      score -= 10;
    }
  }

  const hasPersonalization = /\{\{|%recipient|first.?name/i.test(subject);
  if (!hasPersonalization) {
    issues.push('No personalization tokens detected in subject.');
    score -= 5;
  } else {
    score += 5;
  }

  const mobileFriendly = length > 0 && length <= 40;
  if (!mobileFriendly && length > 0) {
    issues.push('For best mobile display, keep subjects under ~40 characters.');
  }

  const alternatives = generateSubjectAlternatives(subject);

  return {
    score: Math.max(0, Math.min(100, score)),
    length,
    hasPersonalization,
    mobileFriendly,
    spamRisk: Math.min(100, spamRisk),
    alternatives,
    issues,
  };
}

function generateSubjectAlternatives(subject: string): string[] {
  if (!subject.trim()) {
    return [
      '{{firstName}}, something new for you',
      'A quick update from us',
      'What we prepared for you this week',
    ];
  }

  const cleaned = subject
    .replace(/!+/g, '')
    .replace(/\b(urgent|asap|act now|buy now)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  return [
    cleaned || subject,
    `{{firstName}}, ${cleaned.charAt(0).toLowerCase()}${cleaned.slice(1)}`.slice(0, 60),
    cleaned.length > 40 ? `${cleaned.slice(0, 37)}...` : `Quick note: ${cleaned}`.slice(0, 55),
  ].filter((s, i, arr) => s && arr.indexOf(s) === i);
}

export function analyzeCampaign(input: AnalyzeInput): DeliverabilityReport {
  const issues: DeliverabilityIssue[] = [];
  const html = input.htmlContent ?? '';
  const plain = input.plainTextContent ?? (html ? stripToText(html) : '');
  const subject = input.subject ?? '';
  const preview = input.previewText ?? '';
  const combinedText = `${subject} ${preview} ${plain}`.toLowerCase();

  // Subject
  const subjectAnalysis = analyzeSubjectLine(subject);
  for (const issue of subjectAnalysis.issues) {
    issues.push({
      id: `subject-${issues.length}`,
      category: 'subject',
      severity: issue.includes('empty') ? 'critical' : issue.includes('spam') || issue.includes('All-caps') ? 'high' : 'medium',
      title: issue,
      explanation: 'Subject lines heavily influence open rates and spam filtering.',
      suggestedFix: subjectAnalysis.alternatives[0] ?? 'Rewrite with clarity and a specific benefit.',
      scoreImpact: SEVERITY_WEIGHT.medium,
    });
  }

  if (!preview || preview.length < 20) {
    issues.push({
      id: 'preview-missing',
      category: 'subject',
      severity: 'medium',
      title: 'Preview text is missing or too short',
      explanation: 'Inbox clients show preview text next to the subject; empty previews waste engagement opportunity.',
      suggestedFix: 'Add 40–90 characters of supporting preview text that complements the subject.',
      scoreImpact: 6,
    });
  }

  // Spam phrases in body
  for (const { phrase, severity, fix } of SPAM_PHRASES) {
    if (combinedText.includes(phrase)) {
      issues.push({
        id: `spam-${phrase.replace(/\s+/g, '-')}`,
        category: 'content',
        severity,
        title: `Content contains spam trigger phrase: "${phrase}"`,
        explanation: 'Certain promotional phrases are commonly associated with spam and can lower inbox placement.',
        suggestedFix: fix,
        scoreImpact: SEVERITY_WEIGHT[severity],
      });
    }
  }

  // Caps
  const capsPct = percentCaps(plain || subject);
  if (capsPct > 40) {
    issues.push({
      id: 'excessive-caps',
      category: 'content',
      severity: 'high',
      title: 'Excessive capitalization detected',
      explanation: 'Large amounts of ALL CAPS text are a classic spam signal and hurt readability.',
      suggestedFix: 'Use sentence case. Reserve caps for short acronyms only.',
      scoreImpact: 12,
    });
  }

  // Exclamations
  const excl = countExclamations(`${subject} ${plain}`);
  if (excl > 5) {
    issues.push({
      id: 'excessive-exclamations',
      category: 'content',
      severity: 'medium',
      title: 'Too many exclamation marks',
      explanation: `Found ${excl} exclamation marks. Excessive punctuation looks promotional.`,
      suggestedFix: 'Limit to one or two exclamation marks across the entire email.',
      scoreImpact: 6,
    });
  }

  // Links
  const links = extractLinks(html);
  if (links.length > 15) {
    issues.push({
      id: 'too-many-links',
      category: 'links',
      severity: 'high',
      title: `Too many links (${links.length})`,
      explanation: 'Emails with many links are more likely to be filtered as promotional or phishing.',
      suggestedFix: 'Keep primary CTAs to 2–5 links. Remove redundant navigation links.',
      scoreImpact: 12,
    });
  } else if (links.length > 10) {
    issues.push({
      id: 'many-links',
      category: 'links',
      severity: 'medium',
      title: `Elevated link count (${links.length})`,
      explanation: 'Higher link density can reduce trust with spam filters.',
      suggestedFix: 'Consolidate links and ensure each has clear descriptive anchor text.',
      scoreImpact: 6,
    });
  }

  for (const link of links) {
    if (link.startsWith('http://')) {
      issues.push({
        id: `insecure-link-${link.slice(0, 30)}`,
        category: 'links',
        severity: 'medium',
        title: 'Insecure HTTP link detected',
        explanation: `Link uses HTTP instead of HTTPS: ${link}`,
        suggestedFix: 'Upgrade all links to HTTPS.',
        scoreImpact: 3,
      });
      break;
    }
  }

  // Images
  const images = extractImages(html);
  const missingAlt = images.filter((i) => i.alt === null || i.alt === '');
  if (missingAlt.length > 0) {
    issues.push({
      id: 'missing-alt',
      category: 'images',
      severity: 'medium',
      title: `${missingAlt.length} image(s) missing alt text`,
      explanation: 'Alt text improves accessibility and provides fallback when images are blocked.',
      suggestedFix: 'Add concise, descriptive alt attributes to every image.',
      scoreImpact: 6,
    });
  }

  const textLen = plain.length;
  const imageOnly = images.length > 0 && textLen < 50;
  if (imageOnly) {
    issues.push({
      id: 'image-only',
      category: 'images',
      severity: 'high',
      title: 'Image-only or near image-only email',
      explanation: 'Filters distrust emails that rely almost entirely on images with little text.',
      suggestedFix: 'Add a meaningful plain-text and HTML text version of your message.',
      scoreImpact: 12,
    });
  }

  // Link/image ratio
  if (images.length > 0 && links.length / Math.max(images.length, 1) > 3) {
    issues.push({
      id: 'link-image-ratio',
      category: 'links',
      severity: 'low',
      title: 'High link-to-image ratio',
      explanation: 'Many links relative to images can look like a link farm.',
      suggestedFix: 'Balance content with clear sections and fewer redundant links.',
      scoreImpact: 3,
    });
  }

  // HTML quality
  if (html && !html.includes('<html') && !html.includes('<table') && !html.includes('<div')) {
    issues.push({
      id: 'weak-html',
      category: 'html',
      severity: 'low',
      title: 'HTML structure looks incomplete',
      explanation: 'Email clients expect well-structured HTML, preferably table-based or MJML-compiled layouts.',
      suggestedFix: 'Use the visual builder or export valid email HTML/MJML.',
      scoreImpact: 3,
    });
  }

  if (html && /style\s*=\s*["'][^"']*font-size\s*:\s*[0-2](\.[0-9]+)?px/i.test(html)) {
    issues.push({
      id: 'tiny-text',
      category: 'content',
      severity: 'high',
      title: 'Hidden or tiny text detected',
      explanation: 'Very small text is often used to hide keywords and is a strong spam signal.',
      suggestedFix: 'Use readable font sizes (at least 14px for body text).',
      scoreImpact: 12,
    });
  }

  // Plain text
  if (html && (!input.plainTextContent || input.plainTextContent.length < 20)) {
    issues.push({
      id: 'missing-plaintext',
      category: 'html',
      severity: 'medium',
      title: 'Missing or weak plain-text version',
      explanation: 'Multipart emails with a plain-text alternative improve deliverability and accessibility.',
      suggestedFix: 'Generate a plain-text version that mirrors your HTML content.',
      scoreImpact: 6,
    });
  }

  // Length
  if (textLen > 0 && textLen < 40) {
    issues.push({
      id: 'too-short',
      category: 'content',
      severity: 'medium',
      title: 'Email body is very short',
      explanation: 'Extremely short emails can look like phishing or low-value blasts.',
      suggestedFix: 'Add useful context, value, and a clear reason you are writing.',
      scoreImpact: 6,
    });
  }
  if (textLen > 8000) {
    issues.push({
      id: 'too-long',
      category: 'content',
      severity: 'low',
      title: 'Email body is extremely long',
      explanation: 'Very long emails reduce engagement and may hit size limits.',
      suggestedFix: 'Split into a series or link to a landing page for deep content.',
      scoreImpact: 3,
    });
  }

  const sizeBytes = Buffer.byteLength(html || plain, 'utf8');
  if (sizeBytes > 102 * 1024) {
    issues.push({
      id: 'email-size',
      category: 'size',
      severity: 'high',
      title: 'Email exceeds ~102KB',
      explanation: 'Gmail clips messages larger than about 102KB.',
      suggestedFix: 'Reduce HTML bloat, compress images via CDN, and simplify layout.',
      scoreImpact: 12,
    });
  }

  // Compliance
  if (!hasUnsubscribe(html, plain)) {
    issues.push({
      id: 'missing-unsubscribe',
      category: 'compliance',
      severity: 'critical',
      title: 'Missing unsubscribe link',
      explanation: 'CAN-SPAM and GDPR require a clear unsubscribe mechanism. Missing it harms compliance and deliverability.',
      suggestedFix: 'Add an unsubscribe link and List-Unsubscribe headers. Example: "Unsubscribe from these emails".',
      scoreImpact: 20,
    });
  }

  if (!input.physicalAddress) {
    issues.push({
      id: 'missing-address',
      category: 'compliance',
      severity: 'critical',
      title: 'Missing physical mailing address',
      explanation: 'CAN-SPAM requires a valid physical postal address in commercial emails.',
      suggestedFix: 'Add your company mailing address to the email footer.',
      scoreImpact: 20,
    });
  }

  // Personalization
  if (!hasPersonalization(`${html} ${plain} ${subject}`)) {
    issues.push({
      id: 'no-personalization',
      category: 'personalization',
      severity: 'low',
      title: 'No personalization tokens found',
      explanation: 'Personalized emails typically see higher engagement, which supports sender reputation.',
      suggestedFix: 'Add tokens like {{firstName}} in the greeting or subject.',
      scoreImpact: 3,
    });
  }

  // Auth
  const auth = input.authStatus ?? { spf: false, dkim: false, dmarc: false };
  if (!auth.spf) {
    issues.push({
      id: 'spf-missing',
      category: 'authentication',
      severity: 'critical',
      title: 'SPF not verified',
      explanation: 'SPF tells mailbox providers which servers may send for your domain.',
      suggestedFix: 'Complete the Domain Authentication Wizard and publish a valid SPF TXT record.',
      scoreImpact: 20,
    });
  }
  if (!auth.dkim) {
    issues.push({
      id: 'dkim-missing',
      category: 'authentication',
      severity: 'critical',
      title: 'DKIM not verified',
      explanation: 'DKIM cryptographically signs messages so providers can verify authenticity.',
      suggestedFix: 'Add the DKIM CNAME/TXT records shown in Domain settings and re-verify.',
      scoreImpact: 20,
    });
  }
  if (!auth.dmarc) {
    issues.push({
      id: 'dmarc-missing',
      category: 'authentication',
      severity: 'high',
      title: 'DMARC not verified',
      explanation: 'DMARC aligns SPF/DKIM and tells providers how to handle failures.',
      suggestedFix: 'Publish a DMARC record starting with p=none, then move to quarantine/reject.',
      scoreImpact: 12,
    });
  }

  // Accessibility / mobile
  if (html && !/viewport|max-width|@media/i.test(html)) {
    issues.push({
      id: 'mobile-responsive',
      category: 'mobile',
      severity: 'medium',
      title: 'Mobile responsiveness signals missing',
      explanation: 'Many opens happen on mobile; non-responsive layouts hurt engagement.',
      suggestedFix: 'Use fluid tables, max-width ~600px, and media queries from the builder.',
      scoreImpact: 6,
    });
  }

  if (html && !/<img[^>]*alt=/i.test(html) && images.length === 0) {
    // no-op — already handled
  }

  // Score calculation
  let deductions = 0;
  for (const issue of issues) {
    deductions += issue.scoreImpact;
  }
  const score = Math.max(0, Math.min(100, 100 - deductions));

  const categoryMap: Record<string, { score: number; max: number }> = {};
  const cats = [
    'authentication',
    'content',
    'html',
    'images',
    'links',
    'compliance',
    'accessibility',
    'mobile',
    'personalization',
    'subject',
  ];
  for (const cat of cats) {
    const catIssues = issues.filter((i) => i.category === cat);
    const impact = catIssues.reduce((s, i) => s + i.scoreImpact, 0);
    categoryMap[cat] = { score: Math.max(0, 100 - impact * 2), max: 100 };
  }

  const breakdown: Record<string, number> = {
    Authentication: categoryMap.authentication.score,
    Content: categoryMap.content.score,
    HTML: categoryMap.html.score,
    Images: categoryMap.images.score,
    Links: categoryMap.links.score,
    Domain: auth.spf && auth.dkim && auth.dmarc ? 95 : auth.spf || auth.dkim ? 55 : 20,
    Accessibility: categoryMap.accessibility.score || (missingAlt.length ? 60 : 90),
    Mobile: categoryMap.mobile.score,
    Personalization: categoryMap.personalization.score,
  };

  const inboxOverall = Math.round(
    Object.values(breakdown).reduce((a, b) => a + b, 0) / Object.values(breakdown).length,
  );

  const recommendations = issues
    .sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity])
    .slice(0, 8)
    .map((i) => i.suggestedFix);

  return {
    score,
    rating: ratingFromScore(score),
    issues,
    categories: Object.entries(categoryMap).map(([category, v]) => ({
      category,
      score: v.score,
      maxScore: v.max,
    })),
    inboxReadiness: {
      overall: inboxOverall,
      breakdown,
      recommendations,
    },
    subjectAnalysis,
    analyzedAt: new Date().toISOString(),
  };
}

function stripToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
