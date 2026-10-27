import { useMemo, useState } from 'react';
import { parseInput, toTsv, copyText, compact } from './utils.js';

const CHUNK = 5;
const COLUMNS = ['Published Date', 'Article Banner Image', 'Username', 'Reach', 'Full Content', 'Likes', 'Comments', 'Status'];
const BADGE = {
  success: 'bg-emerald-100 text-emerald-800',
  partial: 'bg-amber-100 text-amber-700',
  failed: 'bg-red-100 text-red-600'
};
const LABEL = { success: 'Success', partial: 'Partial', failed: 'Failed' };

const TIME_ZONES = [
  { group: 'India', zones: [['Asia/Kolkata', 'India (IST)']] },
  { group: 'USA', zones: [['America/New_York', 'USA – Eastern'], ['America/Chicago', 'USA – Central'], ['America/Denver', 'USA – Mountain'], ['America/Los_Angeles', 'USA – Pacific']] },
  { group: 'UK', zones: [['Europe/London', 'UK (London)']] },
  { group: 'Other', zones: [['UTC', 'UTC']] }
];
const TZ_KEY = 'linkextract.timeZone';
const validTz = v => TIME_ZONES.some(g => g.zones.some(z => z[0] === v));
const savedTz = () => { try { const v = localStorage.getItem(TZ_KEY); return validTz(v) ? v : 'UTC'; } catch { return 'UTC'; } };

const show = v => (v === null || v === undefined || v === '' ? <span className="text-gray-400">—</span> : v);

function Logo() {
  return (
    <div className="flex items-center gap-3">
      <svg viewBox="0 0 32 32" className="h-9 w-9 shrink-0" aria-hidden="true">
        <rect width="32" height="32" rx="8" fill="#0b6b4f" />
        <path d="M11.5 8v13a3 3 0 0 0 3 3h7" fill="none" stroke="#fff" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="text-2xl font-bold tracking-tight sm:text-3xl">
        Link<span className="text-brand">Extract</span>
      </span>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".3" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function Thumb({ src }) {
  const [bad, setBad] = useState(false);
  if (!src || bad) {
    return <div className="grid h-11 w-20 shrink-0 place-items-center rounded-md bg-gray-100 text-[11px] text-gray-400">No image</div>;
  }
  return (
    <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBad(true)}
      className="h-11 w-20 shrink-0 rounded-md border border-line object-cover" />
  );
}

function Status({ r }) {
  return (
    <div>
      <span className={`inline-block rounded-md px-3 py-1 text-sm font-medium ${BADGE[r.status]}`}>{LABEL[r.status]}</span>
      {r.note && <p className="mt-1 max-w-[12rem] text-xs text-gray-500">{r.note}</p>}
    </div>
  );
}

// Failed rows have no username, so show the URL to make clear which post failed.
function Who({ r }) {
  if (r.username) return <span className="font-semibold">{r.username}</span>;
  return <a href={r.url} target="_blank" rel="noreferrer" className="break-all text-xs text-gray-500 underline">{r.url}</a>;
}

function Stat({ label, value }) {
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className="font-medium">{show(value)}</p>
    </div>
  );
}

export default function App() {
  const [text, setText] = useState('');
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [copied, setCopied] = useState('');
  const [timeZone, setTimeZone] = useState(savedTz);
  const { urls } = useMemo(() => parseInput(text), [text]);
  const copyable = rows.filter(r => r.status !== 'failed');

  async function extract() {
    if (!urls.length || busy) return;
    setBusy(true); setRows([]); setDone(0); setTotal(urls.length); setCopied('');
    for (let i = 0; i < urls.length; i += CHUNK) {
      const chunk = urls.slice(i, i + CHUNK);
      let results;
      try {
        const res = await fetch(`${import.meta.env.VITE_API_URL}/api/extract`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls: chunk, timeZone })
        });
        if (!res.ok) throw new Error('server error ' + res.status);
        results = (await res.json()).results;
      } catch (e) {
        results = chunk.map(url => ({ url, status: 'failed', note: 'Request failed - ' + e.message }));
      }
      setRows(prev => [...prev, ...results]);
      setDone(Math.min(i + CHUNK, urls.length));
    }
    setBusy(false);
  }

  function changeTz(v) {
    setTimeZone(v);
    try { localStorage.setItem(TZ_KEY, v); } catch {}
  }

  function clearAll() {
    if (busy) return;
    setText(''); setRows([]); setDone(0); setTotal(0); setCopied('');
  }

  async function copyAll() {
    await copyText(toTsv(copyable));
    setCopied(`Copied ${copyable.length} ${copyable.length === 1 ? 'row' : 'rows'}`);
    setTimeout(() => setCopied(''), 3000);
  }

  return (
    <div className="min-h-screen bg-canvas font-sans text-ink antialiased">
      <div className="mx-auto max-w-[1400px] px-4 pb-10 pt-5 sm:px-6">
        <header className="flex items-center gap-4 pb-5">
          <Logo />
          <span className="hidden h-7 w-px bg-line sm:block" />
          <span className="hidden text-lg text-gray-600 sm:block">LinkedIn Post Extractor</span>
        </header>

        <section className="rounded-2xl border border-line bg-white p-4 shadow-sm sm:p-6">
          <h2 className="mb-3 text-xl font-semibold">Post URLs</h2>
          <textarea
            value={text} onChange={e => setText(e.target.value)} rows={5} spellCheck={false}
            placeholder="Paste LinkedIn post URLs here, one per line..."
            className="w-full resize-y rounded-lg border border-line bg-white p-3 text-[15px] placeholder:text-gray-400 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
          />
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[15px] text-gray-700">
              {urls.length} {urls.length === 1 ? 'URL' : 'URLs'} added
            </p>
            <label className="flex items-center gap-2 text-[15px] text-gray-700">
              <span className="whitespace-nowrap">Published Date Time Zone</span>
              <select value={timeZone} onChange={e => changeTz(e.target.value)} disabled={busy}
                className="rounded-lg border border-line bg-white px-3 py-2 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 disabled:opacity-50">
                {TIME_ZONES.map(g => (
                  <optgroup key={g.group} label={g.group}>
                    {g.zones.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
            <div className="flex items-center gap-3">
            <button onClick={clearAll} disabled={busy || (!text && !rows.length)}
              className="inline-flex items-center justify-center rounded-lg border border-line bg-white px-6 py-3 font-semibold text-gray-700 transition hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50">
              Clear
            </button>
            <button onClick={extract} disabled={!urls.length || busy}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand px-8 py-3 font-semibold text-white transition hover:bg-brand-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50">
              {busy ? <Spinner /> : (
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d="M7 5l12 7-12 7V5z" /></svg>
              )}
              {busy ? 'Extracting…' : 'Extract Posts'}
            </button>
            </div>
          </div>
        </section>

        <section className="mt-5 rounded-2xl border border-line bg-white p-4 shadow-sm sm:p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-2xl font-semibold">Extracted Posts</h2>
            <div className="flex items-center gap-3">
              {copied && <span role="status" className="text-sm font-medium text-brand">{copied}</span>}
              <button onClick={copyAll} disabled={!copyable.length}
                className="inline-flex items-center gap-2 rounded-lg border border-brand bg-white px-4 py-2.5 font-medium text-brand transition hover:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-40">
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4h6v3H9z" /><path d="M9 12h6M9 16h6" />
                </svg>
                Copy All (Excel Format)
              </button>
            </div>
          </div>

          {busy && (
            <div className="mb-4" aria-live="polite">
              <p className="mb-1 text-sm text-gray-600">Extracting {done} of {total}…</p>
              <div className="h-1.5 overflow-hidden rounded-full bg-gray-100">
                <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${(done / total) * 100}%` }} />
              </div>
            </div>
          )}

          {!rows.length ? (
            <p className="rounded-lg border border-dashed border-line py-10 text-center text-gray-500">
              {busy ? 'Fetching the first posts…' : 'Paste post URLs above and select Extract Posts. Results appear here.'}
            </p>
          ) : (
            <>
              {/* Tablet and desktop: table (scrolls sideways when narrow) */}
              <div className="hidden overflow-x-auto rounded-xl border border-line md:block">
                <table className="w-full min-w-[940px] text-left text-[15px]">
                  <thead className="bg-slate-50 text-sm font-semibold">
                    <tr>{COLUMNS.map(c => <th key={c} className="whitespace-nowrap px-4 py-3">{c}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {rows.map((r, i) => (
                      <tr key={i}>
                        <td className="whitespace-nowrap px-4 py-3">{show(r.date)}</td>
                        <td className="px-4 py-3"><Thumb src={r.image} /></td>
                        <td className="max-w-[12rem] px-4 py-3"><Who r={r} /></td>
                        <td className="px-4 py-3">{show(r.reach)}</td>
                        <td className="min-w-[16rem] max-w-[22rem] px-4 py-3">
                          <p className="line-clamp-3" title={r.content}>{show(r.content)}</p>
                        </td>
                        <td className="px-4 py-3">{show(compact(r.likes))}</td>
                        <td className="px-4 py-3">{show(compact(r.comments))}</td>
                        <td className="px-4 py-3"><Status r={r} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile: compact cards */}
              <div className="space-y-3 md:hidden">
                {rows.map((r, i) => (
                  <article key={i} className="rounded-xl border border-line p-4">
                    <div className="flex items-center gap-3">
                      <Thumb src={r.image} />
                      <div className="min-w-0">
                        <p className="break-words"><Who r={r} /></p>
                        <p className="text-sm text-gray-500">{show(r.date)}</p>
                      </div>
                    </div>
                    <p className="mt-3 line-clamp-4 break-words text-[15px]">{show(r.content)}</p>
                    <div className="mt-3 grid grid-cols-3 gap-3">
                      <Stat label="Reach" value={r.reach} />
                      <Stat label="Likes" value={compact(r.likes)} />
                      <Stat label="Comments" value={compact(r.comments)} />
                    </div>
                    <div className="mt-3"><Status r={r} /></div>
                  </article>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
