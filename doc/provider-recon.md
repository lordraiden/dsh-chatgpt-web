# Provider recon — `chat.qwen.ai` and `chat.deepseek.com`

> **What this document is.** A *measured* brief for two candidate consumer-web providers, produced the
> same way the Qwen Code protocol was measured ([`qwen-code.md`](./qwen-code.md) §2, §4.1): fetch the
> app shell, fetch the JS the app actually ships, and read the API surface out of it — plus whatever
> the endpoints answer to an anonymous caller.
>
> **What it is not.** No driver, no adapter change, no dependency, no Qwen Code edit. Nothing here is a
> proposal; it is what was observed on **2026-10-20** and nothing more.
>
> **No credentials were used.** No login, no account, no cookie or token was supplied, imported or
> stored. Every request below is the kind of request any visitor's browser makes; the only "trick"
> used is the one already established for Qwen Code — read the *public* bundle from the vendor CDN
> instead of the page, and (for DeepSeek) note which static paths the CDN/WAF serves.
>
> **Claim labels.** Each fact says how it was obtained:
>
> - **measured** — an HTTP response captured in this session (status/body quoted);
> - **bundle** — a symbol or literal in the vendor's own shipped JS (path + symbol quoted);
> - **unknown** — not established, with the cheapest observation that would settle it.
>
> Versions matter and are pinned below; a provider's protocol is only as current as the bundle named.

---

## 0. Summary of answers

| Question | Answer |
| --- | --- |
| Is `chat.qwen.ai` a different API from `coder.qwen.ai`? | **Yes.** Different path family (`/api/v2/chat/completions`, `/api/v2/chats/new` vs `/coder/api/v2/task/completions`, `/coder/api/v2/task/new`), different turn body, different stream frame set, different client `Version` (`0.3.20` vs `0.0.29`). It is the *same vendor auth* (`https://auth.qwen.ai/api/v2/auths/refresh`, `coder_google`/`coder_github` OAuth providers) and the *same response-envelope convention* (`success` / `request_id` / `data`, and `success:false` + `Unauthorized` at HTTP 200). |
| Does `chat.qwen.ai` expose its model list without a session? | **Yes, publicly.** `GET https://chat.qwen.ai/api/models` and `GET https://chat.qwen.ai/api/v2/models` both answer 200 anonymously (3 models, full metadata). Caveat: that list carries `is_visitor_active` and may be the *visitor* subset, not the account's full menu. |
| Does `chat.qwen.ai` expose its modes without a session? | **Yes — from the bundle, not from an API.** The three modes are labels `Auto` / `Thinking` / `Fast`; on the wire they travel per message as `feature_config.thinking_mode` (the label verbatim) plus the derived booleans `thinking_enabled` / `auto_thinking`. Per-model supported modes are computed from `abilities.thinking` + `auto_thinking`. No endpoint enumerates them. |
| Does `chat.deepseek.com` expose its model list without a session? | **No.** The list is a remote *setting* (`model_configs`, scope `model`) fetched by `GET /api/v0/client/settings?did=…&scope=model`; anonymous asks return `biz_msg:"SETTINGS_NOT_FOUND"`. The bundle does contain a literal `model_type` set (`default`/`expert`/`vision`) used for deep-link prefill. |
| Does `chat.deepseek.com` expose its modes without a session? | **Partly.** The toggles are plain body keys (`thinking_enabled`, `search_enabled`) plus `model_type`; the *values* of `model_type` are server-driven except the prefill literal set. |
| What makes either site impractical? | **Qwen:** every *write* path (`/api/v2/chat/completions`, `/api/v2/chats/new`) is answered with an anti-bot page for an anonymous caller (Alibaba `tmd`/`x5sec` punish or `aliyun_waf`), and `/` itself intermittently serves the `alicfw` JS challenge; a bare `curl` (no browser UA) gets **405**. **DeepSeek:** the HTML shell is behind an AWS WAF `challenge` (202) on normal routes, and `POST /api/v0/chat/completion` additionally requires a client-computed **proof-of-work** header (challenge + WASM solver in the bundle). Neither is opaque-binary — both are ordinary JSON/SSE once the page's own session is present — but both need a real browser session, and DeepSeek needs its PoW step reproduced. |

---

## 1. `chat.qwen.ai`

### 1.1 App shell and bundle version

| Fact | Evidence |
| --- | --- |
| Shell is a Vite SPA served from `chat.qwen.ai`, scripts on the Alibaba CDN | **measured** + **bundle**: `GET https://chat.qwen.ai/` → 200, 102064 bytes, containing `<script nonce=… type=module crossorigin src=//assets.alicdn.com/g/qwenweb/qwen-chat-fe/0.3.20/js/main.js>` |
| **Bundle version `0.3.20`** | **bundle**: (a) the asset path `…/qwen-chat-fe/0.3.20/js/main.js`; (b) the app sends it as a header — `eX`: `n.set("Version","0.3.20")`; (c) the Sentry bootstrap repeats `release:"0.3.20"` |
| Server API version string | **measured**: `GET https://chat.qwen.ai/api/config` → `{"status":true,"name":"Qwen","version":"0.4.4",…}`; `GET https://chat.qwen.ai/api/version` → `{"version":"0.4.4"}`. Front-end `0.3.20` ≠ backend `0.4.4`; the *client* header is `0.3.20`. |
| Main bundle is one file, ~2.0 MB | **measured**: `main.a…` → `https://assets.alicdn.com/g/qwenweb/qwen-chat-fe/0.3.20/js/main.js` returns `200`, `2 018 069` bytes, `application/javascript` |
| Vendored chunks are separate (`react-vendor-*.js`, `marked-vendor-*.js`, …) | **bundle**: shell `<link rel=modulepreload href=//assets.alicdn.com/g/qwenweb/qwen-chat-fe/0.3.20/js/…>` entries |
| `manifest.js` is **not** published | **measured**: `…/qwen-chat-fe/0.3.20/manifest.js` → `404 NoSuchKey` (OSS) |

### 1.2 API endpoints (method) and their anonymous answer

Base URL is **same-origin** — this is the single most useful line in the bundle:

```js
// bundle: main.js
an = [...hosts...].some(e => location.host === e) ? "prod" : "pre",
rn = We(),                        // We(): hostname → override URL; "" for chat.qwen.ai
on = `${rn}/api/v2`,              // the axios instance baseURL
Ke = `${Ve}/api/v1`,              // the v1 base
{ apiBaseUrl: cn } = ({ apiBaseUrl: `${n}/api/v2/`, migrationBaseUrl: `${n}/api/` })
nn = { prod: { ai: "https://auth.qwen.ai", com: "https://auth.qwen.com" } }
```

So `fX("/chat/completions")` resolves to **`/api/v2/chat/completions`** on the page's own origin, and
every auth/session call goes to **`https://auth.qwen.ai/api/v2/…`** — the host the Qwen Code capture also
used (`https://auth.qwen.ai/api/v2/auths/refresh`, `qwen-code.md` §4.1).

Observed anonymously (browser UA unless noted):

| Request | Anonymous answer (measured) |
| --- | --- |
| `GET /api/config` | `200` `{"status":true,"name":"Qwen","version":"0.4.4","features":{…},"oauth":{"providers":{"google","coder_google","github","coder_github","apple"}}}` |
| `GET /api/models` | `200`, 4636 B, `{"data":[{id,name,object,owned_by,info{…}}…]}` (v1 envelope) |
| `GET /api/v2/models` | `200`, 4712 B, `{"success":true,"request_id":"…","data":{"data":[…]}}` |
| `GET /api/v2/chats` | `200` `{"success":false,"request_id":"…","data":{"code":"Unauthorized","details":"401 Unauthorized"}}` |
| `GET /api/v1/chats/new` | `404` `{"detail":"Not Found"}` (FastAPI-style; v1 has no `chats/new`) |
| `GET /api/v1/auths/`, `GET /api/v1/users/me` | `401` `{"detail":"401 Unauthorized"}` |
| `POST /api/v2/chat/completions` | **anti-bot**, see §1.7 |
| `POST /api/v2/chats/new` | **anti-bot**, see §1.7 |
| `GET /api/v2/chat/completions?chat_id=…` | **anti-bot** (`tmd` punish page) |
| `GET /api/v2/auths` | `307` (redirect; auth lives on `auth.qwen.ai`) |

The bundle's own path table (`Gm`) and call sites (`fX(...)`) give the rest:

```js
// bundle: main.js — the client's own path list
Gm = ["/api/chat/completions","/api/chats/new","/api/chat/completed","/api/v1/chats",
      "/api/v1/auths","/api/task/suggestions/completions","/api/v1/tasks/status",
      "/api/v1/files/getstsToken","/api/task/title/completions","/api/task/tags/completions",
      "/api/parse_url","/api/v2/chats","/api/v2/auths","/api/v2/chat/completions","/api/v2/task",
      "/api/v2/files/getstsToken","/api/v2/community","/api/v2/tts/completions",
      "/api/v2/files/getfilelink","/api/v2/files/parse","/api/v2/files/parse/status",
      "/api/v2/evaluations/feedback"]
```

| Turn-relevant request | Method / path (bundle symbol) |
| --- | --- |
| create chat | `POST /api/v2/chats/new` — `fX("/chats/new",{method:"POST",data:e})`, id read from `data.id` (`createChat`) |
| send turn (stream) | `POST /api/v2/chat/completions?chat_id=<id>` — `UK`: `fX("/chat/completions",{method:"post",responseType:"stream",headers:{"X-Accel-Buffering":"no"},params:{chat_id:e.chat_id},data:e})` |
| reattach / resume a running turn | `GET /api/v2/chat/completions?chat_id=<id>&response_id=<id>` — `QK`: `fX("/chat/completions",{method:"get",responseType:"stream",params:e})`, called by `resumeCompletion({chat_id,response_id})` |
| stop | `POST /api/v2/chat/completions/stop` — `qK`: `fX("/chat/completions/stop",{method:"post",params:{chat_id},headers:{"X-Accel-Buffering":"no"}})` |
| read chat history | `GET /api/v2/chats/` — `nx({chat_id,limit,cursor,direction:"up"})` |
| models | `GET /api/v2/models` — `fX("/models/",{baseURL:`${on}…`})`, then `Ru(models, permittedIds)` filters by permission |
| auth | `POST https://auth.qwen.ai/api/v2/auths/refresh`, `…/auths/signin`, `…/auths/signout` (`fX("/auths/…",{baseURL:`${un}`})`) |

### 1.3 Turn request body (key tree)

The completion body is assembled in `sendPromptOpenAI` (`ChatSender`) and handed to
`completionClient.generateCompletion(be)`:

```js
// bundle: main.js — sendPromptOpenAI
be = {
  stream: V,                       // bool; true for text turns
  version: le,                     // default "2.1"  (c??"2.1")
  incremental_output: oe,          // default true
  chatId: e.chatId,
  parentId: fe ?? "",
  chat_id: e.chatId,
  origin_branch_message_id: ge ? ue : undefined,
  chat_mode: t.chatMode,           // see §1.5 — NOT the thinking mode
  model: re,                       // re = n.id  ← the model id
  parent_id: ge || Z ? null : fe,
  messages: ie,                    // [ ga(te) ]  (current turn) or MCP-loop messages
  timestamp: Math.floor(Date.now()/1e3),
  share_id: Z ? t.shareId : undefined,
  ...ce,                           // multi-model: { turn_id, modelIdx }
  ...(vision ? { size: t.visionSize } : {}),
  ...(usage ? { stream_options: { include_usage: true } } : {}),
  headers: { "X-Request-Id": ae }  // stripped by the client, sent as a header
}
```

Chat creation (**bundle** `createChat` call site):

```js
createChat(ctx, { chatId: "", models: this._models, project_id, timestamp: Date.now(),
                  chat_type: s.chat_type, chat_mode: stateManager.chatMode || "normal" })
```

Message entries carry at least (**bundle** `sendPromptOpenAI` / `feature_config` writes):
`id, parentId, role, content, files, user_action, chat_type, sub_chat_type, parent_id,
feature_config{…}, extra.meta.subChatType, models, model`. `feature_config` is *built* per turn and
then mutated (`thinking_format`, `auto_search`):

```js
// bundle: main.js — the per-turn feature_config builder
c = {
  thinking_enabled: ["Thinking","Auto"].includes(s) && !perms.enableThinking?.disabled && !isSpecialSubType,
  local_mcp: mcpEnabled ? {} : undefined,
  output_schema: "phase",
  research_mode: r,
  auto_thinking: "Auto" === s,
  thinking_mode: s                    // ← the label itself: "Auto" | "Thinking" | "Fast"
}
```

**The exact set the server *accepts* (vs ignores) is unknown without a capture** — see §1.9.

### 1.4 Streaming format and termination

Transport is `fetch` + `responseType:"stream"`, parsed by hand (no `EventSource` anywhere in the
bundle). The frame extractor splits on a blank line and keeps only `data:` lines:

```js
// bundle: main.js — hX(e,t)
const n = e.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n", s = e.split(n);
for (const i of s) { const e = i.split(/\r?\n/).filter(l => l.startsWith("data:"));
  if (e.length) return e.map(f => f.slice(5).trimStart()).join("\n").trim() } return "";
```

and the consumer treats `[DONE]` as terminal, **not** as JSON:

```js
// bundle: main.js — pX() fan-out
if (o && "[DONE]" !== o) { const e = lX(JSON.parse(o)); if (e) return …cX(e) }   // lX = error frame mapper
// bundle: main.js — tH() stream consumer
if (le.startsWith("[DONE]")) { yield {done:true, value:""}; break }
```

Frame types observed in the bundle (`tH`, and classes `wr/_r/Cr/Sr/kr/Tr`):

```text
data: {"response.created":{"chat_id","parent_id","response_id","response_index"}}
data: {"response.stopped":{"response_id"}}
data: {"response.info":{"action","response_id"}}          // action "skip_think" is special-cased
data: {"choices":[{"delta":{"role","content","phase","status","extra","lang_code","function_call","tts","mcp_name","tool_name"}}],"response_id","timestamp","usage"?}
data: {"sources":[…],"choices":[{"delta":{"role"}}],"response_id"}       // web-search citations
data: {"selected_model_id":"…","choices":[{"delta":{"role"}}],"response_id"}  // server re-routes the model
data: {"error":{…},"response_id"}
data: [DONE]
```

**Termination signals (bundle, separately observable):**

| Signal | Where |
| --- | --- |
| `data: [DONE]` | `tH`: `le.startsWith("[DONE]")` → done |
| `response.stopped` | class `kr.canHandle` → `{done:true,isStop:true}` |
| delta `status:"finished"` | status enum `ei = {typing, waiting_input, finished, error, pause}`; UI treats `finished` as terminal |
| stream closes with none of the above | `tH` reader `done` → `{done:true,value:""}` |
| `phase:"KeepAlive"` | class `wr.handle` → ignored (`return null`) |

Phase enum (`Js` / `pt`): `think, tool, answer, DeepThinking, ResearchPlanning, PdfMdGen,
ReportGeneration, KeepAlive, local_tool, image_gen_think, image_gen_websearch, image_gen, image_edit,
image_gen_tool, image_edit_tool, web_search, …, interrupt, InterruptReceived, ResearchNotice, slides,
finished`. Status enum (`ei`): `typing, waiting_input, finished, error, pause`.

> **Adapter-relevant:** the turn can be re-attached with `GET /api/v2/chat/completions?chat_id=…`
> (`resumeCompletion`), which is the same answer the app gives after a reload. That is a *provider
> turn* recovery primitive, not conversation identity.

### 1.5 Mode / effort mechanism — where it goes and what the values are

The three modes the operator sees are **client labels**, resolved per model and then written as
**booleans**; `chat_mode` is a *different* field (value `normal`, or `share` for a shared chat).

```js
// bundle: main.js — supported modes for a model
function mv(e){
  if(!e) return ["Thinking","Fast"];
  const r = !!e.info?.meta?.auto_thinking;
  const o = e.info?.meta?.abilities?.thinking;      // numeric enum
  if(r) return 4===o ? ["Auto","Thinking"] : ["Auto","Thinking","Fast"];
  switch(o){ case 1: case 3: default: return ["Thinking","Fast"];
             case 2: return []; case 4: return ["Thinking"] }
}
// bundle: main.js — default mode for a model
function gv(e){ … if(r) return "Auto"; switch(o){ case 1: default: return "Fast";
  case 2: return; case 3: case 4: return "Thinking" } }
// bundle: main.js — the store that turns the label into the wire flags
setThinkingMode: t => { switch(t){
    case "Auto": case "Thinking": e({thinkingEnabled:!0}); break;
    case "Fast": e({thinkingEnabled:!1}) }
  e({thinkingMode:t}) }
// bundle: main.js — reading a history message back into the label
auto_thinking ? g("Auto") : g(thinking_enabled ? "Thinking" : "Fast")
```

| Layer | Values |
| --- | --- |
| UI / store label | `"Auto"` \| `"Thinking"` \| `"Fast"` |
| Wire, literal (per message) | `feature_config.thinking_mode: "Auto" \| "Thinking" \| "Fast"` — the label is sent **verbatim** (`thinking_mode: s`) |
| Wire, derived booleans (same object) | `feature_config.thinking_enabled = ["Thinking","Auto"].includes(s) && …`; `feature_config.auto_thinking = ("Auto" === s)` |
| Wire, siblings in the same object | `feature_config.output_schema:"phase"`, `feature_config.research_mode: <mode>`, optional `local_mcp`, `mcp`, later `thinking_format`, `auto_search` |
| Model capability that decides availability | `info.meta.auto_thinking: bool` + `info.meta.abilities.thinking: 0..5` |
| `abilities.thinking` enum (`ff`) | `Unavailable=0, Available=1, Hidden=2, ActiveCancellable=3, ActiveUncancellable=4, GuestUnavailable=5` |
| Also written when thinking is on | `feature_config.thinking_format = info.meta.thinking_format` (observed `"summary"`) |
| `chat_mode` (unrelated) | `"normal"` (default), `"share"` |
| Unrelated toggle in the same bag | `feature_config.auto_search: bool` |
| Client persistence | `localStorage["qwen-thinking_mode"]` (`yn`) |

**So: the model id goes in `body.model`; the mode goes in `body.messages[i].feature_config` — as the
literal `thinking_mode` label, mirrored by `thinking_enabled` and `auto_thinking` — not in `chat_mode`
and not in a top-level `thinking` key.** `enable_thinking` / `reasoning_effort` do **not** appear in
this bundle (0 occurrences), and the Qwen Code adapter's `feature_config` shape
(`thinking_enabled` + `output_schema:"phase"`) is a *subset* of the same convention — not a transferable
one, since the envelope and paths differ.

### 1.6 Model-id mechanism — literal list? endpoint? config?

**Endpoint, public.** `GET https://chat.qwen.ai/api/models` (and `/api/v2/models`) answers 200 with no
session. Measured result (2026-10-20): **3** entries —

| `id` (wire) | `name` | `is_visitor_active` | notes from `info.meta` |
| --- | --- | --- | --- |
| `qwen3.7-plus` | Qwen3.7-Plus | `true` | `thinking:true`, `auto_thinking:true`, `thinking_format:"summary"`, `max_context_length:1000000`, `chat_type:[t2t,t2v,t2i,image_edit,search,artifacts,web_dev,deep_research,travel,learn,slides,vqa,translate]`, `modality:[text,image,video]` |
| `qwen3.8-max` | Qwen3.8-Max | `true` | same shape, `max_context_length:1000000` |
| `qwen3.8-omni-flash` | Qwen3.8-Omni-Flash | `false` | `modality:[text,image,video,audio]`, narrower `chat_type` |

Each entry also carries `preset:true`, `object:"model"`, `owned_by:"qwen"`, `action_ids:[]` and a full
`info` (description, `abilities{vision,document,video,audio,mcp,thinking,parse_url}`, `mcp:[…]`,
`think_skip`).

Caveats worth stating plainly:

- The app itself calls `/api/v2/models` and then filters by what the account is permitted
  (`Ru = (models, permittedIds) => models.filter(m => new Set(permittedIds).has(m.id))`).
- Every entry has `is_visitor_active`, and `/api/config` sets `features.enable_anonymous:true` and
  `features.limits.model_display_count:3`. The operator reports a much longer UI menu, so **the
  anonymous 3-model answer is most plausibly the visitor subset**, not the account list. That is not
  proven either way (see §1.9).
- `fX("/models/", …)` (trailing slash) is what the bundle calls; measured, `/api/models/` **falls
  through to the SPA HTML** and only `/api/models` returns JSON. Treat the slash as a routing detail
  to verify against a live page, not a fact.

### 1.7 Anti-bot / blocking observations (measured)

| Call | Result |
| --- | --- |
| `GET /` **with** browser UA | normally 200 with the app shell (102064 B) — but **once** in this session it answered 200 with the `alicfw` challenge page instead (8234 B, `<body onload="check()">`, hidden `parm_0`/`parm_1`, obfuscated `hash32`, sets `acw_tc`/`aliyungf_tc`). The challenge is intermittent, not a permanent block. |
| `GET /` **without** UA | **405** (`2657 B` HTML error page) — same class of finding as `qwen-code.md` §1.1: the 405 is a UA filter, not headless detection |
| `POST /api/v2/chat/completions` (anonymous, plausible body + headers) | 200 `text/html` → the Alibaba **TMD/x5sec** page: `sessionStorage.x5referer …; location.replace("…/_____tmd_____/punish?x5secdata=…")`. With a JSON-accepting client it answered `{"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::…"],"data":{"url":"…/punish?…&action=captchaconnect&pureCaptcha=","dialogSize":{…}}}` (569 B) |
| `POST /api/v2/chats/new` (anonymous) | 200 `text/html` → **`aliyun_waf`** block page (`<meta name="aliyun_waf_aa" …>`, `<meta name="aliyun_waf_bb" …>`) |
| `GET /api/v2/chat/completions?chat_id=…` (anonymous) | TMD punish page (same as POST) |
| `GET /api/v2/models`, `GET /api/v2/chats`, `GET /api/config` | **no anti-bot** — plain JSON |

Read surface is open; **write surface is gated**. The bundle carries the vendor's own anti-bot SDK hooks
(`window.__baxia__.getFYModule().getUidToken()`, `window.baxiaCommon.baxiaPromptInit`,
`window.location.replace` on `vite:preloadError`), i.e. the page expects to produce a baxia uid token —
exactly the situation the Qwen Code adapter already solved by issuing the request *from inside the page*
(`src/adapters/page-context-request.ts`).

### 1.8 Auth surface — names only

| Kind | Names observed (no values) | Source |
| --- | --- | --- |
| Request headers (set by interceptor `eX`) | `Accept`, `Content-Type`, `Version: 0.3.20`, `source: h5\|web\|desktop`, `Authorization: Bearer <token>`, `X-Request-Id`, `Timezone`, `Accept-Language`, `X-Accel-Buffering: no` (stream calls) | bundle `eX`, `fX`, `UK`, `QK` |
| Guest identity | `x-umid` (**set instead of** `Authorization` when there is no token; the global `fetch` wrapper does `s.delete("Authorization"); s.set("x-umid", _b())`) | bundle, global fetch wrapper |
| Server → client | `x-request-id` (echoed), `x-actual-status-code` (checked for `401` even on HTTP 200) | bundle `pX`, refresh wrapper |
| Query params on one external (greenNet/OSS) call | `biz_id:"ai_qwen"`, `chat_client:"h5"`, `device:"pc"`, `fr:"pc"`, `pr:"qwen-i18n"`, `la`, `tz` | bundle |
| Token store | `localStorage["qwen_access_token_state"]` (same key the Qwen Code adapter reads) + legacy bare `token`; app-internal `YY.getAccessToken()`, `ensureValidToken()`, `recoverAccessToken()` | bundle |
| Other localStorage keys | `qwen-thinking_mode`, `qwen-sidebar_visible`, `locale` | bundle |
| Auth host / refresh | `https://auth.qwen.ai/api/v2/auths/refresh` (`a = !!i && … !["/auths/refresh"].includes(t)` — the refresh call deliberately does **not** carry the bearer) | bundle |
| OAuth providers (shared login) | `google`, `coder_google`, `github`, `coder_github`, `apple` — **measured** in `/api/config`; the bundle also carries the literal `https://coder.qwen.ai` | measured + bundle |

The `coder_google` / `coder_github` entries are the concrete evidence for "shares the login with
`coder.qwen.ai`": the same auth host and the same OAuth client family, selected by product suffix.

### 1.9 What is unknown, and the one cheapest observation

| Unknown | Cheapest settling observation |
| --- | --- |
| Whether the anonymous `/api/models` 3-model list is the visitor subset or the whole catalogue | Repeat `GET /api/v2/models` once with a signed-in cookie jar and diff the id set |
| Whether `/api/v2/chat/completions` still shows the TMD/`x5sec` punish for a *session-bearing* same-origin request (or only for cookie-less ones) | One signed-in HAR/DOM capture of a single turn; compare `sec-fetch-*`, `x5secdata`, and whether `baxia` uid token headers appear |
| The **exact** `messages[]` key set the server accepts (the app sends whole history objects) | One recorded request body from a signed-in page (HAR), not a guessed body |
| Whether `version:"2.1"` is required, and what a mismatch does | Send `version:"2.1"` vs the bundle default in one signed-in turn and compare |
| Which `chat_type`/`sub_chat_type` a plain text turn must use (`t2t` observed in enums, not proven on the wire for text-only) | Same capture, read `messages[0].chat_type` and `…sub_chat_type` |
| Whether `source: web` (vs `h5`) is accepted for a text turn | Same capture; read the `source` header the page sent |
| Whether `model_display_count:3` caps the menu or only the "quick pick" strip | Signed-in `/api/config` + `/api/v2/models`, compare to the rendered menu |

---

## 2. `chat.deepseek.com`

### 2.1 App shell and bundle version

| Fact | Evidence |
| --- | --- |
| Normal routes are behind an **AWS WAF** interstitial | **measured**: `GET /`, `/sign_in`, `/robots.txt` → **202**, `x-amzn-waf-action: challenge`, empty body (`server: CloudFront`) |
| The SPA HTML **is** fetchable on static-ish paths | **measured**: `GET /manifest.json` → 200, 8547 B, full `<!doctype html>` app shell; `GET /favicon.ico` → same 8547 B. (Any path the WAF classifies as static serves the app.) |
| **Bundle version** | **measured**: `<meta name="commit-id" content="6c40ca01">` in the shell — DeepSeek pins a commit id, not a semver |
| Bundles | **measured**: `https://fe-static.deepseek.com/chat/static/main.a34f79a498.js` (1 592 032 B) and `…/default-vendors.3473f64207.js` (1 031 463 B), both `200` |
| `…/chat/manifest.js` | **measured**: `403` (exists but not public) |
| Shell injects geo | `<meta name="ip" …>`, `<meta name="region" content="ES">` (server-side, per request) |

### 2.2 API endpoints (method) and their anonymous answer

All under `/api/v0/`. The bundle names 46 paths; the turn-relevant ones:

| Request | Method | Anonymous answer (measured) |
| --- | --- | --- |
| `/api/v0/chat/completion` | POST | 200 `{"code":40003,"msg":"INVALID_TOKEN","data":null}` |
| `/api/v0/chat/create_pow_challenge` | POST | 200 `{"code":40002,"msg":"Missing Token","data":null}` (GET → `405 {"detail":"Method Not Allowed"}`) |
| `/api/v0/chat_session/create` | POST | 200 `{"code":40003,"msg":"INVALID_TOKEN","data":null}` |
| `/api/v0/chat_session/fetch_page` | GET | 200 `{"code":40003,"msg":"INVALID_TOKEN","data":null}` |
| `/api/v0/users/current` | GET | 200 `{"code":40002,"msg":"Missing Token","data":null}` |
| `/api/v0/client/settings?did=…&scope=model` | GET | 200 `{"code":0,"msg":"","data":{"biz_code":1,"biz_msg":"SETTINGS_NOT_FOUND"}}`; without `did` → `biz_code:2 INVALID_PARAM` |

Full path list read from the bundle (`grep` for `` `/api/v0/…` `` literals):

```text
auth/ticket
chat/completion            chat/continue            chat/regenerate         chat/edit_message
chat/history_messages      chat/resume_stream       chat/stop_stream        chat/message_feedback
chat/create_pow_challenge  chat/tts/…               chat/tts/voices
chat_session/create        chat_session/fetch_page  chat_session/delete     chat_session/delete_all
chat_session/update_title  chat_session/batch_update_pinned
client/settings            client/settings/report   client/span             client/wechat_js_sdk_signature
file/upload_file           file/fetch_files         file/fork_file_task
index/prepare              index/query
share/content|create|delete|fork|list
telemetry                  export_all               download_export_history
users  users/settings  users/update_settings  users/logout_all_sessions  users/get_birthday
users/set_birthday  users/create_email_verification_code  users/create_sms_verification_code
users/create_guest_challenge
```

**Envelope is not Qwen's.** DeepSeek answers `{"code":<int>,"msg":"…","data":…}` and *also* nests a
business status inside success: `{"code":0,"data":{"biz_code":1,"biz_msg":"SETTINGS_NOT_FOUND",…}}`.
So there are two layers to check before believing a call succeeded — `code === 0` **and**
`data.biz_code === 0`.

### 2.3 Turn request body (key tree)

The body is built per request type in one place (**bundle**, `i.http({json: …})`):

```js
// completion
{ chat_session_id, parent_message_id, model_type, prompt, ref_file_ids,
  thinking_enabled, search_enabled, source, action, preempt }

// regenerate
{ chat_session_id, child_message_id, search_enabled, thinking_enabled, user_options }

// continue
{ chat_session_id, message_id, fallback_to_resume }

// edit_message
{ chat_session_id, message_id, ref_file_ids, prompt, search_enabled, thinking_enabled, action }
```

Notes that matter for an adapter:

- **`model_type`** is where the model goes (not `model`, not `model_id`).
- **`thinking_enabled`** and **`search_enabled`** are the toggles — plain booleans, top level.
- `parent_message_id` is `null` for the first turn (`cH.o(parentMessageId) ? null : parentMessageId`).
- `prompt` is the raw user text; `ref_file_ids` is the attachment list (empty array for a text turn).
- `source` is free-form (`action`, `preempt` are nullable extras).

### 2.4 Streaming format and termination

**Named SSE events**, not `data:`-only frames. The bundle's server-event switch is the spec:

```js
// bundle: main.js — onServerEvent(e)
switch (e.event) {
  case "delta":  this.deltaParser.parse(e.data).forEach(…)         // JSON patch frames
  case "ready":  {response_message_id, request_message_id, model_type}
  case "close":  {click_behavior}                                   // "retry" | "none"
  case "finish": {…}                                               // terminal
  case "title":  {…}
  case "toast":  {type, content, finish_reason}
  case "update_session":    {updated_at}
  case "hint":              {content, type, clear_response, finish_reason}
  case "update_parent_message": {chat_message}
  case "update_file":       {…}
}
// and: if (!e.event && e.data) → treated as an unnamed "delta"
```

The `delta` payload is a **JSON patch**, validated by an explicit schema:

```js
// bundle: main.js — delta/close schemas
So = Ikc({ p: lqM(YjP()),                                  // path, e.g. "response/fragments/0/content"
           o: lqM(KCZ([euz("SET"), euz("BATCH"), euz("APPEND")])),
           v: bzn() })                                      // value
Sd = Ikc({ click_behavior: lqM(KCZ([euz("retry"), euz("none")])) })
// and the applier:
switch (o) { case "SET": d.set(t,l,i); break; case "APPEND": d.append(t,l,i); break; default: … }
```

Message content therefore arrives as patches against `response.fragments[i].content`; fragment `type`
values seen in the bundle include `RESPONSE`, `TEMPLATE_RESPONSE`, and the collapsible/search families
(`nA.Nr._COLLAPSIBLE_TYPES`, `nA.Nr.RESPONSE_TYPES`). Text extraction for an adapter = follow
`APPEND`/`SET` patches on fragments whose `type === "RESPONSE"` (bundle evidence; not yet validated on
the wire).

**Termination:** there is **no `[DONE]` sentinel anywhere in the bundle** (0 occurrences). The turn ends
on the `finish` event, or on the `close` event (`click_behavior:"retry"|"none"`), or when the stream
closes. A heartbeat watchdog exists: header `x-ds-sse-heartbeat-timeout-secs` plus
`maxPingInterval`/`readyTimeout` handlers, so silence is *not* a termination signal.

### 2.5 Mode / effort mechanism and model-id mechanism

| Mechanism | Wire | Values | Evidence |
| --- | --- | --- | --- |
| Thinking | `thinking_enabled: bool` | `true`/`false` | bundle body literal; also a persisted storage handle (`storageHandles.thinkingEnabledStorageHandle`) |
| Web search | `search_enabled: bool` | `true`/`false` | bundle body literal |
| Model | `model_type: string` | **server-driven** from `model_configs`; a literal prefill set `["default","expert","vision"]` exists | bundle `d=()=>l.getLatestFeature("model_configs",null)`, `u=e=>c().find(t=>t.model_type===e)`, and the deep-link parser `e8=["default","expert","vision"]` |
| Model switching | `switchModel(t) { … modelType: t }`, default via `resolveDefault(getUserSettings())` | n/a | bundle |
| `ready` echoes the *actual* model | `model_type` in the `ready` event | — | bundle `onServerEvent` |

**Model list is session-only.** It arrives as a *remote setting* with scope `model`:

```js
// bundle: main.js — settings fetch
let c = { did: n }; if (scope) c.scope = scope;
GET /api/v0/client/settings?did=<device id>[&scope=model]
  → {code:0, data:{biz_code, biz_msg, biz_data:{entries, version}}}     // version from `x-fetch-after-sec`
// and the model scope is read through
let l = new FeatureStore(…, { cache:{readOnInit:!0, writeOnUpdate:!0}, reportScope:"model" })
d = () => l.getLatestFeature("model_configs", null) ?? []
h = () => d().filter(e => e.enabled && e.switchable).map(e => e.model_type)
```

Anonymous, that endpoint answers `biz_msg:"SETTINGS_NOT_FOUND"` (measured), so **no public model list
exists**. The bundle caches it in `localStorage` under `__ds_remote_feature_store_model` /
`__ds_remote_feature_store` — useful to know, still not public.

### 2.6 Anti-bot / blocking observations (measured + bundle)

| Layer | Evidence |
| --- | --- |
| AWS WAF on navigation | **measured**: `202` + `x-amzn-waf-action: challenge` on `/`, `/sign_in`, `/robots.txt`; `405` + `x-amzn-waf-action: captcha` is the captcha variant |
| The app treats WAF as a first-class state | **bundle** `pw(status, headers)`: `405 && x-amzn-waf-action==="captcha" → "captcha"`; `202 && x-amzn-waf-action==="challenge" → "awsChallenge"`; the hooks then emit `R("captcha"?"awsCaptcha":"awsChallenge")` |
| WAF cookies the page carries | **bundle**: `ds_aws_captcha`, `ds_mfa_aws_captcha` (also `ds_cookie_preference`, `__Secure-ds_faq_uid`) |
| **Proof of work on completion** | **measured** endpoint + **bundle** flow: `POST /api/v0/chat/create_pow_challenge {target_path:"/api/v0/chat/completion"}` → `biz_data.challenge{challenge, difficulty, salt?, signature?, expire_at, expire_after}`; solved by a **WASM** module ("r1Pow", `difficulty`, `wasm`); refusal codes `POW_HEADER_ERROR` and `INVALID_POW_RESPONSE` → user-visible `"invalidPowResponseToast"` |
| UA sensitivity | **none observed**: without a UA, `/manifest.json` (200) and `/api/v0/client/settings` (200) behave identically. The block here is WAF/PoW, not UA. |

**Practical consequence:** a turn requires (1) a session (cookies), (2) a valid `did`/device identity,
(3) one PoW per completion target — the challenge is fetched and solved *by the page*. Relaying the
request from inside the page (the existing `page-context-request` seam) solves (1)–(3) at once; calling
the API from Node would require reimplementing the WASM PoW and the WAF challenge, which is a much
larger and more brittle commitment.

### 2.7 Auth surface — names only

| Kind | Names observed (no values) | Source |
| --- | --- | --- |
| Request headers | `Authorization: Bearer <token>` (token manager `b.getToken()` → `{token, source}`), `x-client-bundle-id`, `x-client-platform`, `x-client-version`, `x-client-locale`, `x-client-timezone-offset` | bundle `a=({brand,platform,version,locale,timezoneOffsetSeconds})=>({…})`, `onBeforeRequest` |
| Trace / SSE | `x-ds-trace-id`, `x-ds-sse-heartbeat-timeout-secs`, `x-ds-compression`, `x-request-encryption-key`, `x-device-id` | bundle (telemetry + SSE client) |
| Response headers read | `x-ds-trace-id`, `x-fetch-after-sec` (settings cache TTL), `x-actual-status-code`-style checks via `code` | bundle |
| Cookies | `ds_aws_captcha`, `ds_mfa_aws_captcha`, `ds_cookie_preference`, `__Secure-ds_faq_uid` | bundle |
| Browser storage keys | `__ds_remote_feature_store`, `__ds_remote_feature_store_model`, `__ds_remote_feature_did`, `__ds_report_settlers`, `__session_page_size__` | bundle |
| Login-related | `deepseek-auth-mfa`, `create_guest_challenge`, `users/*` | bundle |
| Device identity | `did` (query param on `client/settings`; also `x-device-id`/`x-device-model` pair from the device module) | bundle |

No token value, cookie value or device id is reproduced here.

### 2.8 What is unknown, and the one cheapest observation

> **Post-capture status (2026-10-24).** A real signed-in HAR of `chat.deepseek.com` has since settled
> most of this table: the proof header (`x-ds-pow-response`), the page-owned solver contract, the real
> `model_type` values (`default`/`expert`/`vision`), the body extras (`action:null`, `preempt:false`,
> no `source`), the session-create shape, the `THINK`/`RESPONSE` fragments, `close` as the terminator,
> relative `BATCH`, and the page's bearer/client identity. The current measured inventory — and the
> three observations that remain — is [`deepseek-web.md`](./deepseek-web.md) §6. The table below is
> kept as the pre-capture record of what was unknown and why.

| Unknown | Cheapest settling observation |
| --- | --- |
| The actual `model_type` values and the full `model_configs` shape | One signed-in `GET /api/v0/client/settings?did=…&scope=model`; the JSON is `biz_data.entries` |
| Whether `model_type:"default"|"expert"|"vision"` is still accepted (they are the deep-link prefill set, not proven API values) | Same response above — compare `entries[].model_type` with the literal set |
| The PoW response **header name** and encoding (the bundle computes it but the name is not a plain literal in `main.js`) | One signed-in HAR of a completion: read the extra request header whose value changes per turn |
| The `did` provenance/format the server accepts (`SETTINGS_NOT_FOUND` even for a well-formed UUID) | Same HAR: read `did` from the settings request and compare to `__ds_remote_feature_did` |
| Whether a text turn needs `preempt`/`action`/`source` at all | Same HAR of a plain first turn: the body is small enough to copy verbatim |
| Exact `fragments[].type` set emitted for a plain answer | Same HAR/stream: record the first `delta` frames' `p` paths |
| Whether `finish` or `close` is the reliable end-of-turn for a text answer | Same HAR: note which event precedes the stream close |

---

## 3. Cross-site comparison for the adapter

| Dimension | `qwen-code` (existing, for reference) | `chat.qwen.ai` | `chat.deepseek.com` |
| --- | --- | --- | --- |
| API family | `/coder/api/v2/task/*` | `/api/v2/chat*` (same origin) | `/api/v0/chat*` (same origin) |
| Client version header | `version: 0.0.29`, `source: web`, `bx-v` | `Version: 0.3.20`, `source: h5|web|desktop` | `x-client-version` (+ commit `6c40ca01`) |
| Envelope | `{success, request_id, data}` | same convention (`success`/`request_id`/`data`; `success:false` + `Unauthorized` at 200) | `{code, msg, data}` + nested `data.biz_code` |
| Turn body | `models[]`, `chat_mode`, `model`, `messages[]`, `stream`, `incremental_output` | `chat_id`/`chatId`, `parent_id`/`parentId`, `model`, `chat_mode`, `messages[]`, `stream`, `version:"2.1"`, `incremental_output` | `chat_session_id`, `parent_message_id`, `model_type`, `prompt`, `thinking_enabled`, `search_enabled` |
| Model id location | `models:[id]` + `model:id` | `model:<id>` (from `/api/v2/models[].id`) | `model_type:<value>` (server-driven) |
| Mode location | `feature_config.thinking_enabled` | `messages[].feature_config.thinking_mode` (+ `thinking_enabled`, `auto_thinking`) | top-level `thinking_enabled` |
| Stream | `data:` frames, three termination signals | `data:` frames + `[DONE]`, `response.stopped`, `status:"finished"` | **named events** + JSON patches `{p,o,v}`, `finish`/`close` |
| Model list | not public | **public** (`/api/models`, `/api/v2/models`) | session-only (`scope=model` setting) |
| Extra gate | none measured | TMD `x5sec` / `aliyun_waf` on write paths; UA filter on `/` | AWS WAF challenge + **PoW** per completion |

### 3.1 Plain answers

1. **`chat.qwen.ai` is a different API from `coder.qwen.ai`** — different path prefix, different turn
   body, different stream frame set, different client version header. The *conventions* (envelope,
   `auth.qwen.ai` token refresh, `feature_config`, `chat_mode`, `incremental_output`, `messages[]`) are
   shared, so a small amount of Qwen Code knowledge transfers, but no endpoint or body key does.
2. **`chat.qwen.ai` publishes its model list without a session; it publishes its modes only as bundle
   knowledge** (client labels → two booleans). An adapter can hard-code the mode mapping from this
   document, and *can* discover model ids at runtime from `/api/v2/models` — though the anonymous list
   may be the visitor subset.
3. **`chat.deepseek.com` publishes neither** without a session: model list = `scope=model` setting;
   modes = two booleans whose *availability* is server-driven, with only a literal prefill set in the
   bundle.
4. **Neither site is blocked in a way that forbids the approach the repo already uses.** Both are
   ordinary JSON/SSE behind a browser-facing anti-bot layer; the Qwen Code lesson ("issue the request
   from inside the provider's page") covers Qwen's baxia/x5sec and DeepSeek's WAF + PoW. What *would*
   be impractical is a Node-only HTTP client: Qwen needs a browser UA plus the page's x5sec/baxia
   tokens, DeepSeek needs WAF clearance plus a WASM PoW.

---

## 4. How this was measured (so the next person repeats it)

Environment: Linux, `curl` plus `node -e` for slicing the bundles. Nothing was installed; no browser
was driven; no credentials existed. Downloads go to a scratch directory that is **not** committed.

1. **Get the shell.**

   ```bash
   UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
   curl -sS -A "$UA" -o qwen-shell.html https://chat.qwen.ai/            # or /version
   curl -sS -A "$UA" -o ds-shell.html   https://chat.deepseek.com/manifest.json   # / is WAF-202
   ```

   Two lessons worth keeping:
   - `chat.qwen.ai/` intermittently answers with the `alicfw` JS challenge (8 KB, `<body onload="check()">`).
     Retry; also `/version` serves the real SPA shell. **Do not** conclude the site is unreachable, and do
     not try to solve the challenge — the bundle is public on the CDN.
   - `chat.deepseek.com/` is WAF-202, but `/manifest.json` and `/favicon.ico` return the *same* SPA shell
     (8 547 B). That is how the shell and its `<meta name="commit-id">` were obtained.

2. **Find the JS entry.** In the shell, grep the script tags — both apps emit unquoted attributes, so
   `grep -oE '<script[^>]*>'` works better than an `src="…"` regex:

   ```bash
   grep -oE '<script[^>]*>' qwen-shell.html     # → //assets.alicdn.com/g/qwenweb/qwen-chat-fe/0.3.20/js/main.js
   grep -oE '[a-zA-Z0-9_./-]+\.js' ds-shell.html # → https://fe-static.deepseek.com/chat/static/main.a34f79a498.js
   ```

3. **Fetch the bundle from the vendor CDN, not the app** (this is the Qwen Code precedent and it is
   still the cheapest route: no cookies, no anti-bot, exact bytes the client runs):

   ```bash
   curl -sS -o qwen-main.js 'https://assets.alicdn.com/g/qwenweb/qwen-chat-fe/0.3.20/js/main.js'
   curl -sS -o ds-main.js   'https://fe-static.deepseek.com/chat/static/main.a34f79a498.js'
   ```

4. **Grep the API surface, then *read* the symbols.** Counts first (cheap), then exact contexts with
   `node` (`String.indexOf` + `slice`) — **never** a greedy regex like `.{0,200}foo.{0,200}` on a 2 MB
   single-line file: it is catastrophic and it hung this session once.

   ```bash
   node -e 'const s=require("fs").readFileSync("qwen-main.js","utf8");
            for (const p of ["/api/","completions","[DONE]","feature_config","thinking_enabled"])
              console.log(p, s.split(p).length-1)'
   node -e 'const s=…; const i=s.indexOf("feature_config"); console.log(s.slice(i-800,i+800))'
   ```

   The anchors that paid off, in order: the path literal table (`Gm`), the axios interceptor (`eX`) for
   headers, the sender (`sendPromptOpenAI`) for the body, the stream consumer (`tH`) for frames, and the
   feature store (`setThinkingMode`, `mv`, `gv`) for modes.

5. **Cross-check the version the app reports.** Qwen: the CDN path segment, the `Version` header
   literal, and the Sentry `release` must all agree (`0.3.20`). DeepSeek: `<meta name="commit-id">` in
   the shell plus the bundle filename hash. A bundle without a version pin is a bundle you cannot date.

6. **Probe endpoints anonymously, but read the body, not the status.** Both vendors answer HTTP 200 for
   refusals. Useful one-liners:

   ```bash
   for p in /api/v2/models /api/v2/chats /api/config; do curl -sS -A "$UA" "https://chat.qwen.ai$p" | head -c 200; echo; done
   for p in /api/v0/chat_session/fetch_page /api/v0/client/settings?did=x; do curl -sS "https://chat.deepseek.com$p" | head -c 200; echo; done
   ```

7. **Record the anti-bot behaviour explicitly** (it is the thing that decides feasibility, and it is
   easy to mistake for "provider down"): Qwen `/` without a UA → `405`; Qwen write paths → `aliyun_waf`
   HTML or `tmd`/`x5sec` punish JSON/redirect; DeepSeek `/` → `202` + `x-amzn-waf-action: challenge`;
   DeepSeek completion → PoW challenge.

8. **Stop at the session boundary.** Everything above needs no account. The moment an observation needs
   a signed-in page (exact accepted body, PoW header name, full model menu), it is written down as an
   unknown with the observation that settles it — not guessed, and not worked around.

### 4.1 What this document does not claim

- It does not claim either protocol is *stable*: both are dated to the bundle that was read.
- It does not claim any of the unauthenticated read endpoints are usable as-is for a turn.
- It does not claim the anonymous `/api/models` answer equals the account's menu.
- It does not claim the Qwen/DeepSeek adapters are feasible — only what the wire looks like and what
  gates it.
