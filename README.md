# OSA site (GitHub Pages)

Served at https://kaide-labs.github.io/osa/.

- `index.html` -- the OSA project page. Static and self-contained: it loads nothing from elsewhere and sends nothing. Its "What OSA read" section lists the
  documentation sources and papers from two real OSA research runs, generated from those runs' `research/report.md`.
- `memory/index.html` -- the memory dashboard, written by `osa memory dashboard`. It holds ONLY facts loaded from those two research runs (documentation and
  papers used, plus a run note each), kept in a separate memory database; it is not a copy of anyone's personal `~/.osa/memory.db`.

Redeploy the dashboard: `OSA_MEMORY_DB=<that database> osa memory dashboard --out memory/index.html`, review the page, commit and push. Review before
publishing: memory can contain a project's decisions and goals, and the secret filter is pattern-based, not a guarantee.
