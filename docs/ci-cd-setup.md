# CI/CD for the WhatsApp bot

## Verified deployment target

- Google Cloud project: `project-38a010b6-380d-436b-8a3`
- VM: `alinhamento-bot`, zone `us-central1-c`
- Application directory: `/home/matheus_cordeirorf/AyaAhdi-bot`
- systemd unit: `alinhamento-bot.service`
- VM service account: `bot-whatsapp-sheets@project-38a010b6-380d-436b-8a3.iam.gserviceaccount.com`
- Runtime: Debian 13, Node.js process managed by systemd

## Configured access

GitHub Actions authenticates with OIDC through the Google Workload Identity Pool `github-actions` and provider `whatsapp-bot`. The provider accepts only push events from `patternspren/whatsapp-bot` on `master`. No long-lived SSH key or service-account JSON key is stored in GitHub.

A dedicated service account, `github-deployer@project-38a010b6-380d-436b-8a3.iam.gserviceaccount.com`, is restricted to that repository identity. It has OS Admin Login and IAP tunnel access for the `alinhamento-bot` VM, Service Account User access only to the VM's attached service account, and a custom read-only Compute role for the metadata lookups used by `gcloud compute ssh`.

OS Login is enabled only on this VM. The human Google account also has OS Admin Login on this VM and Service Account User on its attached service account, so the normal Cloud Shell/IAP login continues to work. The project's SSH firewall rule now accepts port 22 only from Google's IAP range `35.235.240.0/20`.

GitHub's `production` environment is limited to `master`, requires approval from `@patternspren`, and does not allow administrators to bypass the protection rule. The environment contains these non-sensitive variables (no secrets or private keys):

- `GCP_PROJECT_ID`
- `GCP_WIF_PROVIDER`
- `GCP_DEPLOYER_SERVICE_ACCOUNT`
- `GCE_INSTANCE`
- `GCE_ZONE`

## Workflow behavior

1. Pull requests to `master` run `npm install` and `npm test`.
2. A push to `master` runs the same tests first, then waits for approval at the GitHub `production` environment gate.
3. After approval, GitHub Actions gets a short-lived Google credential through OIDC and opens an IAP/OS Login connection to the VM.
4. The deploy script stops the current unit, checks out the tested commit, installs production dependencies, starts the unit, and waits up to three minutes for the existing `Coletor conectado` log message.
5. On any update or health-check failure, it resets tracked source files to the previous commit, reinstalls dependencies, starts the previous version, and checks the same health signal.

The script uses `git reset --hard` only after verifying there are no tracked local edits. It never runs `git clean` and does not replace ignored or untracked runtime data such as `.env`, `auth_info_baileys/`, sessions, pending messages, or confirmations.

## Verification and release status

The CI workflow passed on the open draft pull request. Its test job succeeded; the deploy job was skipped because the run came from a pull request. A read-only SSH check as the human account succeeded through IAP after the firewall restriction. No bot restart, code update, or production deployment has occurred.

The CI/CD pull request remains a draft. Once reviewed and merged into `master`, each production deployment will still wait for approval in the `production` environment.
