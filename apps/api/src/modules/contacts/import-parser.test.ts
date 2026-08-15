import { describe, expect, it } from 'vitest';
import { cleanImportEmail, parseContactImport } from './import-parser.js';

describe('cleanImportEmail', () => {
  it('keeps a normal email', () => {
    expect(cleanImportEmail('abuse@comcast.net')).toBe('abuse@comcast.net');
  });

  it('strips trailing dots', () => {
    expect(cleanImportEmail('brana7@comcast.net.')).toBe('brana7@comcast.net');
    expect(cleanImportEmail('markpossenti@comcast.net.')).toBe('markpossenti@comcast.net');
  });

  it('strips trailing .Read / Read OCR junk', () => {
    expect(cleanImportEmail('glenn6342@comcast.net.Read')).toBe('glenn6342@comcast.net');
    expect(cleanImportEmail('sjnoffice@comcast.netRead')).toBe('sjnoffice@comcast.net');
    expect(cleanImportEmail('KennyCarroll@comcast.net.Read')).toBe('kennycarroll@comcast.net');
    expect(cleanImportEmail('wistar@comcast.net.Read')).toBe('wistar@comcast.net');
  });

  it('rejects incomplete domains that were only .Read', () => {
    expect(cleanImportEmail('paula.brumbelow@phila.Read')).toBeNull();
  });

  it('lowercases', () => {
    expect(cleanImportEmail('FPT2799@COMCAST.NET.')).toBe('fpt2799@comcast.net');
  });

  it('strips phone digits glued before the local part when possible', () => {
    expect(cleanImportEmail('States717-517-4293dsensenig@comcast.net.')).toBe(
      'dsensenig@comcast.net',
    );
  });
});

describe('parseContactImport', () => {
  it('imports a messy pasted list as clean unique emails', () => {
    const text = `
abuse@comcast.net
glenn6342@comcast.net.Read
brana7@comcast.net.
glenn6342@comcast.net.
sjnoffice@comcast.netRead
Diana.Davis@comcast.net
`;
    const rows = parseContactImport(text);
    expect(rows.map((r) => r.email)).toEqual([
      'abuse@comcast.net',
      'glenn6342@comcast.net',
      'brana7@comcast.net',
      'sjnoffice@comcast.net',
      'diana.davis@comcast.net',
    ]);
  });

  it('imports each email only once when duplicates appear', () => {
    const text = `
martaguttenberg@comcast.net.
martaguttenberg@comcast.net
MARTAGUTTENBERG@COMCAST.NET.Read
abuse@comcast.net
abuse@comcast.net
`;
    const rows = parseContactImport(text);
    expect(rows.map((r) => r.email)).toEqual([
      'martaguttenberg@comcast.net',
      'abuse@comcast.net',
    ]);
  });
});
