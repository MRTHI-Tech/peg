# AGENTS.md

Project-specific guidance for AI coding agents.

---

# PEG

## What we are building

**PEG generates brand-locked key visuals at every breakpoint.**

A brand defines its look once — reference images, palette, lighting, materials. From then on, any campaign brief produces a finished hero plate that matches that look, composed correctly for whatever canvas it needs to fill, with the real product composited on top.

Built for the Backblaze Generative AI Media Hackathon. Possibly a real product afterwards.

## The thesis, in one line

**Compose, don't crop.**

Cloudinary, imgix, and every DAM already crop one image N ways — which is exactly why a desktop hero looks wrong on a 14" laptop. A single composition cannot serve every aspect ratio.

PEG generates a *different composition* per breakpoint from the same brand lock. Desktop gets the product right-of-center with the left third clear for the headline. Mobile gets it stacked with room at the top. Same brand, same lighting, same palette — composed for each canvas rather than cropped down to it.

## The second rule that shapes the architecture

Earlier drafts of this file said "diffusion cannot render your product, do not try." **That was wrong and has been tested.** `gemini-3.1-flash-lite-image` (nano-banana 2 Lite, via GMI) renders exact wordmarks crisply and correctly spelled, including in reflections. See `service/nano_banana_test.py`.

The accurate rule is narrower:

**Do not expect a model to conjure a brand asset it has never seen.** Asking for "the Discovery Bank logo" gets an approximation. But *specifying* text, or *supplying* the asset, now works well.

So there are two valid paths, chosen per element:

| Path | When | How |
|---|---|---|
| **Composite** the real cutout | The hero product, anything with legal/brand sign-off, exact marks (VISA, card numbers) | `Product Asset` → `Place Product`, locally |
| **Generate** it | Secondary presence — product in a reflection, at an angle, distant, relit to match the plate | Gemini image model with the text specified |

Compositing remains the default for the hero product for **compliance** reasons, not technical ones: "very close" is a brand failure when a team signs off pixel-exact assets. But generation is no longer off the table, and it does things a flat PNG composite cannot — angles, reflections, matched relighting.

## Who it is for

Corporate marketing and brand teams who currently commission agencies for key visuals. The spend being attacked is 3D product renders and brand libraries — not cropping, which is the cheap and already-solved part.

---

## Status

**The UI is real. The backend is not.** Every generation is mocked; no API has been called yet.

- `lib/workflow-service.ts` is the **only** module touching data. It is the single file to change when Genblaze and B2 are wired up. Components never fetch.
- Node results are deterministic SVG gradient data-URIs from `lib/placeholder.ts`. Swap for real B2 URLs via `AssetRef.url`.

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js 16 (App Router, Turbopack) | React 19 |
| Language | TypeScript **6** | **Not 7** — TS 7 does not expose the compiler API Next.js needs |
| Design system | Astryx 0.2.0 + `@astryxdesign/theme-neutral` | dark mode pinned |
| Icons | `lucide-react` | Astryx's semantic icon set is small; it explicitly directs you here |
| Orchestration | Genblaze (Python SDK) | **not yet integrated** |
| Storage | Backblaze B2 (S3-compatible) | **not yet integrated** |
| Manifest types | `@genblaze/spec` (npm) | TypeScript types + JSON Schema for provenance. Use instead of hand-rolling |

Genblaze is Python and will not run in Node. It needs a separate service (FastAPI) that Next.js route handlers proxy to.

## Deployment

Two services on Render (`render.yaml`), because genblaze is Python-only and a
run takes minutes — past any serverless timeout.

| Service | Runtime | Notes |
|---|---|---|
| `peg-service` | Python 3.11 | FastAPI + genblaze. No public URL; reached over Render's private network |
| `peg-web` | Node 24 | Next.js. `PEG_SERVICE_URL` is injected via `fromService` |

**Do not try to wire the two services with `fromService`.** Both properties were
tested against the live deploy and neither yields a reachable address on the
free tier: `hostport` produced something the app could not resolve, and `host`
returns the bare internal name `peg-service` with no domain. `PEG_SERVICE_URL`
is therefore set explicitly to the public hostname — update it if the service is
renamed.

**peg-service is on the public internet**, because Render's Private Services are
a paid feature. `POST /runs` and `GET /runs/{id}` require `X-PEG-Token`, matched
against `PEG_SERVICE_TOKEN` — generated once by Render and mirrored onto
`peg-web`. `/health` stays open for platform probes. Verified: an
unauthenticated submit returns 401. An unset token means open, which keeps local
development frictionless.

Blueprints **do** apply env var changes automatically on push; no manual sync is
needed.

`GET /api/health` on the app reports the resolved service address and whether
the upstream answers. Use it first when a deploy misbehaves — otherwise a
misconfigured URL and a dead service both look like "fetch failed".

Secrets are `sync: false` — entered once in the Render dashboard, never
committed. The free tier idles both services down after ~15 minutes and a cold
start is 50s+ *per service*; warm the URL before demoing.

## Layout of the code

```
app/
  layout.tsx            root; Astryx CSS imports live here
  providers.tsx         Theme + LinkProvider + i18n boundary
  page.tsx              project gallery
  project/[id]/page.tsx canvas editor entry
components/
  brand/PegLogo.tsx
  canvas/               NodeCanvas, NodeCard, node-metrics — the custom canvas layer
  editor/               CanvasEditor (owns all graph state), IconRail, PalettePanel,
                        InspectorPanel, EditorTopBar, ZoomToolbar
  gallery/              WorkflowCard, TemplateCard
lib/
  types.ts              PegNode, Edge, Port, AssetRef, Provenance, NodeDef
  catalog.ts            every palette node + verified model IDs
  canvas-geometry.ts    world/screen math, bezier paths, connection validity
  mock-data.ts          fixtures
  workflow-service.ts   THE backend seam
  placeholder.ts        generated stand-in imagery
```

---

## Conventions

### Astryx

The full ruleset is in the Astryx block at the bottom of this file — follow it. In practice, for this repo:

- **Chrome is pure Astryx.** Panels, toolbars, inputs, cards, text. Never hand-roll what the design system already has. Run `npx astryx component <Name>` before using a component; do not guess prop names.
- **The canvas layer is the one exception.** Node positioning, SVG bezier edges, and the pan/zoom transform are raw DOM because Astryx has no graph primitive. That layer still uses tokens for every color, radius, and shadow.
- **No `xstyle`.** There is no StyleX compiler here. Custom styling goes through `style`/`className` with `var(--color-*)`, `var(--spacing-*)`, `var(--radius-*)`, `var(--shadow-*)`.
- **Spacing tokens are hyphenated**: `--spacing-1-5`, not `--spacing-1_5`.
- **Never append alpha to a token.** `${color}33` is invalid CSS. Use `color-mix(in srgb, ${color} 30%, transparent)`.
- Prefer gap-based spacing over margins. `Section` is a bare container — it has no `title` prop.

### Next.js / React

- **Anything passing a lucide component to Astryx needs `'use client'`.** Passing a component reference across the server→client boundary throws.
- **Never pass `as={Link}`.** `LinkProvider` in `providers.tsx` already routes every Astryx `href` through `next/link`.
- **Locale is pinned to `en-US`, and `Timestamp` must use `system_*` formats.** Node renders en-US, browsers may render en-GB; anything else fails hydration on every card.
- Graph state lives in `CanvasEditor` only. Inspector and canvas read from that one source.

### Code style

- Comments explain *why*, not *what*. Load-bearing decisions get a comment; obvious code does not.
- Type imports use `import type`.
- Logical CSS properties (`insetInlineStart`, `blockSize`) — the design system is RTL-aware.

---

## Verified API facts — do not invent beyond these

Everything below was checked against the **installed SDK** (`genblaze 0.4.5`, `genblaze-core 0.3.8`, `genblaze-gmicloud 0.3.5`) and live API calls on 2026-08-01. The repo docs on `main` are **ahead of PyPI** and describe models that the published SDK does not register — trust this section over the docs.

### Confirmed working end-to-end

| Model | Role | Output size | Notes |
|---|---|---|---|
| `seedream-5.0-lite` | text-to-image plate | 2048×2048 | `service/smoke_test.py` |
| `gemini-3.1-flash-lite-image` | text-to-image with **accurate text** | 1024×1024 | `service/nano_banana_test.py`; worked first try |
| `bria-expand-v2` | canvas expansion to breakpoint | exactly the requested canvas | `service/expand_test.py`; **direct Bria, not GMI** |

**`bria-genfill` is no longer how PEG reaches a breakpoint.** It is still a live, working GMI model, but it is the wrong tool for canvas extension — see the expansion recipe below. Extend Canvas now calls Bria's `/v2/image/edit/expand` **directly**, outside GMI.

**`gemini-3.1-flash-lite-image` is nano-banana 2 Lite.** GMI Cloud is a day-zero launch partner for it, and it is reachable through `GMICloudImageProvider` despite being unregistered. It rendered an exact wordmark plus secondary line, correctly spelled and cleanly kerned, including a properly mirrored reflection — and it succeeded on the first attempt with no retries, notably more reliable than genfill.

Untried siblings, likely also reachable: `gemini-3.1-flash-image`, `gemini-3-pro-image`, `gemini-2.5-flash-image`.

Note each model returns its own fixed size (2048² vs 1024²) and none honour dimension params — expanding the canvas afterwards is still how we hit a breakpoint.

### How the model registry actually behaves

`genblaze-gmicloud` 0.3.5 seeds only **8 image models**, all edit/inpaint:

`bria-eraser`, `bria-genfill`, `gpt-image-2-edit`, `reve-edit-20250915`, `reve-edit-fast-20251030`, `reve-remix-20250915`, `reve-remix-fast-20251030`, `seededit-3-0-i2i-250628`

**The registry is a pricing/param seed, not an allowlist.** `GMICloudImageProvider`'s own docstring states unknown models pass through to the queue. So unregistered ids like `seedream-5.0-lite` work — pass `preflight=False` to `Pipeline` so it doesn't reject them locally.

There is **no way to list image models**. `discover_models()` returns `DiscoveryStatus.UNSUPPORTED` with zero slugs, `list_models()` returns `[]`, and `GET /v1/models` is the **chat** catalog only (79 LLMs, no image models). The image path is async job submission to `/v1/requests`.

### Probe results (live)

| Model | Status |
|---|---|
| `bria-genfill`, `bria-eraser`, `gpt-image-2-edit` | **ok** |
| `seedream-5.0-lite` | **works** (verified by real generation) |
| `reve-remix-20250915` | **DEAD** — upstream probe returns not_found |
| `seededit-3-0-i2i-250628` | **entitlement-gated** — probes LIVE but real submits 404 "no access" |
| `flux-kontext-pro`, `bria-fibo-image-blend`, `bria-fibo-relight` | unknown — not registered, untested |

### KNOWN LIMITATION: output dimensions are not controllable

`seedream-5.0-lite` **ignores** `resolution`, `aspect_ratio`, `width`, and `height`. The SDK verifiably sends all four in the payload (`prepare_payload` confirms) and the API returns **2048×2048** regardless.

This is load-bearing for PEG, and the fix is the expansion recipe below.

### The expansion recipe — this is how PEG hits a breakpoint

**A masked inpaint is not a canvas extension. Do not go back to one.**

The original recipe pasted the plate onto a target-sized canvas, painted a feathered white mask over the empty region, and asked `bria-genfill` to fill it. It reaches the right dimensions, and for a *narrow* margin it looks fine. Given a large empty region it fails in a specific, repeatable way: **genfill invents a second, separate scene beside the source** rather than continuing the original one. A masked fill is only told "put something plausible here" — nothing in the request says the new pixels are the *same photograph* as the kept ones. Reproduced live in isolation on 2026-08-03; that test is what motivated the rewrite.

Bria's `/v2/image/edit/expand` is the purpose-built operation. It takes explicit geometry instead of a mask:

| Field | Meaning |
|---|---|
| `image` | the source, base64, at exactly its rendered size |
| `canvas_size` | `[w, h]` of the result |
| `original_image_size` | `[w, h]` the source occupies in that result |
| `original_image_location` | `[x, y]` of its top-left corner |

The current shape, all of it in `service/expand_geometry.py` and `service/bria_expand.py`:

1. Generate the plate normally (any size — 2048² is fine).
2. `prepare_expand(source, fmt)` detects a flattened brand frame, peels it, scales the scene to fit the inner canvas, and chooses a placement that keeps the source **out of the copy-safe band**. It returns both the model-facing scalars and the local-only material for step 5.
3. `run_outpaint` refuses the job if the safe area still overlaps protected source pixels, or if the target does not actually extend the source. Both are cheaper as errors than as a bad paid render.
4. `BriaExpandProvider` submits, polls `/v2/status/<id>`, and downloads. **The POST is paid and unsafe to repeat**, so a 5xx or transport failure on it raises a deliberately non-retryable `UNKNOWN`; only the GETs retry.
5. `finalize_expand` pastes the original source pixels back over the model's output (feathered ~4px at the seam) and rebuilds the outer frame and corner lockup locally.

Step 5 is the point. **The model is never asked to reproduce anything we already have.** It supplies only newly revealed scene; every protected pixel is restored deterministically, so brand chrome cannot drift.

### The safe area must sit on the axis the target actually frees

Extend Canvas contains the whole source rather than cropping it, and that has a
consequence worth internalising before touching `_placement`:

- A source at least as wide as it is tall, contained in a **portrait** target,
  scales to the target's full *width*. It spans the canvas edge to edge, so a
  `left-third` or `right-third` band is entirely preserved pixels and **no
  placement can avoid it**.
- The same source in a **landscape** target scales to full *height* and leaves
  horizontal room, so `left-third` works and `upper-third`/`lower-third` do not.

A fixed `Left third` default therefore guaranteed a failed run on every portrait
preset. `safeAreaForTarget` in `lib/formats.ts` moves the band when the target
changes; it only ever moves one that cannot work, and leaves `Center` alone.

Whether a *remaining* overlap is acceptable depends on what else was on offer,
not on the raw number:

| Situation | Behaviour |
|---|---|
| No overlap | runs |
| Another band clears the source completely | **refused**, naming that band |
| Nothing clears, ≤ `SAFE_AREA_MAX_OVERLAP` (50%) | runs, with a warning |
| Nothing clears, > 50% | refused |

The middle row is the one that matters: a clean alternative means the chosen
band is a silent downgrade, so it is refused rather than warned. The third row
exists because a fully clear band is unreachable whenever the target's aspect
ratio is close to the source's — 1:1 into 4:5 frees less new height than a third
of the canvas — and refusing those made the whole Instagram-portrait preset
unusable. Warnings ride on a **successful** `RunOutcome`; a run that produced an
asset must never be reported as failed.

`clear_safe_areas` re-plans each candidate rather than measuring it against the
current placement, because placement itself depends on the safe area. Measuring
in place reports "nothing clears" for a free-floating source that would in fact
be fine once re-seated, which is worse than no advice at all.

Non-obvious details:

- **Send the source at its rendered size.** `model_input` is already resized to `original_image_size`. Uploading a 2048² plate and declaring a 600px render wastes payload and invites disagreement.
- **A `negative_prompt` naming the objects is still mandatory.** Expansion duplicates subjects less than genfill did, but not never. `DEFAULT_NEGATIVE` in `runner.py` names them.
- **Prompt it as a continuation, not as an empty backdrop.** This is the opposite of the genfill advice and it is deliberate — the endpoint's whole job is continuing one photograph.
- **Never follow Bria's returned `status_url`.** It is validated for protocol drift and then discarded; the canonical endpoint is reconstructed from the request id. Output URLs are checked against an allowlist of Bria delivery hosts before any download.
- `BRIA_API_TOKEN` is separate from `GMI_API_KEY` — this endpoint is not exposed through GMI Cloud. The service boots without it; only Extend Canvas fails, with a scoped configuration error.

- ⚠️ **`request_id` in a status body is not the job id.** Bria mints a fresh one for every status GET — three calls against one finished job returned three different ids, none of them the job's. An early version treated it as a correlation check and rejected a job that had actually completed. Correlation comes from the status URL, which we construct ourselves. Do not add that check back.
- **Delivery URLs are `temp.bria.ai`** in practice, and signed/expiring. `_completed_result` re-reads status on a fetch retry so a stale URL refreshes rather than 403s.

**Verified live end-to-end on 2026-08-04**: 2048² plate → **exactly 1920×600**, one continuous photograph with the podiums held on the right and a calm left third for a headline. No second scene, no duplicated subject, no inset frame — the genfill failure is gone. The seam where restored source meets generated pixels measures a column delta of ~1.8 against a ~1.2 baseline in flat areas and ~5.0 inside the source itself, i.e. below the image's own noise floor and invisible at 3× zoom. The 4px `SEAM_FEATHER` is enough.

### GMI reliability — plan for it

Measured on the genfill endpoint, but treat it as GMI's general behaviour at this payload size: it **drops connections frequently**. Across 7 submits we saw `Connection reset by peer`, `Server disconnected without sending a response` (×3), and one `BrokenPipeError` *mid-transfer* which made Genblaze discard the manifest too. Roughly 1 in 3 submits succeeds.

Shrinking the payload (PNG→JPEG q92, 308KB→109KB base64) did **not** fix it. **Retry with backoff is required** — 3 attempts was enough every time. Any production path must retry, and must treat a failed asset transfer as a failed run.

### Parameters

Registered models enforce a `param_allowlist` and silently drop the rest — e.g. `bria-genfill` drops `width`/`height`. Its allowlist: `prompt`, `negative_prompt`, `image`, `image_url`, `mask`, `mask_url`, `strength`, `denoise`, `resolution`, `aspect_ratio`, `seed`, `number_of_images`.

This applies to the GMI registry only. `BriaExpandProvider` is ours, talks to Bria directly, and validates its own params — it rejects anything outside the six geometry scalars plus `seed` rather than dropping it silently.

Unregistered models get every param passed through untouched — which is why seedream *receives* dimension params and ignores them anyway.

**`guidance` and `steps` do not exist.** Do not add them back.

### Real `StepType` enum

`generate`, `upscale`, `transcode`, `mix`, `edit`, `custom`, `ingest`, `import`.

**There is no `classify`** — the docs claim it; the SDK does not have it. `edit` exists and is more useful to us.

### What does NOT exist

- **No LoRA or fine-tuning.**
- **No segmentation.** Masks are *consumed* (`bria-genfill`, `bria-eraser`) but never *generated*. No SAM, no grounding-dino. Masks must come from our own UI.
- **No image processing** — no crop, resize, blur, levels, channels, or compositing. Those run locally or not at all.
- **No connector for** Black Forest Labs direct, Higgsfield, Recraft, Freepik/Mystic, or Ideogram.

### Genblaze shape

```python
Pipeline("name", chain=True, preflight=False).step(
    provider, model="...", prompt="...", modality=Modality.IMAGE,
    params={...},
).run(sink=sink, timeout=300, raise_on_failure=False)
```

`chain=True` feeds each step's output into the next.

Note `Pipeline.run()` currently **swallows step failures** — it returns `status: completed` even when nothing was produced. Always pass `raise_on_failure=True` in real code, and always assert an asset actually landed.

### B2

Env: `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET`, `B2_REGION`. GMI: `GMI_API_KEY`, `GMI_BASE_URL`. Bria (Extend Canvas only): `BRIA_API_TOKEN`.

`ObjectStorageSink(backend, prefix="peg", key_strategy=KeyStrategy.HIERARCHICAL)` produces:

```
<prefix>/runs/<YYYY-MM-DD>/<run_id>/manifest.json
<prefix>/runs/<YYYY-MM-DD>/<run_id>/assets/<uuid>.jpg
```

Do not hand-roll object keys. Manifest top-level shape is `canonical_hash`, `encryption_scheme`, `manifest_uri`, `run`, `schema_version`, `signature`, `transfer_failures` — **assets live under `run`, not at top level**. `manifest.verify()` returns `True`.

**B2 has no query capability.** Listing and search need `ParquetSink` or our own index. The gallery currently fakes this.

⚠️ The bucket `frameZA` already holds a previous project under `projects/`. PEG writes under the `peg/` prefix only — do not touch or delete anything else.

---

## Decisions already made — do not relitigate

- **Not a Weavy clone.** Weavy was the starting structure only. The product is brand-locked key visuals.
- **Video and audio are `coming-soon`.** Visible in the palette, badged, `disabled`, not addable. Held back on cost and validation time, not capability.
- **Node names are jobs, not models.** "Match Brand Look", not "FLUX Kontext". The model ID renders underneath as reference detail.
- **Public demo uses a fictional brand.** Real corporate brands create trademark exposure and imply endorsement.
- **A workspace is a Clerk organization**, falling back to the user's own id when they are not acting in one. Everything a workspace owns lives under `peg/workspaces/<workspace>/`, which is what makes a fresh sign-in an empty state — there is no first-run mode, seeding, or reset anywhere, just a prefix with nothing under it. Objects written before this (`peg/brand/*`) are orphaned on purpose and belong to nobody.
- **An organization is required, not optional.** Pages call `requireOrganization()`, which bounces anyone without one to `/workspace` to pick or create it. Clerk's `force_organization_selection` is off, and without this gate a new signup builds a brand in a personal workspace and loses sight of it the moment they create an org — same person, different B2 prefix, empty by design. A solo user makes an org of one. `currentWorkspace()` keeps a personal-id fallback for stray API calls so they read an empty workspace rather than hard-failing.
- **peg-service never talks to Clerk.** peg-web resolves the session to a workspace and passes it as `X-PEG-Workspace`; the service refuses any request without one. This trusts peg-web — anyone holding `PEG_SERVICE_TOKEN` could name any workspace — which is acceptable while the token is ours and is fixed by the service verifying the Clerk token itself.
- **Auth is checked at the resource, never in the proxy.** `proxy.ts` only makes the session available; pages call `auth.protect()` and route handlers call `currentWorkspace()`. Clerk deprecated `createRouteMatcher` because a matcher can drift from how Next routes a request, and that failure mode is a protected resource silently becoming reachable.
- **Editing the brand kit is an admin act.** `canEditBrand()` allows `org:admin` inside an org, and anyone in a personal workspace. Enforced on `PUT /brand` and all of `/brand/assets`; the page renders read-only for members. Reading the brand stays open to everyone — members need it, they just cannot change what every generation is locked to.
- **The gallery lists real runs, not fixtures.** `GET /projects` lists B2 objects under the workspace's `runs/` prefix. B2 has no query capability, but listing by prefix works, and because a workspace owns its whole prefix the empty state is real storage being empty rather than a first-run flag. Manifests are deliberately not opened — that would be one GET per card.
- **Cut from the palette and staying cut:** dead providers, LoRA nodes, segmentation nodes, and the local editing suite (levels/blur/invert/channels/crop/resize/merge-alpha/iterators).
- **The brand kit asks for artwork, not prose.** No look description — the audience is a marketing team, and the campaign brief belongs on the canvas where the asset is made. See the open question this creates.
- **Composited assets carry a `kind`** (`logo` / `screenshot` / `product` / `other`) because placement differs per kind. The style-reference vs composite split is unchanged and load-bearing; a file crosses lanes by being re-uploaded, never relabelled.
- **Typography is captured as a classification, not a typeface** (`brand.TYPE_CLASSES`). Font names cannot be rendered by any model and are not something a marketing team should have to look up.

## Open questions

**Style-locking from a reference image is still untested.** The proven path so far generates the brand look *from a prompt*, which worked well. Conditioning on an actual uploaded reference (the Style Kit node's real job) has not been proven — `flux-kontext-pro` is unregistered and untried, and the two reference-conditioned models we counted on are out: `reve-remix-20250915` is DEAD upstream and `seededit-3-0-i2i-250628` is entitlement-gated. Candidates left: `reve-edit-20250915`, `gpt-image-2-edit`, or an unregistered id passed through.

**The brand lock is now palette-only for any new brand, and nothing fills the gap yet.** The brand form no longer asks for a look description — a marketing team briefs each campaign on the canvas instead — so `Brand.prompt_prefix()` emits only the extracted hex values unless a `description` was stored by an earlier version. That removes the one conditioning mechanism actually proven to hold. The intended fix is deriving the description from the uploaded style references (the unbuilt Read Style node, `GEMINI_API_KEY`); until that exists, expect weaker brand adherence than the smoke tests showed. `description` is still read and honoured, and `PUT /brand` deliberately does not accept it so an empty form cannot erase one.

**Portrait output has not been eyeballed.** Landscape is confirmed good on real framed artwork through the deployed canvas, and `expand_test.py` proved a clean plate → 1920×600. Portrait targets only started running once the safe-area rule was relaxed, so `1080×1350` — the case that runs *with a warning* at ~31% overlap — has never been looked at. Check that a headline over that band is actually legible before treating the preset as shipped; if it is not, `SAFE_AREA_MAX_OVERLAP` is the dial.

## Commands

```bash
npm run dev        # dev server
npm run build      # production build
npm run typecheck  # tsc --noEmit
```

```bash
./service/.venv/bin/python service/check_env.py       # credentials + live auth
./service/.venv/bin/python service/smoke_test.py      # generate -> B2 -> manifest
./service/.venv/bin/python service/expand_test.py     # square -> 1920x600 breakpoint (paid)
```

```bash
npm test           # web + service unit tests, no credentials or spend
```

Always run `npm run typecheck` and `npm run build` before declaring work done.

---

<!-- ASTRYX:START -->
Astryx v0.2.0 · 154 components
CLI: run every command as `npx astryx <cmd>` (shown below as `astryx ...`).

SETUP (once, in your app entry e.g. main.tsx) — without these, components render unstyled:
  import "@astryxdesign/core/reset.css";
  import "@astryxdesign/core/astryx.css";

WORKFLOW — discover, don't guess. Before writing UI:
1. `astryx build "<idea>"` — START HERE: returns a kit (closest [page] + [block]s + [component]s). No args = full playbook.
2. `astryx template <name> [--skeleton]` — scaffold the [page]/[block]s it named, or study their layout. Templates are reference code.
3. `astryx component <Name>` — props + examples for every component you use.

RULES:
- No <div> — components do all layout/spacing. Full page → AppShell; sidebar nav → SideNav.
- Frame first: pick the shell (AppShell / Layout+LayoutPanel) and budget regions in px BEFORE writing content (`astryx docs layout`).
- Dense data = rows (Table, List/Item) edge-to-edge — never Card-wrapped list items. Card = dashboard widgets, galleries, settings groups only.
- Status → StatusDot/Token; Badge only for counts and enumerated states, never decoration.
- Custom styling: component props first; else style/className with tokens — var(--color-*|--spacing-*|--radius-*). No raw hex/px. (No StyleX/Tailwind compiler here — don't use xstyle/utility classes.)
- Tokens for every value (`astryx docs tokens`). Brand/accent via `astryx theme` — never override --color-* in :root.
- SELF-CHECK before you finish: re-read the file and replace any raw <div>/<span> layout, imported .css/@apply, or hardcoded value (#hex, 16px) with the component or a token (var(--color-*|--spacing-*|…)). If unsure a component/prop exists, run `astryx component <Name>` / `astryx search "<thing>"`; don't hand-roll CSS.

MORE CLI:
  search "<query>"   find any component / hook / doc / template / block
  component --list   154 components by category
  template --list    page + block recipes
  docs <topic>       color, elevation, icons, illustrations, internationalization, layout, migration, motion, principles, shape, spacing, styling, theme, tokens, typography
  swizzle <Name>     eject component source for deep customization
  upgrade --apply    run after any @astryxdesign/core bump
<!-- ASTRYX:END -->
