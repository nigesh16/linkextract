// One URL per line; blank lines dropped. Every URL is kept, including repeats.
export function parseInput(text) {
  const urls = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return { urls };
}

// Table display only (1.2K, 3.4M). Copied data always uses the exact number.
export function compact(n) {
  if (n === null || n === undefined) return '';
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
}

// Fields with tabs, line breaks or quotes are wrapped in quotes (quotes doubled), which Sheets/Excel read as one cell.
const cell = v => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[\t\r\n"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

export function toTsv(rows) {
  // Data rows only: no heading row is copied.
  const lines = rows.map(r => [r.date, r.image, r.username, r.reach, r.content, r.likes, r.comments]);
  return lines.map(row => row.map(cell).join('\t')).join('\n');
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = document.createElement('textarea');
    t.value = text;
    document.body.appendChild(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
}
