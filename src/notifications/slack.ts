/**
 * FORGE 2.0 — Slack Notifications (Phase 3 build-run webhook integration).
 *
 * Opt-in, zero-config-by-default Slack notifications for a `forge build` run: prompt pass,
 * prompt fail, and run-complete events post a rich attachment to a Slack Incoming Webhook when
 * `FORGE_SLACK_WEBHOOK` is set. Absent the env var, {@link getSlackConfig} returns `null` and
 * every notify function is called with it — each one is a no-op in that case, so a build with no
 * webhook configured behaves EXACTLY as before this module existed.
 *
 * NEVER THROWS, NEVER BLOCKS: every notify function catches its own network error (bad webhook
 * URL, Slack outage, DNS failure, timeout) and resolves silently — a Slack incident must never
 * fail or slow down a FORGE build (Contract 4's "degrade to stateless, never halt" house rule,
 * applied to notifications). Uses the platform `fetch` (Node 18+) — no `axios`/`node-fetch`
 * dependency.
 */

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** Slack webhook configuration. */
export interface SlackConfig {
  webhookUrl: string;
}

/** The minimal `fetch` surface used (so tests can inject a fake without touching the network). */
export type SlackFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number }>;

/** Options shared by every notify function (all optional, all overridable for tests). */
export interface SlackNotifyOptions {
  /** Injected `fetch` (tests). Default: the global `fetch`. */
  fetchImpl?: SlackFetchLike;
  /** Progress reporter for a failed delivery (never thrown). Default: a `[FORGE:slack]` console line. */
  log?: (message: string) => void;
  /**
   * Fired exactly once per notify call that actually delivers (a 2xx webhook response) — never on
   * a `null`-config no-op or a failed delivery. Callers use this to accumulate a run report's
   * `slack_notifications_sent` count without every notify function needing a non-void return type.
   */
  onDelivered?: () => void;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Read Slack configuration from `FORGE_SLACK_WEBHOOK`. Returns `null` when unset/blank — every
 * caller treats `null` as "notifications disabled" and skips silently (no error, no log noise).
 */
export function getSlackConfig(getEnv: (name: string) => string | undefined = (n) => process.env[n]): SlackConfig | null {
  const webhookUrl = getEnv('FORGE_SLACK_WEBHOOK');
  if (webhookUrl === undefined || webhookUrl.trim() === '') return null;
  return { webhookUrl: webhookUrl.trim() };
}

// ---------------------------------------------------------------------------
// Slack attachment colors
// ---------------------------------------------------------------------------

const COLOR_PASS = '#36a64f';
const COLOR_FAIL = '#e01e5a';

// ---------------------------------------------------------------------------
// Delivery (shared, guarded)
// ---------------------------------------------------------------------------

/** POST one payload to the webhook. Never throws — a failure is logged and swallowed. */
async function deliver(config: SlackConfig, payload: unknown, options: SlackNotifyOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as SlackFetchLike);
  const log = options.log ?? ((message: string) => console.log(`[FORGE:slack] ${message}`));
  try {
    const res = await fetchImpl(config.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      log(`WARNING: Slack webhook responded ${res.status} — notification not delivered.`);
      return;
    }
    options.onDelivered?.();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`WARNING: Slack webhook delivery failed (${reason}) — continuing without it.`);
  }
}

/** Format a millisecond duration as a short human string (e.g. `2m 14s`, `43s`). */
function humanDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

// ---------------------------------------------------------------------------
// Notify functions
// ---------------------------------------------------------------------------

/** Notify that a build run has started. */
export async function notifyStart(
  config: SlackConfig | null,
  project: string,
  totalPrompts: number,
  options: SlackNotifyOptions = {}
): Promise<void> {
  if (!config) return;
  await deliver(
    config,
    {
      text: `FORGE build started — ${project}`,
      attachments: [
        {
          color: '#B88A2E',
          title: `Build started: ${project}`,
          fields: [{ title: 'Total prompts', value: String(totalPrompts), short: true }],
        },
      ],
    },
    options
  );
}

/** Notify that one prompt PASSED. */
export async function notifyPromptPass(
  config: SlackConfig | null,
  project: string,
  promptId: string,
  promptName: string,
  durationMs: number,
  options: SlackNotifyOptions = {}
): Promise<void> {
  if (!config) return;
  await deliver(
    config,
    {
      text: `PASS — ${promptName} (${project})`,
      attachments: [
        {
          color: COLOR_PASS,
          title: `PASS: ${promptName}`,
          fields: [
            { title: 'Project', value: project, short: true },
            { title: 'Prompt', value: promptId, short: true },
            { title: 'Duration', value: humanDuration(durationMs), short: true },
          ],
        },
      ],
    },
    options
  );
}

/** Notify that one prompt FAILED. */
export async function notifyPromptFail(
  config: SlackConfig | null,
  project: string,
  promptId: string,
  promptName: string,
  retries: number,
  options: SlackNotifyOptions = {}
): Promise<void> {
  if (!config) return;
  await deliver(
    config,
    {
      text: `FAIL — ${promptName} (${project})`,
      attachments: [
        {
          color: COLOR_FAIL,
          title: `FAIL: ${promptName}`,
          fields: [
            { title: 'Project', value: project, short: true },
            { title: 'Prompt', value: promptId, short: true },
            { title: 'Retries', value: String(retries), short: true },
          ],
        },
      ],
    },
    options
  );
}

/** Notify that the build run has completed (all prompts done or the queue halted). */
export async function notifyComplete(
  config: SlackConfig | null,
  project: string,
  passed: number,
  failed: number,
  failedIds: string[],
  durationMs: number,
  cacheSaved: number,
  options: SlackNotifyOptions = {}
): Promise<void> {
  if (!config) return;
  const color = failed > 0 ? COLOR_FAIL : COLOR_PASS;
  const summary = failed > 0 ? `Build complete — ${failed} failed` : 'Build complete — all passed';
  const fields = [
    { title: 'Passed', value: String(passed), short: true },
    { title: 'Failed', value: String(failed), short: true },
    { title: 'Duration', value: humanDuration(durationMs), short: true },
    { title: 'Cache saved', value: `$${cacheSaved.toFixed(2)}`, short: true },
  ];
  if (failedIds.length > 0) {
    fields.push({ title: 'Failed prompts', value: failedIds.join(', '), short: false });
  }
  await deliver(
    config,
    {
      text: `${summary} — ${project}`,
      attachments: [{ color, title: `${summary}: ${project}`, fields }],
    },
    options
  );
}
