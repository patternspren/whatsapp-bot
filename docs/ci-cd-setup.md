# CI/CD for the WhatsApp bot

## Verified deployment target

- Google Cloud project: `project-38a010b6-380d-436b-8a3`
- VM: `alinhamento-bot`, zone `us-central1-c`
- Application directory: `/home/matheus_cordeirorf/AyaAhdi-bot`
- systemd unit: `alinhamento-bot.service`
- VM service account: `bot-whatsapp-sheets@project-38a010b6-380d-436b-8a3.iam.gserviceaccount.com`
- Runtime: Debian 13, Node.js process managed by systemd

The VM is currently using SSH keys in Compute Engine metadata. Do not put a private SSH key or a service-account JSON key in GitHub. Use GitHub OIDC with Google Workload Identity Federation, and connect through IAP with OS Login after the required access is configured.

## Workflow behavior

1. Pull requests to `master` run `npm install` and `npm test`.
2. A push to `master` runs the same tests first, then waits at the GitHub `production` environment gate.
3. After the gate allows deployment, GitHub Actions gets a short-lived Google credential through OIDC and opens an IAP/OS Login connection to the named VM.
4. The deploy script stops the current unit, checks out the tested commit, installs production dependencies, starts the unit, and waits up to three minutes for the existing `Coletor conectado` log message.
5. On any update or health-check failure, it resets tracked source files to the previous commit, reinstalls dependencies, starts the previous version, and checks the same health signal.

The script uses `git reset --hard` only after verifying there are no tracked local edits. It never runs `git clean` and does not replace ignored or untracked runtime data such as `.env`, `auth_info_baileys/`, sessions, pending messages, or confirmations.

## One-time setup still required

The deployment job intentionally has no credentials until these steps are approved and configured:

1. Create a dedicated deployer service account and a Workload Identity Pool/provider restricted to repository `patternspren/whatsapp-bot`, branch `master`, and push events. Allow that identity to impersonate only the deployer account. Do not create a service-account key.
2. Configure OS Login for this VM and IAP SSH access. Grant the deployer only the permissions needed for this VM. The current deployment script restarts a system service, so the VM login must be allowed to run the specific `systemctl stop/start/is-active` operations. Prefer a narrowly scoped sudo rule for this service over broad project-wide administrator access.
3. Create the GitHub `production` environment and require an authorized reviewer before deployments. Add these as environment **variables**, not secrets: `GCP_PROJECT_ID`, `GCP_WIF_PROVIDER`, `GCP_DEPLOYER_SERVICE_ACCOUNT`, `GCE_INSTANCE`, `GCE_ZONE`, and `GCE_OSLOGIN_USER`.
4. Ensure `master` only accepts reviewed pull requests. Merge the CI/CD pull request only after the environment gate and Google access configuration are ready.

No production IAM, VM metadata, firewall, service, or bot files have been changed as part of this preparation.

