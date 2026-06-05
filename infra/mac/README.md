# dol-watch — a tiny Mac agent that watches DOL for new LCA releases

DOL's Akamai WAF blocks AWS and datacenter IPs (returns `403`), so the release
check can't run in the cloud. Your Mac has a **residential IP**, which Akamai
lets through — so this little launchd agent runs the check from here.

**What it does, once a day (and at login):**

1. Fetches the [DOL OFLC performance page](https://www.dol.gov/agencies/eta/foreign-labor/performance).
2. Finds the newest `LCA_Disclosure_Data_FY<year>` file (≥ 2020).
3. If it's newer than last time → downloads it → uploads to the S3 inbox →
   fires the burst (`lca.manual` / `build.run`) → **shows a notification**.
4. Nothing new → exits silently (no nag). Anything fails → **notification with
   the reason**.

You don't have to remember anything. When a new quarter lands, you get a
notification that the review pipeline is running, then the usual
`operator.h1b.report` email. The heavy lifting (ingest → NLP → operator UI)
happens in the ephemeral burst, exactly as before — this just feeds it.

---

## One-time setup

### 1. AWS profile (`dol-watch`)

Uses the dedicated least-privilege key (`s3:PutObject incoming/*` +
`events:PutEvents` only). This pulls the secret straight from Secrets Manager
into the profile, so the secret is never printed:

```bash
aws configure set aws_access_key_id     AKIAULT4IGZD3A63PIHK --profile dol-watch
aws configure set region                us-east-1            --profile dol-watch
aws configure set aws_secret_access_key \
  "$(aws --profile h1b-report secretsmanager get-secret-value \
       --secret-id lca/php-harvest-aws-key --query SecretString --output text \
     | python3 -c 'import json,sys; print(json.load(sys.stdin)["SecretAccessKey"])')" \
  --profile dol-watch

# sanity check (should NOT 403):
aws --profile dol-watch s3 ls s3://lcasharedstack-ingestscratchbucket64251afd-obtmmxvmd5cg/incoming/
```

### 2. Install the agent

```bash
bash infra/mac/install.sh
```

That renders the LaunchAgent into `~/Library/LaunchAgents/`, loads it, and runs
it once immediately. The first run will likely be **silent** (FY2025_Q4 is
already in your corpus → nothing new), which is the correct result.

### 3. Allow notifications (first time only)

The notifications come from `osascript`, so macOS shows them under **Script
Editor**. If you see nothing on a real release, check **System Settings →
Notifications → Script Editor** and allow alerts.

---

## Living with it

| Want to… | Command |
|---|---|
| See what it's doing | `tail -f ~/.dol-watch/dol-watch.log` |
| Run it right now | `launchctl kickstart -k gui/$(id -u)/report.h1b.dol-watch` |
| Check it's loaded | `launchctl print gui/$(id -u)/report.h1b.dol-watch | head` |
| Update after `git pull` | `bash infra/mac/install.sh` (idempotent) |
| Stop / uninstall | `launchctl bootout gui/$(id -u)/report.h1b.dol-watch && rm ~/Library/LaunchAgents/report.h1b.dol-watch.plist` |
| Force a re-trigger of a release already seen | `rm ~/.dol-watch/state` then kickstart |

State is just `~/.dol-watch/state` (one line, the last `YYYY-Q` processed).

## Config (env, optional — defaults are baked in)

`DOL_WATCH_PROFILE` (`dol-watch`), `DOL_WATCH_REGION` (`us-east-1`),
`DOL_WATCH_BUCKET` (the ingest-scratch bucket), `DOL_WATCH_START_YEAR` (`2020`).
Set them in the LaunchAgent's `EnvironmentVariables` if you ever need to override.

## Notes

- **Laptop reality:** if the Mac is asleep at 13:00, launchd runs the job at the
  next wake — so a release is caught within a day or two of you next opening the
  lid. DOL publishes quarterly, so that's plenty timely.
- **Why not the cloud / a proxy?** DOL/Akamai blocks datacenter IPs at the
  IP-reputation layer; only *residential* proxies bypass it, and those are
  evasion tooling (per-GB cost, dubious IP sourcing). Running on your own
  residential connection is the clean equivalent. See [[Operator-Release-Pipeline]].
- This is the sole off-AWS uploader into the S3 inbox. (An earlier PHP-cron
  variant was removed once we confirmed datacenter/shared-hosting IPs are blocked
  the same way AWS is — a residential machine is required.)
