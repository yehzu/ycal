## Markdown task provider — file format

The markdown provider stores everything yCal needs in a single `tasks.md` file under `cloudStore` (so it follows the user across Macs through iCloud Drive when enabled). Reference the parser in `src/main/taskProviders/markdownDoc.ts` if you need the gritty details — here's the user-facing shape:

```markdown
# Project Name {#5897c5}        ← top-level project; trailing {#hex} is optional
## Section Name                 ← nested project (any depth)

- [ ] Task title  @2026-05-15 !p2 #30m #high #office  ^abc12345
  Indented plain text becomes the description.
  Multiple lines OK; blank lines are paragraph breaks.
  - [ ] Subtask  ^def67890
  > [2026-05-01] First comment.
  > [2026-05-02] Second.

- [x] Done task  ^xyz98765
```

**Token grammar after the title:**
- `@YYYY-MM-DD` — due date (one). Also accepts `@today`, `@tomorrow`.
- `@daily` / `@weekdays` / `@every Mon Wed Fri` — weekday recurrence. Cadences that don't reduce to a weekday set (e.g. "every 3 days") set `isRecurring=true` but leave `recur.dow=null`, mirroring the Todoist provider so the Routines fold behaves identically.
- `!p1` … `!p4` — priority. **!p1 = highest = wire-priority 4** (matches Todoist's mental model where the user calls it "P1"). Default = 1.
- `#30m`, `#1h`, `#1h30m` — duration label.
- `#low`, `#mid`, `#high` — energy label.
- `#anything-else` — location label (first one wins).
- `^xxxxxxxx` — Obsidian-style block id. **Auto-assigned on first save when missing**, and the file is rewritten to make the id stick. Block ids survive title renames; without them, schedule overlay entries would orphan whenever the user edited a title.

**Why ids matter:** local schedule + done overlay (`tasks-schedule.json`) keys by task id. So the markdown file is *the* source of truth for what a task is, but the schedule of when it's planned lives separately. This is the same split the Todoist provider uses — `closeTask`/`reopenTask`/`addComment` write through to the markdown file, but `scheduleTask` does not (drag-to-schedule never round-trips to the markdown).

**Targeted-edit invariant:** the provider does line-level patches for close/reopen/addComment rather than re-emitting the whole document. That's deliberate — the user can keep arbitrary prose between blocks (HTML comments for help text, free-form notes, code fences) and yCal won't munge it. Re-serialization only happens on `needsRewrite` (new ids).

**Provider switching:** Settings → Tasks now offers a Todoist ↔ Markdown segmented control. Switching does NOT migrate tasks between providers — the markdown file and Todoist account each remain their own canonical source. The local schedule overlay is shared, so a chip dropped on Tuesday stays on Tuesday across a switch (though the id won't resolve to the new provider's tasks until the user moves it).
