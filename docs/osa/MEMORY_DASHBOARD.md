# Looking at your memory, and moving it

OSA's memory lives in one local file, `~/.osa/memory.db` (see MEMORY.md). Three commands let you look through it and carry it to another machine. None of them starts a server, opens a network connection, or needs an account: your memory stays on your machine unless you copy a file yourself.

## `osa memory dashboard [--out file.html] [--project p]`

Writes **one self-contained HTML page** (default `osa-memory-dashboard.html` in the current folder) and prints a `file://` link to open it in any browser.

- A table of projects (fact count, last change). Click a project to filter to it.
- A search box (every word must match the fact, its project or its source), a project filter and a kind filter (`fact`, `decision`, `note`), newest first.
- It is a **snapshot**: it reads nothing live and sends nothing. Write a new page to refresh it. At most the 5,000 newest facts are embedded, and the page says how many older ones it left out.
- It cannot delete anything. To remove memory, run `osa memory forget --project <name>` (or `--all --yes`) and write a new page.
- With no database yet, it writes an empty page and creates no database file.

Every stored fact is treated as untrusted text (it can come from a model or a web page). The page never builds markup from data: the facts travel as JSON inside a non-executing script element with `<`, `>`, `&` and the line separators escaped, the page's own script writes them with `textContent` only, and a Content-Security-Policy forbids every network connection. Tests attack the page with hostile fact text and run its script against a stand-in for the page structure.

## `osa memory export [--out file.json] [--project p]`

Writes the facts as JSON (default `osa-memory-export.json`), oldest first: `{ format: "osa-memory-export", version: 1, exportedAt, facts: [{ id, project, kind, source, text, createdAt, updatedAt }] }`. Deleted rows are not exported.

## `osa memory import <file.json> [--project p]`

Reads an export back **through the same checks as `osa memory save`**: secrets are redacted, a fact that is mostly secret, instruction-like or hidden text is refused, a project or source label that looks like a secret is refused, and an identical fact already present is not added twice. Refused facts are counted in the result and not stored. `--project` puts every imported fact under that project name.

An import does **not** carry over ids or dates: each fact gets a fresh id and the import time. Trusting ids or dates from a file would let a file overwrite existing rows or back-date them. The file is at most 50,000 facts.

## What this is not

It is not a cloud copy. A hosted, synced dashboard would need accounts, encryption on your machine before upload, and a place to keep the data; that is a separate piece of work and is not built. Until then, `export` and `import` are how memory moves between machines.
