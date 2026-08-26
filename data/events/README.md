# Event data

One JSON file per event. Adding an event is a **data operation** — no page
template is ever edited.

## Workflow

1. Copy `_TEMPLATE.json` to `<event-slug>.json` (e.g. `worlds-2026.json`).
2. Fill in the event details and the top 8.
3. Build and apply:

   ```bash
   node scripts/import-decks.mjs
   npx wrangler d1 execute scoutpost --remote --file=build/import.sql
   ```

The event appears at `/events/<event-slug>` immediately — costs are computed
live from the latest prices, so nothing needs rebuilding when prices move.

## Rules the importer enforces

| Field | Rule |
|---|---|
| `id` | lowercase slug (`a-z`, `0-9`, `-`). Becomes the URL. |
| `date` | `YYYY-MM-DD` |
| `placement` | integer 1–8, no duplicates within an event |
| `cards[].code` | `SET-NUMBER` as printed, e.g. `OGN-001`, `OGN-007a` |
| `cards[].qty` | positive integer |

Card codes are resolved against the live Riftscribe catalogue. **An unknown code
fails the whole import** rather than quietly dropping the card — a missing card
would silently under-report the deck's build cost, which is the one number this
site exists to get right.

Re-importing an event replaces its decks wholesale, so fixing a list is just an
edit and a re-run.

Files beginning with `_` (like `_TEMPLATE.json`) are skipped by the importer, so
the template can live here safely.
