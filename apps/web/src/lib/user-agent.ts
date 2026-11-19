export function describeUserAgent(ua?: string | null) {
  const raw = (ua || '').trim();
  if (!raw) return { browser: 'Unknown browser', os: 'Unknown OS', summary: 'Unknown device' };
  const browser = /Edg\//i.test(raw)
    ? 'Edge'
    : /OPR\/|Opera/i.test(raw)
      ? 'Opera'
      : /Chrome\//i.test(raw)
        ? 'Chrome'
        : /Firefox\//i.test(raw)
          ? 'Firefox'
          : /Safari\//i.test(raw)
            ? 'Safari'
            : 'Browser';
  const os = /Windows NT/i.test(raw)
    ? 'Windows'
    : /Mac OS X|Macintosh/i.test(raw)
      ? 'macOS'
      : /Android/i.test(raw)
        ? 'Android'
        : /iPhone|iPad|iOS/i.test(raw)
          ? 'iOS'
          : /Linux/i.test(raw)
            ? 'Linux'
            : 'Unknown OS';
  return { browser, os, summary: `${browser} on ${os}` };
}
