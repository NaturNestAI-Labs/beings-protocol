# Recipe: Local LLM Proxy with Key Failover (optional)

A local [LiteLLM](https://docs.litellm.ai/) proxy gives a Being's apps one loopback address for model calls, with a
backup key when the first is exhausted or refused, and a separate, budget-capped virtual key per app. The Being's own
Claude Code and Codex sessions keep their normal logins; the proxy is for **apps** (summarisers, a fleet page, project
services) that call the API directly.

## Layout

| Item | Where |
|---|---|
| Proxy + its database | containers managed by a stack runner (`<being>-llm up/down/status`), loopback port only |
| Provider keys, master key, DB password | `~/.config/<being>/llm-proxy.env` (0600); never in the config file or git |
| Per-app virtual key | each app's own env file, e.g. `~/.config/<being>/<app>.env` |

## Config

```yaml
# llm-proxy.yaml: no secrets here, only references to environment variables
model_list:
  - model_name: claude-main              # what apps ask for
    litellm_params:
      model: anthropic/<model-id>
      api_key: os.environ/LLM_KEY_PRIMARY
    model_info: {id: primary}
  - model_name: claude-main
    litellm_params:
      model: anthropic/<model-id>
      api_key: os.environ/LLM_KEY_SECONDARY
    model_info: {id: secondary}

router_settings:
  routing_strategy: simple-shuffle      # or order the deployments and use fallbacks only
  num_retries: 1
  allowed_fails: 2
  cooldown_time: 300                     # a key that keeps failing rests for 5 minutes

general_settings:
  master_key: os.environ/LLM_PROXY_MASTER_KEY
  database_url: os.environ/LLM_PROXY_DATABASE_URL
```

Start it bound to `127.0.0.1` only. Expose it beyond the box only through a tunnel with an access policy, and only if
another box of the same Being needs it.

## Per-app virtual keys

Create one key per app with the master key, a budget and the models it may use:

```bash
curl -s http://127.0.0.1:<port>/key/generate \
  -H "Authorization: Bearer $LLM_PROXY_MASTER_KEY" -H 'Content-Type: application/json' \
  -d '{"key_alias":"<app>","models":["claude-main"],"max_budget":20,"budget_duration":"30d"}' \
  | python3 -c 'import json,sys; print("LLM_PROXY_KEY=" + json.load(sys.stdin)["key"])' >>"$HOME/.config/<being>/<app>.env"
```

The key goes straight into the app's env file; it is never printed or pasted into chat. Revoke an app by deleting its
key; the others keep working.

## Gotchas

- **Failover hides errors.** A request the provider rejects as invalid (an unsupported parameter, a key scoped to the
  wrong workspace) returns 400 from one deployment and is retried on the next, so a misconfigured key can look healthy.
  Test each deployment alone (temporarily remove the other) before relying on failover, and watch the proxy log for 400s.
- **Model-specific parameters.** Newer models may reject parameters older ones accepted (temperature with extended
  thinking, provider-specific cache flags). Drop them in the app or with the proxy's parameter filtering.
- **Keys tied to a workspace or project** may need an extra header per deployment; check the provider's docs.
- **Budgets are per virtual key**, not per provider key. Keep the provider-side limits too.
- The proxy does not raise the Being's own client limits; see [MODEL_ROUTING.md](../MODEL_ROUTING.md#model-limits).
