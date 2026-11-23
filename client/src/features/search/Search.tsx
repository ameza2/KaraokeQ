import { memo, useEffect, useRef, useState, type FormEvent } from "react";
import { MODE_LABELS, PAGE_SIZES, type ApiError, type OutputMode, type SearchPage, type SuggestResponse, type VideoResult } from "@karaoke/shared";
import { load, save } from "../../lib/storage.ts";

const JUMP = 3; // « and » skip this many pages (the server fetches that far ahead, no further)

function initialPageSize(): number {
  const n = Number(load("karaoke:pageSize"));
  return (PAGE_SIZES as readonly number[]).includes(n) ? n : 25;
}

function Search({
  code,
  mode,
  onAdd,
  queuedIds,
  mineCount,
}: {
  code: string;
  mode: OutputMode;
  onAdd: (v: VideoResult) => Promise<boolean>;
  queuedIds: Set<string>;
  mineCount: number;
}) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState(""); // last submitted search
  const [data, setData] = useState<SearchPage | null>(null);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const [page, setPage] = useState(0);
  const [epoch, setEpoch] = useState(0); // bumped when the output mode changes, to force a fresh fetch
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null); // something worth saying about the page, not an error
  const pages = useRef(new Map<number, SearchPage>()); // pages already loaded for this search, by number
  const searchSig = useRef(""); // which search, page size and mode `pages` belongs to
  const version = useRef<string | null>(null); // the server's version of this search
  const [adding, setAdding] = useState<string | null>(null);
  const listTop = useRef<HTMLDivElement>(null);

  // ----- autocomplete: only while typing; closed by submit, Escape or blur -----
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const suggestOpenRef = useRef(false);
  suggestOpenRef.current = suggestOpen;
  // keyboard highlight: -1 = the text you typed; 0..n-1 = a suggestion (previewed in the box)
  const [active, setActive] = useState(-1);
  useEffect(() => setActive(-1), [suggestions]);

  useEffect(() => {
    if (!suggestOpen || q.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/suggest?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then((r): Promise<SuggestResponse> => r.json())
        .then((d) => {
          if (suggestOpenRef.current) setSuggestions((d.suggestions ?? []).slice(0, 6));
        })
        .catch(() => {});
    }, 300); // phones type fast and many ask for the same starts: wait a little longer
    return () => {
      clearTimeout(t);
      ctrl.abort(); // a late response can't reopen the list after submit
    };
  }, [q, suggestOpen]);

  function closeSuggestions() {
    setSuggestOpen(false);
    setSuggestions([]);
    setActive(-1);
  }

  const listOpen = suggestOpen && suggestions.length > 0;
  const shown = listOpen && active >= 0 ? suggestions[active] : q; // what the box displays

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!listOpen) {
        if (e.key === "ArrowDown" && q.trim().length >= 2) setSuggestOpen(true); // reopen
        return;
      }
      e.preventDefault(); // keep the caret where it is
      const n = suggestions.length;
      // cycle: typed text → first … last → typed text (and the reverse for ↑)
      setActive((i) => (e.key === "ArrowDown" ? (i + 2) % (n + 1) : (i + n + 1) % (n + 1)) - 1);
    } else if (e.key === "Escape" && listOpen) {
      e.preventDefault(); // the browser's own Esc would wipe the search box
      if (active >= 0) setActive(-1); // first Esc: back to what you typed
      else closeSuggestions(); // second Esc: close the list (a third clears the box, as usual)
    }
  }

  // ----- fetching: one page at a time; pages already loaded are kept for Prev -----
  useEffect(() => {
    if (!query) return;
    const sig = `${query}|${pageSize}|${epoch}`;
    if (searchSig.current !== sig) {
      searchSig.current = sig; // a new search, page size or mode: nothing loaded so far applies
      pages.current.clear();
      version.current = null;
    }
    const loaded = pages.current.get(page);
    if (loaded) {
      setData(loaded);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setErr(null);
    fetch(`/api/search?q=${encodeURIComponent(query)}&page=${page}&pageSize=${pageSize}&room=${code}`, { signal: ctrl.signal })
      .then(async (res) => {
        const body: SearchPage | ApiError = await res.json();
        if ("error" in body) throw new Error(body.error);
        if (version.current && version.current !== body.version) {
          // The server rebuilt this search (it was idle too long): the pages kept here belong to another list.
          pages.current.clear();
          version.current = body.version;
          if (page > 0) {
            setNote("The results were refreshed, so you are back on page 1.");
            setPage(0);
            return;
          }
        }
        version.current = body.version;
        pages.current.set(body.page, body);
        const clamped = body.page < page; // we asked past the end (or past what could be fetched)
        setNote(body.busy ? "Search is busy. This is the furthest page ready; try Next again in a moment." : clamped ? (body.hasMore ? "This is the furthest page ready. Use Next to keep going." : "That was the last page.") : null);
        setData(body);
        if (body.page !== page) setPage(body.page); // asked for a page past the end: this is the last one
        if (!body.results.length) setErr("No playable results. Try the artist and song name.");
      })
      .catch((e) => {
        if (e.name !== "AbortError") setErr(e.message || "Search failed.");
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [query, page, pageSize, epoch]);

  function submit(text: string) {
    const t = text.trim();
    closeSuggestions();
    (document.activeElement as HTMLElement | null)?.blur(); // hide the phone keyboard
    if (!t) return;
    setQ(t);
    setPage(0);
    setData(null);
    setNote(null);
    setQuery(t === query ? `${t} ` : t); // re-run even if it's the same text
  }

  // Mode switch changes what's playable: start over.
  useEffect(() => {
    setData(null);
    setPage(0);
    setNote(null);
    setEpoch((e) => e + 1); // the fetch effect above doesn't otherwise re-run when nothing else changed
  }, [mode]);

  const pageItems = data?.results ?? [];
  const shownPage = data?.page ?? page;
  const first = shownPage * pageSize + 1;

  function goTo(p: number) {
    setNote(null);
    setPage(p);
    listTop.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const modeInfo = MODE_LABELS[mode];

  return (
    <section className="search">
      <form
        className="search-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          submit(shown); // Enter on a highlighted suggestion searches it
        }}
      >
        <input
          className="input"
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          placeholder="Song or artist…"
          value={shown}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(-1);
            setSuggestOpen(true);
          }}
          onKeyDown={onKey}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={listOpen}
          aria-controls="search-suggestions"
          aria-activedescendant={listOpen && active >= 0 ? `suggestion-${active}` : undefined}
          onBlur={() => setTimeout(closeSuggestions, 150)} // let a suggestion tap land first
        />
        <button className="btn primary" disabled={loading && !data}>
          Search
        </button>
        {listOpen && (
          <ul className="suggestions" role="listbox" id="search-suggestions">
            {suggestions.map((s, i) => (
              <li key={s} id={`suggestion-${i}`} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  tabIndex={-1}
                  className={i === active ? "active" : ""}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => submit(s)}
                >
                  {s}
                </button>
              </li>
            ))}
          </ul>
        )}
      </form>

      <div className="search-meta">
        <span className={`mode-chip mode-${mode}`} title={modeInfo.hint}>
          {mode === "screen" ? "🖥️" : "📺"} {modeInfo.name}
        </span>
        <label className="muted small page-size">
          Per page
          <select
            value={pageSize}
            onChange={(e) => {
              const n = Number(e.target.value);
              setPage(Math.floor((shownPage * pageSize) / n)); // keep the first song on screen
              setPageSize(n);
              save("karaoke:pageSize", String(n));
            }}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted small hint">
        {modeInfo.hint}
        {data && data.hidden > 0 && ` ${data.hidden} blocked video${data.hidden > 1 ? "s" : ""} hidden.`}
        {mineCount > 0 && ` You have ${mineCount} song${mineCount > 1 ? "s" : ""} queued.`}
      </p>

      {err && <p className="muted">{err}</p>}
      {note && <p className="muted small">{note}</p>}
      <div ref={listTop} />
      {loading && pageItems.length === 0 && !err && <p className="muted center pad">Searching…</p>}

      <ul className="list">
        {pageItems.map((v) => {
          const queued = queuedIds.has(v.videoId);
          return (
            <li key={v.videoId} className="song">
              <img src={v.thumb} alt="" loading="lazy" />
              <div className="song-info">
                <div className="song-title">{v.title}</div>
                <div className="muted small">
                  {v.channel} {v.duration && `· ${v.duration}`}
                  {v.embeddable === false && <span className="tag">YouTube only</span>}
                </div>
              </div>
              <button
                className="btn small primary"
                disabled={queued || adding === v.videoId}
                onClick={async () => {
                  setAdding(v.videoId);
                  await onAdd(v);
                  setAdding(null);
                }}
              >
                {queued ? "Queued" : "Add"}
              </button>
            </li>
          );
        })}
      </ul>

      {data && pageItems.length > 0 && (
        <nav className="pager">
          <button className="btn small jump" disabled={shownPage === 0 || loading} onClick={() => goTo(Math.max(0, shownPage - JUMP))} aria-label={`Back ${JUMP} pages`} title={`Back ${JUMP} pages`}>
            «
          </button>
          <button className="btn small" disabled={shownPage === 0 || loading} onClick={() => goTo(shownPage - 1)}>
            ‹ Prev
          </button>
          <span className="muted small">{loading ? "Loading…" : `${first}–${first + pageItems.length - 1} of ${data.total}${data.complete ? "" : "+"}`}</span>
          <button className="btn small" disabled={!data.hasMore || loading} onClick={() => goTo(shownPage + 1)}>
            Next ›
          </button>
          <button className="btn small jump" disabled={!data.hasMore || loading} onClick={() => goTo(shownPage + JUMP)} aria-label={`Forward ${JUMP} pages`} title={`Forward ${JUMP} pages`}>
            »
          </button>
        </nav>
      )}
    </section>
  );
}

// Memoised: the room page re-renders about once a second with the playback position.
export default memo(Search);
