import { memo, useEffect, useRef, useState, type FormEvent } from "react";
import { MODE_LABELS, PAGE_SIZES, type ApiError, type OutputMode, type SearchPage, type SuggestResponse, type VideoResult } from "@karaoke/shared";
import { load, save } from "../../lib/storage.ts";

const MAX = 100;

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
    }, 200);
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

  // ----- fetching: grow the result set as the user pages forward -----
  const needed = Math.min(MAX, (page + 1) * pageSize);
  const have = data?.results.length ?? 0;

  useEffect(() => {
    if (!query) return;
    if (data && (have >= needed || !data.hasMore)) return; // already enough
    const ctrl = new AbortController();
    setLoading(true);
    setErr(null);
    fetch(`/api/search?q=${encodeURIComponent(query)}&limit=${needed}&room=${code}`, { signal: ctrl.signal })
      .then(async (res) => {
        const body: SearchPage | ApiError = await res.json();
        if ("error" in body) throw new Error(body.error);
        setData(body);
        if (!body.results.length) setErr("No playable results. Try the artist and song name.");
      })
      .catch((e) => {
        if (e.name !== "AbortError") setErr(e.message || "Search failed.");
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
    // `data` intentionally omitted: we only refetch when the requirement grows
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, needed, epoch]);

  function submit(text: string) {
    const t = text.trim();
    closeSuggestions();
    (document.activeElement as HTMLElement | null)?.blur(); // hide the phone keyboard
    if (!t) return;
    setQ(t);
    setPage(0);
    setData(null);
    setQuery(t === query ? `${t} ` : t); // re-run even if it's the same text
  }

  // Mode switch changes what's playable: start over.
  useEffect(() => {
    setData(null);
    setPage(0);
    setEpoch((e) => e + 1); // the fetch effect above doesn't otherwise re-run when nothing else changed
  }, [mode]);

  const results = data?.results ?? [];
  const pageItems = results.slice(page * pageSize, (page + 1) * pageSize);
  const lastLoadedPage = Math.max(0, Math.ceil(results.length / pageSize) - 1);
  const canNext = (page + 1) * pageSize < MAX && (page < lastLoadedPage || !!data?.hasMore);

  function goTo(p: number) {
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
              setPageSize(n);
              setPage(0);
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
      <div ref={listTop} />
      {loading && pageItems.length === 0 && <p className="muted center pad">Searching…</p>}

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

      {results.length > 0 && (
        <nav className="pager">
          <button className="btn small" disabled={page === 0} onClick={() => goTo(page - 1)}>
            ‹ Prev
          </button>
          <span className="muted small">
            {loading ? "Loading…" : `${page * pageSize + 1}–${page * pageSize + pageItems.length} of ${data?.hasMore ? `${results.length}+` : results.length}`}
          </span>
          <button className="btn small" disabled={!canNext || loading} onClick={() => goTo(page + 1)}>
            Next ›
          </button>
        </nav>
      )}
    </section>
  );
}

// Memoised: the room page re-renders about once a second with the playback position.
export default memo(Search);
