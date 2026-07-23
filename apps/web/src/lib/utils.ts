import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatPercent(n: number) {
  return `${n.toFixed(1)}%`;
}

export function formatNumber(n: number) {
  return new Intl.NumberFormat().format(n);
}

export function scoreColor(score: number) {
  if (score >= 85) return 'hsl(120 90% 48%)';
  if (score >= 70) return 'hsl(120 70% 42%)';
  if (score >= 50) return 'hsl(45 95% 52%)';
  return 'hsl(0 85% 55%)';
}

export function scoreLabel(score: number) {
  if (score >= 85) return 'Excellent';
  if (score >= 70) return 'Good';
  if (score >= 50) return 'Needs Improvement';
  return 'High Risk';
}
