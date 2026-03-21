# Contributing to the Manual

## Local preview

```bash
# Install dependencies (one-time)
python3 -m pip install mkdocs-material mkdocs-static-i18n mkdocs-with-pdf

# Start the dev server
mkdocs serve
```

Open <http://localhost:8000> to see the English manual.
Switch to Korean via the language selector in the header.

## Build

```bash
mkdocs build --strict
```

The static site is generated in `site/`.

## PDF generation

```bash
./scripts/build-docs-pdf.sh en
./scripts/build-docs-pdf.sh ko
```

PDFs are written to `site/pdf/aice-web-manual.{en,ko}.pdf`.

## Authoring rules

Follow these rules to keep the manual consistent across languages and
renderers.

### Markdown formatting

- Use **ATX headings** (`#`, `##`, `###`). Do not skip heading levels.
- Leave a **blank line** before and after headings, lists, code blocks,
  and tables.
- Indent nested list items with **4 spaces**.
- Limit list nesting to **3 levels**. If deeper nesting is needed,
  restructure into sub-sections.
- Wrap prose lines at **80 characters** for readability in diffs.
  (Tables and URLs may exceed this limit.)

### Language parity

- Every page in `docs/en/` must have a corresponding page in `docs/ko/`
  (and vice versa).
- Section structure and heading hierarchy must match between languages.
- Keep the same filename across language directories.

### Images and assets

- Place images in `docs/assets/`.
- Use relative paths from the Markdown file
  (e.g., `![diagram](../assets/overview.png)`).
- Prefer SVG for diagrams; use PNG for screenshots.

## Docs PR checklist

Before submitting a docs PR, verify:

- [ ] `mkdocs build --strict` passes with no warnings
- [ ] Local preview (`mkdocs serve`) renders correctly
- [ ] EN/KR pages are in sync (same structure, same filenames)
- [ ] New pages are listed in `mkdocs.yml` nav for both languages
- [ ] No broken links or missing images
