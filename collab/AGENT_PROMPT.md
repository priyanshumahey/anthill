# 🐜 Anthill Agent Bridge — Copy-paste prompt

Paste the section between the `===` markers into Claude Code, Copilot,
ChatGPT, or any other agent. Replace the two placeholders:

- `{{BRIDGE_URL}}` → e.g. `http://127.0.0.1:8889` (local dev) or your
  deployed bridge URL.
- `{{DOCUMENT_ID}}` → the UUID of the document you want the agent to
  edit. You can find it in the editor URL: `/dashboard/documents/<id>`.

> Optional: if the bridge runs with `ANTHILL_AGENT_BRIDGE_SECRET` set,
> also give the agent the value and tell it to send it as
> `X-Agent-Token`. In open-mode (default for local dev) no token is
> required.

---

```
============================================================
You are connected to Anthill, a collaborative document editor. You can
read and modify a live document over HTTP. Every change you make appears
in real time in every connected user's browser, with an attribution tag
identifying you as the author.

Bridge URL: {{BRIDGE_URL}}
Document ID: {{DOCUMENT_ID}}
Protocol: anthill-agent-bridge/1

== Auth headers (send on EVERY request) ==
- X-Agent-Id: <slug for you, e.g. claude-code>     # required
- X-Agent-Name: <human-friendly name>              # optional, used for presence
- X-Agent-Run-Id: <opaque trace id>                # optional, surfaces in provenance
- X-Agent-Token: <shared secret>                   # required only if the bridge enforces it
- Idempotency-Key: <uuid>                          # required on every POST /edit; same key + same body returns the cached response, same key + different body returns 409

== The four endpoints you'll use ==

1. GET {{BRIDGE_URL}}/.well-known/agent.json
   Discovery. Lists supported ops and block types.

2. GET {{BRIDGE_URL}}/documents/{{DOCUMENT_ID}}/snapshot
   Returns: { documentId, title, baseRevision, blockCount,
              blocks: [{ ref, type, text, attrs, proof, inlines? }],
              hasLiveClients }
   Each block has a stable ref ("b1", "b2", ...) you pass back to edit it.
   `text` is a flattened preview that includes positional markers for any
   non-text inline children (e.g. "...as shown in [cite:arXiv:2510.00908v1]").
   `inlines` (when present) is the structured list of those children — for
   citations: { type: "citation", label: "[cite:arXiv:...]",
               attrs: { arxivId, chunkIndex, title, score, ... } }.
   `baseRevision` is your optimistic-locking token — pass it on /edit to
   refuse stale writes (409 STALE_REVISION).

3. GET {{BRIDGE_URL}}/documents/{{DOCUMENT_ID}}/state
   Same as snapshot but with the full Plate value (children, marks,
   nested blocks). Use this when you need the entire content, not just
   block previews.

4. POST {{BRIDGE_URL}}/documents/{{DOCUMENT_ID}}/edit
   Body: { baseRevision?: string, ops: EditOp[] }
   Returns: { applied, baseRevision, blockCount, newRefs[] }
   All ops in one call run in a single Yjs transaction (all-or-nothing).

== EditOp types ==

  appendBlocks     { type, blocks: PlateBlock[] }
  insertBlocksAfter   { type, afterRef: "b3", blocks: [...] }
  insertBlocksBefore  { type, beforeRef: "b3", blocks: [...] }
  replaceBlock     { type, ref: "b3", blocks: [...], dropInlineElements?: false }
  deleteBlock      { type, ref: "b3", dropInlineElements?: false }
  setBlockText     { type, ref: "b3", text: "plain text", dropInlineElements?: false }
  setTitle         { type, title: "New document title" }

== Inline elements (citations) — IMPORTANT ==

Paragraphs may contain inline children that are NOT plain text — most
commonly the editor's `citation` badges, which carry provenance the user
cares about (arxivId, chunkIndex, search trace, ...). The bridge
automatically preserves these across destructive edits:

  - setBlockText keeps existing inline children and appends them after
    the new text. The agent never has to think about it.
  - replaceBlock lifts the original block's inline children onto the
    last block in the replacement.
  - deleteBlock REFUSES (409 INLINE_ELEMENTS_WOULD_BE_LOST) if the
    target block carries any inline children.

If the user explicitly asks you to remove a citation, set
`dropInlineElements: true` on the op. Otherwise leave it false (the
default). When the bridge preserves something, the response includes
`preservedInlines: N` so you can mention it to the user.

You may also include citation children directly in your blocks if you
want to author a brand-new citation: add a child element of the form
`{ type: "citation", arxivId: "<id>", chunkIndex: 0, title: "...",
   score: 0.0, children: [{ text: "" }] }` inside `children`.

== PlateBlock shape ==

A Plate block looks like Slate:

  { type: "p" | "h1" | "h2" | "h3" | ... | "blockquote" | "code_block" | "hr",
    children: [
      { text: "leaf with optional marks", bold?: true, italic?: true, code?: true, ... }
      // children may also nest: blockquote → p → text leaves, etc.
    ],
    // any other top-level key (id, align, ...) becomes an element attr
  }

Supported block types out of the box:
  p, h1, h2, h3, h4, h5, h6, blockquote, hr, code_block

== Error codes ==

  401 UNAUTHORIZED
  400 BAD_REQUEST
  404 NOT_FOUND or BLOCK_REF_NOT_FOUND
  409 STALE_REVISION                            (refetch /snapshot, retry)
  409 INLINE_ELEMENTS_WOULD_BE_LOST             (block has citations; pass
                                                 dropInlineElements: true
                                                 only if user asked)
  409 IDEMPOTENCY_KEY_REUSED_DIFFERENT_BODY     (use a fresh UUID)

== Worked example — append a section to the document ==

# 1. Generate a fresh UUID for the Idempotency-Key:
KEY=$(uuidgen)

# 2. Append a heading + paragraph + blockquote in one transaction:
curl -sS -X POST {{BRIDGE_URL}}/documents/{{DOCUMENT_ID}}/edit \
  -H "content-type: application/json" \
  -H "X-Agent-Id: claude-code" \
  -H "X-Agent-Name: Claude Code" \
  -H "Idempotency-Key: $KEY" \
  -d '{
    "ops": [{
      "type": "appendBlocks",
      "blocks": [
        {"type": "h2", "children": [{"text": "Notes from the assistant"}]},
        {"type": "p",  "children": [
          {"text": "Here is a "},
          {"text": "bold ", "bold": true},
          {"text": "addition to the doc."}
        ]},
        {"type": "blockquote", "children": [
          {"type": "p", "children": [{"text": "Marginalia I want the user to see."}]}
        ]}
      ]
    }]
  }'

== Recommended workflow ==

1. GET /snapshot once to see what's there and capture `baseRevision`.
2. Decide what to change. If you need full content, GET /state.
3. POST /edit with baseRevision set. If you get 409 STALE_REVISION,
   refetch /snapshot and replan.
4. Always set a fresh Idempotency-Key (UUID) per logical change. If you
   retry on a network failure, reuse the SAME key with the SAME body.
5. Reference existing blocks by their `ref` from the snapshot. Refs are
   stable within a single revision but get reshuffled by inserts/deletes
   — re-snapshot before chaining new edits.
6. Don't dump the entire doc into one giant block. Use one PlateBlock
   per paragraph / heading / blockquote so the editor can render and
   diff cleanly.

== What NOT to do ==

- Don't invent block types outside the supported list above unless the
  user has confirmed Plate has a plugin for it; the editor will silently
  drop unknown types.
- Don't write tables, code blocks with multiple lines, or images via
  this bridge yet — those need additional wiring on the editor side.
- Don't loop forever retrying on 400 BAD_REQUEST; fix the request shape.
- Don't reuse an Idempotency-Key with a different body — that's a 409.
============================================================
```

---

## Why this works (for humans reading this file, not for the agent)

The bridge applies every edit as a Yjs transaction inside the same
`Y.Doc` Hocuspocus owns, so changes broadcast to every connected
browser instantly. Each block the agent inserts is stamped with
`proofAuthor: "ai:<your-X-Agent-Id>"` and `proofRunId` (if provided),
so the editor can later highlight or filter agent-authored content.
