# Mesa — AI/ML Project Walkthrough

> A long-form walkthrough of Mesa, a bill-splitting app with an in-progress
> receipt-parsing capability built on OpenAI Vision. Written for a verbal
> walkthrough and intended to be annotated.
>
> Repo layout reference:
> - Frontend: [mesa/src/App.tsx](src/App.tsx)
> - Vision endpoint: [mesa/api/parse-receipt-openai.ts](api/parse-receipt-openai.ts)
> - README: [mesa/README.md](README.md)

---

## 1. Project at a glance

Mesa is a bill-splitting web app: add people, add line items from a receipt,
check off who shared each item, set tax/tip and a split mode, and get a
per-person total with live USD conversion and a one-click clipboard summary.

The **AI/ML angle** is a planned receipt-OCR flow: snap a photo of a paper
receipt, and a multimodal LLM extracts the line items so the user doesn't have
to type them in. Today that flow is **scaffolded but not yet model-integrated**:
the upload pipeline (browser → multipart POST → Vercel serverless function →
`/tmp` file handling) is in place, but the actual OpenAI Vision call is the
next step. See the comment at
[api/parse-receipt-openai.ts:44](api/parse-receipt-openai.ts#L44):
*"For now we just echo back metadata. Next step we'll call OpenAI."*

I want to be upfront about this framing because it's load-bearing for the
discussion: the *interesting* parts of an LLM-powered feature aren't the model
call itself — they're everything around it (input handling, prompt design,
output shape, validation, failure modes, cost). Mesa is a useful walkthrough
because it makes those choices explicit even at a small scale.

---

## 2. Why frame this as an AI/ML project

A typical "AI app" today is a thin layer of product code wrapped around a
hosted model. The engineering work lives in:

1. **Getting the right context to the model** — image preprocessing, prompt
   construction, tool/schema definitions.
2. **Constraining the output** — JSON schemas, structured outputs, validation,
   retries.
3. **Closing the loop with the user** — confidence handling, edit affordances,
   undo, fallback to manual entry.
4. **Operability** — latency, cost, error visibility, abuse limits.

Mesa is small enough that I can talk through each of those in concrete terms
without hand-waving, and it's far enough along that the non-AI scaffolding
(types, math, UI affordances) is real, not a mock.

---

## 3. Architecture

### 3.1 High-level flow

```
┌─────────────────┐    multipart/form-data    ┌──────────────────────┐
│  React (Vite)   │ ───────  POST  ─────────▶ │  Vercel Serverless   │
│  App.tsx        │                            │  parse-receipt-      │
│                 │ ◀─── JSON  (line items) ── │  openai.ts           │
└─────────────────┘                            └──────────┬───────────┘
        │                                                 │
        │ writes parsed items into                        │ (planned)
        │ React state via setItems()                      ▼
        ▼                                       ┌──────────────────────┐
   Existing items / assignments / split logic   │  OpenAI Vision API   │
   already in App.tsx                           │  gpt-4o / 4o-mini    │
                                                └──────────────────────┘

  External:  open.er-api.com  ── hourly fetch ──▶  USD conversion
```

### 3.2 Why this shape

- **Frontend-only state, no backend DB.** A bill is ephemeral. There is no
  account, no history, no sync. That keeps the surface area small and removes
  a whole class of problems (auth, persistence, migrations) that aren't where
  the value is for a v1.
- **Serverless function for the model call**, not a direct browser → OpenAI
  call. The browser must not hold an OpenAI API key, and the function is also
  the right place to do image size/type checks, rate limiting, and retries.
- **Vercel** specifically because the frontend already deploys there and
  `api/*.ts` files automatically become serverless endpoints — zero extra
  infra for one endpoint.
- **Multipart upload, not base64 in JSON.** Receipts can be 1–4 MB; base64
  inflates that ~33% and forces a JSON parse on the whole thing. `formidable`
  streams to `/tmp`, which is more memory-friendly for the function.

---

## 4. Key components

### 4.1 The math core — cents-based money
[App.tsx:29-32](src/App.tsx#L29-L32),
[App.tsx:92-121](src/App.tsx#L92-L121),
[App.tsx:227-278](src/App.tsx#L227-L278)

All monetary computation happens in **integer cents**. User input is parsed
into a float, then immediately `Math.round(n * 100)`'d into cents; rendering
divides back out. Splits use floor-division plus an explicit remainder
distribution loop:

```ts
const q = Math.floor(lineTotalC / shareCount);
let r = lineTotalC % shareCount;
assignedIds.forEach((pid, idx) => {
  totalsC[pid] += q + (idx < r ? 1 : 0);
});
```

Why it matters: floating-point splits leave pennies stranded. A €10.00 item
split three ways in floats gives 3.333…; the sum doesn't reconcile. In cents,
1000 / 3 = 333 r 1, so two people pay 333¢ and one pays 334¢, summing exactly.
The proportional tax/tip path
([App.tsx:254-275](src/App.tsx#L254-L275)) does the same, with remainder
assigned to the largest pre-extras weight first for determinism.

This is a small thing, but it's *the* thing that makes the app trustworthy to
a user who's standing at a restaurant table. If the totals don't reconcile,
the app is useless.

### 4.2 Live FX — `useUsdRate` hook
[App.tsx:36-87](src/App.tsx#L36-L87)

A custom hook that fetches the current USD rate for the bill's base currency
from `open.er-api.com` (no API key) and refreshes hourly. State machine is
explicit: `idle | loading | ok | error`. On error, the UI keeps showing the
last known rate and surfaces "Using last known rate (update failed)"
([App.tsx:601-611](src/App.tsx#L601-L611)).

Design choice worth flagging: USD is shown as a **secondary** display
("$24.01 (€35.00)" in the clipboard summary), never as the source of truth.
If the FX call fails, totals are still correct in the bill currency.

### 4.3 The receipt-parsing endpoint
[api/parse-receipt-openai.ts](api/parse-receipt-openai.ts)

Current state, fully implemented:

- `export const config = { api: { bodyParser: false } }` — disables Vercel's
  default JSON body parser so multipart streams through.
- `formidable` configured with `uploadDir: '/tmp'`, `keepExtensions: true`,
  and `filter: p => p.mimetype?.startsWith('image/')` — server-side MIME
  filtering, not just client-side.
- Returns metadata (filename, mimetype, size, tmp path) on success.

The next step (planned, not built):

1. Read the file from `/tmp` into a buffer.
2. Call OpenAI's chat-completions or responses API with the image content
   plus a structured-output schema describing line items.
3. Validate the response with a Zod (or hand-rolled) schema.
4. Return the parsed items as JSON; the frontend appends them to React state
   via `setItems`.

I'll talk through what that prompt and schema would look like in §5.4.

### 4.4 Allocation validation
[App.tsx:286-294](src/App.tsx#L286-L294),
[App.tsx:732-744](src/App.tsx#L732-L744)

Two cross-checks the user sees:

- **Unallocated items** count — items with zero assignees. The "Copy summary"
  button is disabled while any exist.
- **Allocation delta** — the sum of per-person food totals must equal the
  items subtotal to within 1¢. If it's off, the UI shows by how much.

The delta check is the thing that catches bugs in the splitting math itself.
It's effectively a runtime invariant the user can see.

---

## 5. Design decisions

### 5.1 Cents over a money library
Considered `dinero.js` and `decimal.js`. Rejected: the math here is small
enough that rolling it inline is clearer than pulling in a dependency, and
the cents convention is enforced by types (`type Cents = number`) plus
narrow helpers (`toCents`, `fromCents`, `fmt`). A library would buy currency
metadata I'm not using.

### 5.2 No global state library
Considered Zustand / Redux / Context. Rejected: there are five top-level
state atoms (`people`, `items`, `bill`, `extrasMode`, `undo`) and they all
live in one component. Adding a state library would be ceremony without
benefit. If Mesa grew to multi-bill or multi-route, this would flip.

### 5.3 Equal vs. proportional tax/tip as a user choice
This is a values decision, not a math one. "Equal" matches how groups
actually behave at restaurants ("tax and tip just split evenly"); "proportional"
is what's technically fair if one person ordered €5 and another ordered €50.
Defaulting to **equal**
([App.tsx:217](src/App.tsx#L217)) reflects the social default; the toggle
respects users who want strict fairness.

### 5.4 (Planned) Prompt and output shape for receipt parsing

For the OpenAI Vision call I'd structure it as:

- **Model**: `gpt-4o-mini` first for cost; fall back to `gpt-4o` only if the
  smaller model's confidence (or schema validation) fails.
- **Input**: image, plus a system prompt that's narrow — "extract restaurant
  receipt line items; one row per line item; ignore subtotal/tax/tip/total
  rows; if a row has a quantity prefix like '2x', set quantity accordingly."
- **Output**: structured outputs / JSON schema, e.g.
  ```ts
  {
    items: [{ name: string, price: number, quantity: number }],
    detected_tax: number | null,
    detected_tip: number | null,
    detected_currency: "EUR" | "USD" | "GBP" | "MXN" | null,
    confidence: "high" | "medium" | "low",
  }
  ```
- **Validation**: every item must have `price >= 0` and `quantity >= 1`;
  drop rows that fail and surface them as "couldn't parse N rows — add
  manually?" instead of silently discarding.
- **UX contract**: parsed items land in the same edit table as
  manually-added items, and the user reviews before assigning. The model
  *suggests*, the user *confirms* — never the other way around.

This last point is the one I care about most. The product never crosses the
line from "fast data entry" to "trust this number"; the human is always in
the loop because (a) receipt OCR is good, not perfect, and (b) the
consequence of a wrong number is real money.

### 5.5 Server-side over client-side OCR
Considered Tesseract.js (browser-side OCR). Rejected: receipt OCR
specifically is one of the hardest cases for classical OCR — varied fonts,
thermal-print fading, skew, faded ink. A multimodal model handles those well
without a preprocessing pipeline. The cost is a network round-trip and a
per-call charge, both acceptable for an action the user takes once per
meal.

---

## 6. Tradeoffs

| Decision | What I gave up |
|---|---|
| No persistence | A bill disappears on refresh. Acceptable for v1; would be the first thing to add for retention. |
| All state in `App.tsx` | The component is ~770 lines. It's fine for now but past ~1k lines it should split into a `useBill` hook + presentational components. |
| `open.er-api.com` (no API key) | Free and zero-config, but no SLA. A paid FX provider would be a one-line swap. |
| Vercel serverless | Cold starts on the OCR endpoint when traffic is sparse — adds ~1–2s on the first call after idle. Mitigation: warmup ping or move to an always-on container if usage justifies it. |
| Multimodal LLM over classical OCR | Per-call cost (cents) and latency (~2–5s typical). In exchange: dramatically better accuracy on real receipts and no preprocessing pipeline to maintain. |
| Human-in-the-loop confirmation | Slower than auto-applying parsed items, but the failure mode of a wrong line item silently entering the totals is bad enough that I want the friction. |

---

## 7. Challenges

- **Floating-point money.** The first version of the splitting math used
  floats and totals didn't reconcile to the cent. The cents refactor fixed
  it but required touching every helper. *Lesson: pick the unit before
  writing the math, not after.*
- **Tax/tip split semantics.** "Equal" vs. "proportional" sounds trivial
  until you write it down. Equal is straightforward integer division with
  remainder; proportional needs deterministic remainder assignment so the
  same inputs always produce the same outputs (otherwise totals shift on
  re-render). The fix: sort by weight desc, then index asc, and assign the
  remainder in that order
  ([App.tsx:262-272](src/App.tsx#L262-L272)).
- **FX flicker.** Initial implementation cleared `rate` to `null` on every
  refetch, so the UI flashed "—" each hour. Fixed by only clearing on base
  currency change and keeping the last good rate during refetch
  ([App.tsx:79-84](src/App.tsx#L79-L84)).
- **(Anticipated) Receipt parsing edge cases.** Multi-line items, modifiers
  ("+ extra cheese"), shared appetizers, pre-tax discounts. The plan is to
  start narrow (one line = one item, ignore everything else) and expand
  based on real receipts that fail.

---

## 8. What I'd improve

**Short-term (next on the list):**

1. **Wire up the OpenAI Vision call** — the actual reason this is an "AI/ML
   project." Schema + validation + the human-confirmation UI from §5.4.
2. **Image preprocessing** — client-side downscale to ~1600px on the long
   edge before upload. Cuts payload size and model cost without hurting
   accuracy on receipts.
3. **Local persistence** — `localStorage` for the active bill so a refresh
   doesn't nuke it. Cheap, high-value.

**Medium-term:**

4. **Split into hooks/components.** `useBill`, `usePeople`, `useItems`,
   `useReceiptParser`, plus presentational components for each section.
5. **Confidence-aware UI** — when the model returns `confidence: "low"`,
   highlight the parsed items differently and prompt the user to double-check.
6. **Per-user rate limit on the OCR endpoint** — a simple IP-based token
   bucket. The endpoint costs real money per call and is unauthenticated.
7. **Telemetry** — log parse success/failure rates and which fields most
   often need manual correction. That's the data that tells me where to
   improve the prompt.

**Longer-term / if I were doing this again:**

8. **Eval harness for the OCR.** A folder of ~50 hand-labeled receipts and
   a script that runs the current prompt against them, scoring item-level
   precision/recall. Without this, "improve the prompt" is vibes; with it,
   it's a measurable change.
9. **Two-call pipeline** — first call extracts text + bounding boxes, second
   call structures it. Slower and pricier but more accurate on faded
   receipts, and the intermediate text is debuggable in a way that a single
   end-to-end JSON output isn't.

---

## 9. Likely questions and how I'd answer

> **Why OpenAI specifically?**
> Multimodal quality, structured outputs, and the team's familiarity. Not
> locked in — the endpoint is the only place that knows about the provider,
> so swapping to Claude or Gemini is a single-file change.

> **What happens if the model returns garbage?**
> JSON-schema validation rejects it; the endpoint returns a 422 with a
> "couldn't parse — please enter manually" message; the existing manual-entry
> UI is still right there. The feature degrades to the v1 experience.

> **How would you test this?**
> Three layers: (1) unit tests on the cents math and split functions —
> deterministic, fast; (2) the eval harness from §8.8 for the model call;
> (3) one or two Playwright tests for the upload → parse → assign happy path.

> **What about cost?**
> A receipt image at `gpt-4o-mini` is sub-cent today. A naive abuse vector is
> someone scripting uploads, hence rate limiting (§8.6). At expected human
> usage (one bill per meal), cost is negligible.

> **What would you build next if you had a week?**
> Wire up the model call end-to-end with the schema and human-confirmation
> UI, build the eval harness, and ship `localStorage` persistence. In that
> order — the eval harness exists from day one of the model integration so
> I'm never tuning blind.

---

## 10. Deep dive — what actually shipped

> The original walkthrough above was written when the Vision call was scaffolded
> but not wired in. This section covers the implementation as it actually
> exists today: the endpoint, the prompt and schema, the frontend flow, the
> input-formatting plumbing, and the gotchas that came out during the build.

### 10.1 Endpoint anatomy
[api/parse-receipt-openai.ts](api/parse-receipt-openai.ts)

Top-to-bottom:

- **`export const config = { api: { bodyParser: false }`** — disables Vercel's
  default JSON body parser. Without this, multipart bodies get corrupted before
  `formidable` ever sees them.
- **`formidable` config** — `uploadDir: '/tmp'` (the only writable path on
  Vercel functions), `keepExtensions: true`, `maxFileSize: 10 MB`,
  `filter: p => p.mimetype?.startsWith('image/')`. Three checks (size, MIME,
  presence) before we ever spend money on a model call.
- **`Array.isArray(raw) ? raw[0] : raw`** — formidable's typing is
  `File | File[]` because a single field can have multiple uploads. Even with
  `multiples: false` the runtime can hand back an array. Caught this on
  `tsc --noEmit` rather than in production.
- **Per-request OpenAI client** — `new OpenAI({ apiKey: process.env.OPENAI_API_KEY })`
  inside the handler, not at module top level. Means a missing key surfaces as
  a clean 500 with a readable message rather than a module-load crash. Also
  means Vercel can boot the function before the env var is resolved on cold
  start without exploding.
- **`temperature: 0`** — receipt extraction is a structured task, not a
  creative one. Determinism makes regression debugging tractable: same image →
  same output (modulo OpenAI-side model drift).
- **Validation pass after the model returns** — even with strict structured
  outputs, we re-clean: trim names, coerce price/quantity to numbers, drop
  rows with empty names or non-finite prices. This guards against (a) the
  schema being violated on a future model version, and (b) the model returning
  whitespace-only strings or NaN-ish values that pass schema validation but
  break the UI. Dropped row count is surfaced to the client (`dropped: N`) so
  the UI can warn the user instead of silently swallowing data.
- **`finally { fs.promises.unlink(tmpPath) }`** — explicit /tmp cleanup. Vercel
  cleans up between invocations, but a long-warm function can accumulate
  files. Cheap to be tidy.
- **Error taxonomy** — `405` (wrong method), `413` (file too large, mapped
  from formidable's `maxFileSize` error message), `500` (no API key /
  unexpected), `502` (model returned empty or invalid JSON). Each has a
  distinct frontend response.

### 10.2 The prompt and the JSON schema

The system prompt is short and deliberately narrow:

```
- Return one entry per line item (food or drink). Ignore subtotal, tax, tip,
  service, gratuity, and total rows.
- "unit_price" is the price of a single unit, not the line total. If the
  receipt only shows a line total, divide by the quantity.
- "quantity" is the number ordered. Default to 1 if not shown. Lines like
  "2x Pizza 20.00" mean quantity=2, unit_price=10.00.
- "name" should be the human-readable dish/drink name as printed, trimmed.
- If the receipt shows tax or tip as an explicit line, return its numeric
  amount in detected_tax / detected_tip. Otherwise return null.
- detected_currency: return the ISO code only if you are confident (visible
  currency symbol or code). Otherwise null.
- If you cannot read the receipt, return an empty items array rather than
  guessing.
```

A few things to call out:

1. **Unit price vs. line total** is the single most common interpretation
   error. Receipts vary: some show `2 × 10.00 = 20.00`, some show
   `2x Pizza 20.00`, some only print the line total with no qty. The prompt
   pins the contract: always return the per-unit price, divide if necessary.
2. **"Empty array if unreadable"** is the failure mode I want. Without that
   instruction, vision models tend to hallucinate plausible-sounding items
   from a blurry image. An empty array is recoverable — the user adds items
   manually — and a hallucinated $14 "Caesar Salad" is not.
3. **Currency is opt-in** — `null` unless the model is confident. Defaulting
   to a guess would silently switch the user's currency mid-bill.

The JSON schema uses **strict structured outputs** (`strict: true`), which
means OpenAI guarantees the response conforms to the schema or the request
errors. Two strict-mode quirks worth knowing:

- **All properties must be `required`.** Optional fields aren't allowed.
  Workaround: union with `null`. That's why `detected_tax`, `detected_tip`,
  and `detected_currency` are typed `["number", "null"]` and
  `["string", "null"]` — they're "always present, sometimes null."
- **`additionalProperties: false`** is required at every object level. Easy to
  miss on nested schemas; the API rejects the schema at submit time if you
  forget.

### 10.3 Frontend upload flow
[src/App.tsx](src/App.tsx) — `handleReceiptUpload`

The flow has four moving pieces:

1. **Hidden `<input type="file">` + ref + visible button** — the standard
   pattern for prettier file pickers. The `ref` lives in `fileInputRef`; the
   visible `📷 Scan receipt` button calls `fileInputRef.current?.click()`.
   `e.target.value = ""` runs *immediately* on selection (not on success), so
   re-uploading the same file works — file inputs only fire `onChange` if the
   value actually changes.
2. **Three-state status machine** — `"idle" | "uploading" | "error"`. The
   button label and disabled state derive from it; success and error messages
   render inline next to the button. No loading spinner separately tracked —
   the button label *is* the spinner ("Scanning…").
3. **Append + auto-fill** — parsed items get `uid()` IDs, `assignments: []`,
   and are spread onto the existing items array (manual entries above,
   scanned items below). The original ordering is preserved.
4. **Auto-fill semantics** — currency is overwritten if detected (it's
   high-signal and rarely wrong); tax/tip are only filled if the user's
   current value is `0`, so a re-scan never clobbers a hand-typed adjustment.
   Stated as code:

   ```ts
   tax: b.tax > 0 ? b.tax : Number(data.detected_tax) > 0 ? Number(data.detected_tax) : b.tax
   ```

   That ternary is doing real work. It says: "if the user already set tax,
   keep it; else if the scan detected a positive tax, use it; else leave
   alone." Same shape for tip.

### 10.4 Title-case normalization

The model returns names exactly as printed: `MOJITOS`, `TAPA/ ENSALADA CESAR`.
Receipts print in caps; the rest of the app uses typed-style ("Sushi",
"Friend"). To match, the frontend normalizes on the way in:

```ts
const toTitleCase = (s: string) =>
  s.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
```

Two deliberate choices:

- **Client-side, not server-side.** This is presentation, not data. Keeping it
  in the UI means the API response stays "raw" (useful for future debug logs,
  evals, etc.) and a future toggle ("preserve original casing") is one prop
  away.
- **`\p{L}` Unicode property + `u` flag** instead of `\b\w/g`. The standard
  `\w` only matches ASCII letters and would mishandle accented characters
  ("CRÈME BRÛLÉE" → "CrèMe BrûLéE"). `\p{L}` matches any Unicode letter, so
  accented receipts (Spanish, French, Portuguese) format correctly.

### 10.5 The money-input UX

This was the largest implementation surprise relative to its perceived
difficulty.

**The constraint:** `<input type="number" value={7.5}>` displays `7.5`, not
`7.50`. Browsers strip trailing zeros from number inputs, and there's no
attribute or CSS to override it. To force `7.50`, you have to switch to
`type="text"` and control the displayed string yourself.

**The naive approach** (always-formatted controlled input) breaks editing:
typing `"7."` → the controlled value parses to `7`, re-renders as `"7"` or
`"7.00"`, and the user's trailing dot disappears mid-edit.

**The pattern that works** is a *focus-tracked controlled input*:

- While the field is focused, display the user's raw typed string.
- While not focused, display `value.toFixed(2)`.
- On change, parse and update the canonical numeric state (so live totals
  still update during typing).
- On blur, drop the raw string and revert to formatted display.

Implemented with one piece of state per field category:

```ts
const [editingPrice, setEditingPrice] = useState<null | { id: string; raw: string }>(null);
const [editingBillField, setEditingBillField] = useState<null | { field: "tax" | "tip"; raw: string }>(null);
```

Item rows key by `it.id`; bill fields key by literal `"tax"` / `"tip"`. The
trade-off is that only one field can be in "raw editing" mode at a time per
state, which is fine because keyboard focus already enforces that.

**Why two state objects instead of one generic `editingMoney`?** Cleaner
typing — `editingPrice` is constrained to item IDs, `editingBillField` to
two literal strings. A single state with a `string` ID would compile but
lose the discrimination. Cheap clarity for one extra `useState` line.

### 10.6 What surprised me during the build

A few things only obvious in hindsight:

- **`vercel dev` doesn't reliably read `.env.local` when the Development
  environment on Vercel is empty.** It pulls Development env vars from the
  cloud first; if the var isn't there, behavior is inconsistent. Fix:
  either add the var to Vercel's Development environment, or
  `set -a && source .env.local && set +a` before `vercel dev` so the parent
  shell carries the var into the function process.
- **Vercel Deployment Protection is on by default for new team-plan
  projects.** First deploy returned `401` for both `/` and `/api/*`. Took 30
  seconds in the dashboard to disable, but if you deploy and then test on
  your phone without checking, it looks like a deploy failure when it's an
  auth wall.
- **Formidable's `files` typing returns `File | File[]`** even with
  `multiples: false`. Caught at type-check, not runtime — `tsc --noEmit`
  earned its keep.
- **Vite's port fallback is silent and easy to miss.** When 5173 is taken,
  Vite jumps to 5174 without erroring. If you read the wrong terminal you
  end up loading a stale dev server. The fix in this case was unrelated
  (vite was running from the wrong directory entirely), but the silent
  fallback masked it for a few minutes.

### 10.7 What's measurable now, what isn't

What I can speak to:

- **Latency**: a single receipt at `gpt-4o-mini` returns in ~2–4 seconds in
  our local tests, plus a small Vercel cold-start penalty (~1s) on the first
  request after idle.
- **Cost**: well under a cent per receipt at current `gpt-4o-mini` pricing.
- **Accuracy on the one test receipt**: 7/7 items extracted with correct
  names; quantities and prices were largely right but worth spot-checking
  before relying on totals (the inline edit affordances exist for exactly
  this reason).

What I'm flying blind on:

- **No eval harness yet.** "It worked on this receipt" is one data point.
  The next step (and the thing that would let me iterate the prompt with
  any confidence) is a folder of ~50 hand-labeled receipts and a script
  that scores item-level precision/recall against the current prompt.
- **No rate limit.** The `/api/parse-receipt-openai` endpoint is public and
  unauthenticated. Fine for personal use; would need a token-bucket per IP
  before this URL gets shared anywhere public.
- **No telemetry.** I don't know how often `dropped > 0`, how often the
  user immediately edits a parsed price, or which fields the model gets
  wrong most often. That's the data that turns prompt tuning from vibes
  into a measurable change.

---

## Annotation prompts

Things to think about adding in your own voice:

- A specific receipt that broke an early version, and what you changed.
- Numbers: how long does the parse call take in practice? What's the
  per-call cost you measured?
- Anything you tried and threw away (failed prompt versions, a different
  upload approach, a state library you removed).
- The moment you decided cents-over-floats — was that upfront or after a
  bug?
- Where the human-in-the-loop instinct comes from for you.
