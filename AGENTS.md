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
| `bria-genfill` | outpaint to breakpoint | matches input canvas | `service/outpaint_test.py`; flaky, retry |
| `gemini-3.1-flash-lite-image` | text-to-image with **accurate text** | 1024×1024 | `service/nano_banana_test.py`; worked first try |

**`gemini-3.1-flash-lite-image` is nano-banana 2 Lite.** GMI Cloud is a day-zero launch partner for it, and it is reachable through `GMICloudImageProvider` despite being unregistered. It rendered an exact wordmark plus secondary line, correctly spelled and cleanly kerned, including a properly mirrored reflection — and it succeeded on the first attempt with no retries, notably more reliable than genfill.

Untried siblings, likely also reachable: `gemini-3.1-flash-image`, `gemini-3-pro-image`, `gemini-2.5-flash-image`.

Note each model returns its own fixed size (2048² vs 1024²) and none honour dimension params — the outpaint recipe is still how we hit a breakpoint.

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

This is load-bearing for PEG, and the fix is the outpaint recipe below.

### The outpaint recipe — PROVEN, this is how PEG hits a breakpoint

Verified end-to-end: square plate → **exactly 1920×600** with the brand look intact and clear headline space. See `service/outpaint_test.py`.

1. Generate the plate with `seedream-5.0-lite` (comes back 2048×2048).
2. Scale it to the target's short edge and paste it at the **focal point** on a target-sized canvas (e.g. flush right on 1920×600 when `focalPoint: "Right"`).
3. Build an `L` mask: **white = generate, black = keep**. Gaussian-blur the boundary (~16px sigma) or you get a hard vertical seam.
4. Call `bria-genfill` with `image` + `mask` as **base64** — see the gotchas below.
5. Result comes back at the canvas dimensions. This is what makes "compose, never crop" real.

Non-obvious details that cost several failed runs:

- **The params are `image` and `mask`, not `image_url`/`mask_url`.** Both are in the allowlist, but passing the `_url` variants returns `400 invalid payload parameters: image (Required parameter is missing)`.
- **Pass base64, not URLs.** Presigned B2 URLs get the connection reset on submit.
- **A `negative_prompt` naming the objects is mandatory.** Without it genfill happily paints *more podiums* into the space that was supposed to stay empty. Name them: `podium, pedestal, cylinder, platform, object, duplicate, repeated shapes…`
- Prompt the fill as an *empty backdrop*, not as a continuation of the scene.

### GMI reliability — plan for it

The genfill endpoint **drops connections frequently**: across 7 submits we saw `Connection reset by peer`, `Server disconnected without sending a response` (×3), and one `BrokenPipeError` *mid-transfer* which made Genblaze discard the manifest too. Roughly 1 in 3 submits succeeds.

Shrinking the payload (PNG→JPEG q92, 308KB→109KB base64) did **not** fix it. **Retry with backoff is required** — 3 attempts was enough every time. Any production path must retry, and must treat a failed asset transfer as a failed run.

### Parameters

Registered models enforce a `param_allowlist` and silently drop the rest — e.g. `bria-genfill` drops `width`/`height`. Its allowlist: `prompt`, `negative_prompt`, `image`, `image_url`, `mask`, `mask_url`, `strength`, `denoise`, `resolution`, `aspect_ratio`, `seed`, `number_of_images`.

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

Env: `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET`, `B2_REGION`. GMI: `GMI_API_KEY`, `GMI_BASE_URL`.

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

**A faint seam survives feathering** at the mask boundary. Try a wider feather or overlapping the paste region.

## Commands

```bash
npm run dev        # dev server
npm run build      # production build
npm run typecheck  # tsc --noEmit
```

```bash
./service/.venv/bin/python service/check_env.py       # credentials + live auth
./service/.venv/bin/python service/smoke_test.py      # generate -> B2 -> manifest
./service/.venv/bin/python service/outpaint_test.py   # square -> 1920x600 breakpoint
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
