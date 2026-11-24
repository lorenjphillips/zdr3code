<p align="center">
  <img src="./.github/readme/zdr3-code.svg" width="88" height="88" alt="ZDR3 Code logo" />
</p>

<h1 align="center">ZDR3 Code</h1>

<p align="center">T3 Code with the telemetry deleted.</p>

<p align="center">
  <sub>An unofficial fork based on the <a href="https://github.com/pingdotgg/t3code">T3 Code</a> source code.<br />Not affiliated with, endorsed by, or maintained by T3 Tools, Inc.</sub>
</p>

ZDR stands for zero data retention. This build keeps your threads, settings and identifiers on your machine and sends none of them to the app's maker. The telemetry code is deleted, not switched off, so there is no setting, environment variable or build flag that brings it back.

Based on upstream [`11c63a9`][base] (2026-11-24). Everything this fork changes is in [one diff][compare]: outside this README, about 10,200 lines removed and 480 added.

## What T3 Code sends

The three that matter most, with the upstream source for each.

| #   | What                                          | Where it goes                   | On by default   |
| --- | --------------------------------------------- | ------------------------------- | --------------- |
| 1   | Usage events for every boot, turn and feature | `ingest.t3.codes`, then PostHog | Yes             |
| 2   | Hashes of your OpenAI and Claude account IDs  | Sent with those events          | Yes             |
| 3   | Connection traces and mobile crash reports    | Axiom                           | Official builds |

**1. Usage events.** The server posts a batch to `https://ingest.t3.codes/batch/` every 10 seconds ([`AnalyticsService.ts` L67-L74][analytics-config], [L231-L236][analytics-post]). It sends a heartbeat on every start with your thread and project counts, then one event per turn with the provider, the model ID (custom model names included), token counts and duration ([`ProviderUsageAnalytics.ts` L174-L205][turn-props]), plus the features you use, MCP tool calls and sign-in flows.

**2. Account hashes.** The server reads `~/.codex/auth.json` and `~/.claude.json` ([`Identify.ts` L253-L271][identify-read]) and attaches SHA-256 hashes of your Codex account ID, OpenAI user ID and Claude account UUID to those events ([L279-L295][identify-distinct], [L307-L339][identify-owners]). The hash has no salt ([`telemetryId.ts` L8-L9][hash]), so anyone who holds the raw ID can match it. The files are read at startup whether or not telemetry is enabled ([`AnalyticsService.ts` L149][identify-always]).

**3. Traces and crash reports.** Official builds export "relay client" traces to Axiom from the server, the desktop and web UI, and the phone app ([`relayTracing.ts` L159-L177][relay-exporter]; the endpoint and token are injected at release, [`release.yml` L445-L463][relay-release]). The browser and phone senders have no off switch ([`telemetry.md` L82-L84][doc-browser], [L96-L98][doc-mobile]). The phone app also sends crash reports and startup timings with an install ID unless you turn them off ([`observe.ts`][observe]).

### Measured

Both servers were started on a fresh home directory with test credential files in place, left alone for 30 seconds, and every outbound connection was logged and blocked.

| Build              | Connection attempts                                              |
| ------------------ | ---------------------------------------------------------------- |
| Upstream `11c63a9` | 3 to `ingest.t3.codes:443`, 1 to `raw.githubusercontent.com:443` |
| ZDR3 Code          | 1 to `raw.githubusercontent.com:443`                             |

The upstream build's first batch held `server.boot.heartbeat` and two `install.owner_observed` events. Their `ownerId` values were exactly the SHA-256 of the OpenAI user ID and the Claude account UUID in the test files, and `distinct_id` was the SHA-256 of the Codex account ID. The one request ZDR3 Code makes is a plain download of the public model list ([what is left](#what-is-left)).

## What this fork removes

Each line is one removal and what it prevents. Open a row for the exact code.

| Removed                                                     | So that                                                                                   |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| The analytics client and every event call site              | Nothing is sent to `ingest.t3.codes` or PostHog                                           |
| The identity reader                                         | `~/.codex/auth.json` and `~/.claude.json` are not read to fingerprint you; no install ID  |
| Client identity on the connection URL                       | The app no longer sends account and device hashes, browser, OS or phone model to a server |
| The relay trace exporter, its wrappers and its build config | No traces go to Axiom from the server, desktop, web or phone                              |
| `expo-observe` and the phone trace exporter                 | The phone app sends no crash reports, startup timings or traces                           |
| Over-the-air updates from upstream's Expo project           | A phone build of this source is not replaced by an upstream bundle                        |
| The agent feedback sender and the `t3 feedback` command     | An agent cannot send a report to the T3 team                                              |
| The Google favicon lookup                                   | Hostnames of links in your threads are not sent to `google.com`                           |
| `T3CODE_TELEMETRY_ENABLED` and its plumbing                 | There is nothing left to opt out of                                                       |

One thing is added rather than removed. Builds report a `-zdr3` version, and release lookups point at this repository, so an update or a background-service install cannot quietly fetch an upstream build.

<details>
<summary><b>Analytics client</b>: <code>apps/server/src/telemetry/</code> deleted (11 files)</summary>

```diff
- const TelemetryEnvConfig = Config.all({
-   posthogKey: Config.String("T3CODE_POSTHOG_KEY").pipe(
-     Config.withDefault("phc_XOWci4oZP4VvLiEyrFqkFjP4CZn55mjYYBMREK5Wd6m"),
-   ),
-   posthogHost: Config.String("T3CODE_POSTHOG_HOST").pipe(
-     Config.withDefault("https://ingest.t3.codes"),
-   ),
-   enabled: Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault(true)),
```

```diff
-     yield* HttpClientRequest.post(`${telemetryConfig.posthogHost}/batch/`).pipe(
-       HttpClientRequest.bodyJson(payload),
-       Effect.flatMap(httpClient.execute),
```

The heartbeat in `apps/server/src/serverRuntimeStartup.ts`:

```diff
-   yield* analytics.record("server.boot.heartbeat", {
-     threadCount,
-     projectCount,
-   });
-   yield* analytics.recordOwners(yield* getServerOwners, "server");
```

Call sites removed with it: `ws.ts`, `server.ts`, `mcp/McpHttpServer.ts`, `guest/GuestShareService.ts`, `provider/CodexChatGptAuth.ts`, and `orchestration-v2/{RunExecutionService,ProviderEventIngestor,ProviderTurnStartService}.ts`.

</details>

<details>
<summary><b>Identity reader</b>: <code>apps/server/src/telemetry/Identify.ts</code> deleted</summary>

```diff
-   const codexTokens = yield* readJsonIdentityFile(
-     "codex",
-     path.join(homeDirectory, ".codex", "auth.json"),
-     decodeCodexAuthJson,
-   ).pipe(
-     skipOnError,
-     Effect.map(Option.flatMap((authJson) => Option.fromUndefinedOr(authJson.tokens))),
-   );
-   const claudeJson = yield* readJsonIdentityFile(
-     "claude",
-     path.join(homeDirectory, ".claude.json"),
-     decodeClaudeJson,
-   ).pipe(skipOnError);
```

```diff
-   return {
-     distinctId: Option.isSome(providerId) ? hashTelemetryId(providerId.value) : installId,
-     installId,
-   };
```

`packages/shared/src/telemetryId.ts`, deleted:

```diff
- export const hashTelemetryId = (value: string): string =>
-   Hex.encode(sha256(new TextEncoder().encode(value)));
```

`apps/server/src/config.ts`:

```diff
-     anonymousIdPath: join(stateDir, "anonymous-id"),
```

</details>

<details>
<summary><b>Client identity</b>: <code>packages/client-runtime/src/authorization/remote.ts</code></summary>

```diff
- export const readClientOwnerParams = Effect.gen(function* () {
-   const session = yield* Effect.serviceOption(ClientCapabilities.CloudSession);
-   const account = Option.isSome(session) ? yield* session.value.identity : Option.none();
-   const device = yield* (yield* ClientCapabilities.AnalyticsDevice).id;
-   return {
-     ...(Option.isSome(account) ? { connect: hashTelemetryId(account.value.accountId) } : {}),
-     ...(Option.isSome(device) ? { device: hashTelemetryId(device.value) } : {}),
-   } satisfies ClientOwnerParams;
- });
```

```diff
-   if (clientMetadata?.surface === "mobile") {
-     if (clientMetadata.osMajorVersion !== undefined) {
-       url.searchParams.set("clientOsMajorVersion", String(clientMetadata.osMajorVersion));
-     }
-     if (clientMetadata.deviceModel) {
-       url.searchParams.set("clientDeviceModel", clientMetadata.deviceModel);
-     }
-   }
-   if (connectionMethod) {
-     url.searchParams.set("connectionMethod", connectionMethod);
-   }
-   if (owners?.connect) {
-     url.searchParams.set("clientOwner", owners.connect);
-   }
-   if (owners?.device) {
-     url.searchParams.set("clientDevice", owners.device);
-   }
```

`apps/web/src/connection/platform.ts`:

```diff
- const ANALYTICS_DEVICE_ID_KEY = "t3code:analytics-device-id";
```

The readers in `apps/server/src/ws.ts` (`readClientAnalyticsProps`, `readClientOwners`) are deleted too.

</details>

<details>
<summary><b>Relay traces</b>: <code>packages/shared/src/relayTracing.ts</code> deleted</summary>

```diff
-   const layerTracer = OtlpTracer.layer({
-     url: config.tracesUrl,
-     headers: {
-       Authorization: `Bearer ${config.tracesToken}`,
-       "X-Axiom-Dataset": config.tracesDataset,
-     },
```

Removed with it: every `withRelayClientTracing` wrapper across the server and client runtime, `apps/server/src/cloud/relayTracing.ts`, `traceRelayRequest.ts`, the `T3CODE_RELAY_CLIENT_OTLP_TRACES_*` build defines, `isRelayTracingEnabled`, and the desktop `getRelayTelemetryEnabled` bridge call.

</details>

<details>
<summary><b>Phone app</b>: <code>apps/mobile</code></summary>

`package.json`:

```diff
-     "expo-observe": "~58.0.18",
```

`app.config.ts`:

```diff
- const observeEndpointUrl = repoEnv.T3CODE_RELAY_URL?.trim()
-   ? new URL("/v1/mobile/observe", repoEnv.T3CODE_RELAY_URL.trim()).toString()
-   : "https://observe.invalid";
```

```diff
-     observability: {
-       tracesUrl: repoEnv.EXPO_PUBLIC_OTLP_TRACES_URL ?? "https://api.axiom.co/v1/traces",
-       tracesDataset: repoEnv.EXPO_PUBLIC_OTLP_TRACES_DATASET ?? null,
-       tracesToken: repoEnv.EXPO_PUBLIC_OTLP_TRACES_TOKEN ?? null,
-     },
```

```diff
    updates: {
-     enabled: repoEnv.T3CODE_MOBILE_UPDATES_ENABLED !== "0",
-     url: "https://u.expo.dev/d763fcb8-d37c-41ea-a773-b54a0ab4a454",
-     checkAutomatically: "ON_LOAD",
-     fallbackToCacheTimeout: 0,
+     enabled: false,
    },
```

`src/features/observability/observe.ts` and `tracing.ts` are deleted, along with the "Send crash reports" setting.

</details>

<details>
<summary><b>Agent feedback</b>: <code>apps/server/src/feedback/FeedbackStore.ts</code></summary>

```diff
-     const sent = yield* analytics.record("agent.feedback", {
-       kind,
-       subject,
-       expected,
-       actual,
-       workaround,
-       trace,
-       userRequested,
-       source,
-       ...dimensions,
-     });
```

Deleted with it: the `t3_feedback` tool agents used to file reports, the code that built a report and attached the conversation to it, and the `t3 feedback` command. The server no longer offers the feature, so its switch in Settings is hidden. A feedback card already in a thread can still be closed; choosing Send closes it without sending anything.

</details>

<details>
<summary><b>Favicons</b>: <code>packages/shared/src/favicon.ts</code></summary>

```diff
-     return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.hostname)}&sz=${size}`;
```

Links and preview tabs fall back to the icons the app already has.

</details>

<details>
<summary><b>Version and release source</b>: the two additions</summary>

`scripts/lib/tagged-source-version.ts`:

```diff
+ const FORK_VERSION_SUFFIX = "-zdr3";
```

```diff
-     if (stableTags.length === 1) return stableTags[0]!.slice(1);
+     if (stableTags.length === 1) return `${stableTags[0]!.slice(1)}${FORK_VERSION_SUFFIX}`;
    } catch {
      // No Git, a source archive, or edited manifests: the manifest is the version.
    }
-   return manifestVersion;
+   return `${manifestVersion}${FORK_VERSION_SUFFIX}`;
```

`packages/shared/src/cliRelease.ts`:

```diff
- const CLI_RELEASE_REPOSITORY = "pingdotgg/t3code";
+ const CLI_RELEASE_REPOSITORY = "lorenjphillips/zdr3code";
```

</details>

## Switch from T3 Code

Your threads, projects and settings live in `~/.t3`. ZDR3 Code reads the same directory, so nothing is migrated or copied.

You need git and Node 26.13.1. These steps were run on macOS on Apple Silicon.

**1. Build**

```sh
git clone https://github.com/lorenjphillips/zdr3code.git
cd zdr3code
corepack pnpm install
corepack pnpm exec vp run --filter t3 build
```

**2. Stop T3 Code**

Quit the desktop app. If you use the background service, remove it; this keeps your data.

```sh
t3 service uninstall
```

Only one server can use `~/.t3` at a time, so do this before the next step.

**3. Start ZDR3 Code**

```sh
node apps/server/dist/bin.mjs
```

It takes the same subcommands and flags as `t3`, for example `node apps/server/dist/bin.mjs serve --port 3773`. To keep typing `t3`:

```sh
alias t3="node $PWD/apps/server/dist/bin.mjs"
```

**4. Check what is running**

```sh
node apps/server/dist/bin.mjs --version
# t3 v0.1.11-zdr3
```

The app this server opens shows the same `-zdr3` version in Settings > About. If the suffix is missing, you are running an upstream build.

### Desktop app

On a Mac with Xcode's command line tools and Rust installed, build the app from the same checkout:

```sh
corepack pnpm exec vp run dist:desktop:dmg
```

It writes a `.dmg` such as `release/T3-Code-0.1.11-zdr3-arm64.dmg`. Quit T3 Code, open the `.dmg` and drag the app over the one in Applications. It has the same name (`T3 Code (Beta)`) and app ID as the official app, so it uses your existing desktop settings and `~/.t3`. Because your build is signed differently, macOS may ask once whether the app can use its keychain item; allow it.

A local build has no update feed, so the app never checks for or installs updates. To update, run `git pull` and `corepack pnpm install`, then the same command again.

This build was made and inspected on an Apple Silicon Mac (name, app ID, version, no update feed, no telemetry endpoints in the bundle), but the packaged app was not launched.

### Update

```sh
git pull
corepack pnpm install
corepack pnpm exec vp run --filter t3 build
```

Then restart the server. The in-app update button and `t3 update` look for releases of this fork, and there are none, so they have nothing to install. Do not give `t3 update` an upstream version number: if that upstream build is already on disk, it switches you back to it.

### Not ready to switch

On an official build, `T3CODE_TELEMETRY_ENABLED=false` in the server's environment stops the usage events and the server's relay traces. It does not stop the credential files being read, and it does not reach the browser or phone senders.

## What is left

None of this is telemetry, but it is network traffic you should know about.

- **Model list and update checks.** The server downloads the public model list from GitHub and checks npm and vendor sites for new agent CLI versions. These are plain downloads with no identifier. Turn them off with **Provider update checks** in Settings > Maintenance.
- **Your own OpenTelemetry receiver.** Export stays off until you enter an endpoint in Settings > Maintenance > Diagnostics or set `T3CODE_OTLP_*` or `OTEL_EXPORTER_OTLP_*`. If those `OTEL_` variables are already set on your machine for other tools, they count. Trace files under `~/.t3/userdata/logs` stay local.
- **T3 Connect.** The cloud relay is not built in unless you add upstream's `.env` values. If you do, you are using upstream's relay service.
- **Official phone apps and `app.t3.codes`.** These are upstream builds. They can connect to a ZDR3 Code server, and they still send what upstream sends from the phone or browser.
- **The agents.** Claude Code, Codex and the others have their own telemetry. Configure it in each tool.
- **Managed policy.** A policy file with `telemetry: false` still parses. The key now does nothing.

## Verify it yourself

```sh
# The full change set
git diff 11c63a9f2c --stat

# No telemetry endpoint, key or header in the built server (prints nothing)
grep -rlE "ingest\.t3\.codes|phc_|X-Axiom-Dataset|google\.com/s2/favicons" apps/server/dist
```

## License

The source code is under the [MIT License](./LICENSE), as upstream's is. "T3 Code" and its logos are trademarks of T3 Tools, Inc.; see [TRADEMARK.md](./TRADEMARK.md). This project uses them only to say what it is a fork of.

[base]: https://github.com/pingdotgg/t3code/tree/11c63a9f2ceadbe5f765478a3fc35d04c06e5a40
[compare]: https://github.com/pingdotgg/t3code/compare/11c63a9f2ceadbe5f765478a3fc35d04c06e5a40...lorenjphillips:zdr3code:main
[analytics-config]: https://github.com/pingdotgg/t3code/blob/11c63a9f2ceadbe5f765478a3fc35d04c06e5a40/apps/server/src/telemetry/AnalyticsService.ts#L67-L74
[analytics-post]: https://github.com/pingdotgg/t3code/blob/11c63a9f2ceadbe5f765478a3fc35d04c06e5a40/apps/server/src/telemetry/AnalyticsService.ts#L231-L236
[turn-props]: https://github.com/pingdotgg/t3code/blob/11c63a9f2ceadbe5f765478a3fc35d04c06e5a40/apps/server/src/telemetry/ProviderUsageAnalytics.ts#L174-L205
[identify-read]: https://github.com/pingdotgg/t3code/blob/11c63a9f2ceadbe5f765478a3fc35d04c06e5a40/apps/server/src/telemetry/Identify.ts#L253-L271
[identify-distinct]: https://github.com/pingdotgg/t3code/blob/11c63a9f2ceadbe5f765478a3fc35d04c06e5a40/apps/server/src/telemetry/Identify.ts#L279-L295
[identify-owners]: https://github.com/pingdotgg/t3code/blob/11c63a9f2ceadbe5f765478a3fc35d04c06e5a40/apps/server/src/telemetry/Identify.ts#L307-L339
[identify-always]: https://github.com/pingdotgg/t3code/blob/11c63a9f2ceadbe5f765478a3fc35d04c06e5a40/apps/server/src/telemetry/AnalyticsService.ts#L149
[hash]: https://github.com/pingdotgg/t3code/blob/11c63a9f2ceadbe5f765478a3fc35d04c06e5a40/packages/shared/src/telemetryId.ts#L8-L9
[relay-exporter]: https://github.com/pingdotgg/t3code/blob/11c63a9f2ceadbe5f765478a3fc35d04c06e5a40/packages/shared/src/relayTracing.ts#L159-L177
[relay-release]: https://github.com/pingdotgg/t3code/blob/11c63a9f2ceadbe5f765478a3fc35d04c06e5a40/.github/workflows/release.yml#L445-L463
[doc-browser]: https://github.com/pingdotgg/t3code/blob/11c63a9f2ceadbe5f765478a3fc35d04c06e5a40/docs/user/telemetry.md?plain=1#L82-L84
[doc-mobile]: https://github.com/pingdotgg/t3code/blob/11c63a9f2ceadbe5f765478a3fc35d04c06e5a40/docs/user/telemetry.md?plain=1#L96-L98
[observe]: https://github.com/pingdotgg/t3code/blob/11c63a9f2ceadbe5f765478a3fc35d04c06e5a40/apps/mobile/src/features/observability/observe.ts
