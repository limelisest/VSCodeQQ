export interface MessageCard { format: 'json' | 'xml'; data: string; }

const textFields = ['title', 'subtitle', 'subject', 'sender', 'from', 'desc', 'description', 'summary', 'brief', 'content', 'text', 'appname', 'source', 'tag', 'prompt'];
const urlFields = ['url', 'jumpUrl', 'jump_url', 'qqdocurl', 'actionUrl'];
const clean = (text: string) => text.replace(/\r\n?/g, '\n').replace(/\0/g, '').trim();

function webUrl(value: string): string | undefined {
  try { if (['http:', 'https:'].includes(new URL(value).protocol)) return value; } catch {}
}

// Decode text only. Never resolve XML entities, execute markup or open a card action.
function xmlText(value: string): string {
  return value.split(/<!\[CDATA\[([\s\S]*?)\]\]>/g).map((part, index) => index % 2 ? part : part
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code: string) => {
      const names: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
      if (code[0] !== '#') return names[code.toLowerCase()] ?? entity;
      const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : entity;
    })).join('');
}

export function messageCard(format: MessageCard['format'], data: unknown): { type: 'text'; text: string; card?: MessageCard } {
  let raw: string;
  try { raw = typeof data === 'string' ? data : format === 'json' && data && typeof data === 'object' ? JSON.stringify(data) : ''; }
  catch { raw = ''; }
  const lines = new Set<string>(), urls = new Set<string>();
  const add = (value: unknown) => { if (typeof value === 'string' && clean(value)) lines.add(clean(value)); };
  const addUrl = (value: unknown) => { if (typeof value === 'string' && webUrl(clean(value))) urls.add(clean(value)); };
  if (format === 'json') {
    try {
      const card = JSON.parse(raw);
      const detail = (value: unknown, depth = 0): void => {
        if (!value || typeof value !== 'object' || depth > 4) return;
        if (Array.isArray(value)) { for (const child of value) detail(child, depth + 1); return; }
        const record = value as Record<string, unknown>;
        for (const field of textFields) add(record[field]);
        for (const field of urlFields) addUrl(record[field]);
        for (const child of Object.values(record)) if (child && typeof child === 'object') detail(child, depth + 1);
      };
      if (card && typeof card === 'object' && !Array.isArray(card)) {
        detail(card.meta);
        for (const field of textFields) add(card[field]);
        for (const field of urlFields) addUrl(card[field]);
      }
    } catch { /* Preserve malformed cards for future parsers without exposing raw data. */ }
  } else if (/<msg\b[^>]*>[\s\S]*<\/msg\s*>/i.test(raw)) {
    // QQ XML cards use these text elements and attributes, including CDATA.
    for (const match of raw.matchAll(/<(title|summary|brief|content|text)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) add(xmlText(match[2]));
    for (const tag of raw.matchAll(/<(msg|item|source)\b([^>]*)>/gi)) {
      for (const match of tag[2].matchAll(/\b(brief|title|summary|name|url|jumpUrl|actionUrl)\s*=\s*(["'])([\s\S]*?)\2/gi)) {
        if (/url$/i.test(match[1])) addUrl(xmlText(match[3]));
        else if (match[1] !== 'name' || tag[1].toLowerCase() === 'source') add(xmlText(match[3]));
      }
    }
  }
  for (const url of urls) lines.add(url);
  return { type: 'text', text: [...lines].join('\n') || '[卡片]', ...(raw ? { card: { format, data: raw } } : {}) };
}
