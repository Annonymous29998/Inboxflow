# Cursor prompts — Email Extractor TUI

Use a **new folder** (e.g. `email-extractor/`) and paste **Prompt 1** into Cursor Agent. After the scaffold works, paste **Prompt 2**, then **Prompt 3** if needed.

Product name: **LeadMine Extractor** (terminal app — not related to I-Coffee or Inbox Flow unless you rename it yourself).

---

## Prompt 1 — Full build (paste this first)

```
Build a standalone **Email Extractor TUI** desktop-style terminal app from scratch in a new project folder.

## Brand & UI
- Name: **LeadMine Extractor**
- Dark-first TUI (near-black background, cyan or green accent, square corners)
- Professional monospace font
- Layout: sidebar navigation | main panel | status bar | footer with shortcuts
- Color-coded log levels: [INFO] [SUCCESS] [WARNING] [ERROR]
- No web UI for MVP — terminal only

## Stack
- **Python 3.11+** + **Textual** (preferred)
- `requirements.txt` or `pyproject.toml`
- Entry: `python -m src.main` or `leadmine` CLI

## User flow

1. **Search screen** — form fields:
   - **Subject / role** (required): e.g. engineers, CEO, marketing manager
   - **Location** (optional): e.g. Lagos, London, Texas
   - **Email domains** (comma-separated, required at least one): gmail.com, outlook.com, yahoo.com, hotmail.com, icloud.com
   - **Max results** (default 100, max 500)

2. User presses **Start** (Enter or F5) → **Progress screen** with spinner, count, current URL, scrollable log

3. **Results screen** — DataTable columns:
   - Email | Domain | Source URL | Context (short snippet)

4. **Export** — save to `./exports/` (gitignored):
   - CSV (default)
   - JSON
   - TXT (one email per line)
   - Markdown report (query summary, timestamp, table)
   - Filename pattern: `extract_{subject}_{location}_{date}.csv`

## Extraction modes (implement both; Mode B first)

### Mode B — URLs / files (no API key required) — BUILD THIS FIRST
- Tab or toggle: paste multiline URL list OR pick local file (.html, .htm, .txt, .csv)
- HTTP GET each URL (timeout 15s, user-agent configurable)
- Parse HTML/text; extract emails via regex + mailto: links
- Filter: keep only emails matching selected domains (case-insensitive, strip @)
- Dedupe normalized emails (lowercase)
- Attach source URL and ~80 char context snippet per hit

### Mode A — Public web search (requires API key)
- Build query from subject + location + domains, e.g.:
  `"engineers" "Lagos" (email OR contact) (@gmail.com OR @outlook.com)`
- Support env vars (Settings screen):
  - `SERPAPI_KEY` (SerpAPI), OR
  - `GOOGLE_CSE_KEY` + `GOOGLE_CSE_ID` (Google Custom Search)
- Fetch search result URLs → same extract/filter/dedupe pipeline as Mode B
- Rate limit: max 1 page fetch per 2 seconds; respect timeouts

**Do NOT implement:** LinkedIn auth scraping, CAPTCHA bypass, logged-in/private pages, proxy farms.

## Screens
1. Search (form + mode toggle + domain chips)
2. Progress (live extraction)
3. Results (sortable table, row count)
4. Export (format picker + path preview)
5. Settings (API keys masked, export dir, rate limit, user-agent)
6. Help overlay (?)

## Keyboard shortcuts
- `/` or Ctrl+K — command palette (Search, Results, Export, Settings, Quit)
- Enter — start extraction from Search
- E — export from Results
- Esc — back
- Q — quit (confirm if job running)
- Ctrl+C — cancel running job

## Project structure

```
email-extractor/
  README.md
  .env.example
  .gitignore          # exports/, .env, __pycache__
  requirements.txt
  src/
    main.py
    models.py
    tui/
      app.py
      screens/search.py
      screens/progress.py
      screens/results.py
      screens/export.py
      screens/settings.py
    core/
      query_builder.py
      filters.py
      export.py
      extractors/html.py
      extractors/file_import.py
      extractors/web_search.py
  exports/
  tests/
    test_query_builder.py
    test_filters.py
    test_html_extract.py
```

## Data models

```python
@dataclass
class ExtractJob:
    subject: str
    location: str | None
    domains: list[str]
    max_results: int
    mode: Literal["web", "urls", "file"]

@dataclass
class ExtractedEmail:
    email: str
    domain: str
    source_url: str | None
    context: str | None
    found_at: datetime
```

## Compliance (README + Settings footer)
- Tool is for **publicly available data** and lawful prospecting only
- User is responsible for CAN-SPAM, GDPR, and local laws
- Rate-limited requests; no spam-sending features — **export only**

## Quality
- End-to-end: Mode B works without any API key
- Clear error if Mode A selected without keys → link to Settings
- Unit tests: query builder, domain filter, email regex on sample HTML
- README: install, env vars, shortcuts, examples

## Out of scope MVP
- SMTP verification
- Built-in email sending
- Paid proxy rotation

Start by scaffolding, implement Mode B completely, then Mode A, then polish TUI and exports.
```

---

## Prompt 2 — Polish & harden (after MVP runs)

```
In the LeadMine Extractor TUI project:

1. Add **command palette** (Ctrl+K): jump to Search, Results, Export, Settings, Clear results
2. Add **duplicate detection** stats on Results screen (total found vs unique)
3. Improve **Markdown export** with metadata block (query, domains, location, UTC timestamp, count)
4. Add **cancel** during extraction (Ctrl+C) without crashing the app
5. Persist last-used domains and export path in `~/.leadmine/config.json`
6. Add sample fixture HTML in `tests/fixtures/` for extractor tests
7. Fix any linter issues; ensure `pytest` passes

Do not rename the app to I-Coffee or Inbox Flow.
```

---

## Prompt 3 — Optional: Inbox Flow CSV export (only if you use Inbox Flow contacts)

```
Add export preset **Inbox Flow contacts CSV** with columns:
email, firstName, lastName, source, tags

- Parse name from context snippet when possible (best-effort)
- tags column: `{subject},{location}` slugified
- Button on Export screen: "Inbox Flow CSV"
```

---

## Prompt 4 — Optional: DuckDuckGo fallback (no API key web search)

```
Add optional web search backend **DuckDuckGo lite** when no SERPAPI_KEY or GOOGLE_CSE_KEY is set:
- Use duckduckgo-search Python package or careful HTML lite scraping
- Max 3 result pages, 2s delay between requests
- Show warning in UI: "Unofficial search — slower, may break"
- Fall back to Mode B if search fails
```

---

## Quick start (after Cursor builds it)

```bash
cd email-extractor
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Optional: add SERPAPI_KEY for Mode A
python -m src.main
```

---

## Rename the app

To use a different name, find-replace **LeadMine Extractor** / `leadmine` in the prompt before pasting, e.g.:
- **ProspectTUI**
- **DomainLead Extractor**
- **MailFind TUI**
