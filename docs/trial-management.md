# Pi management trial

This adds `python -m croom.trial_management` / `croom-trial` as a separate,
management-only process. It does not start the existing audio, video, AI,
calendar or meeting services, and does not claim to repair those services.
It requires the dashboard management-trial API from the companion dashboard PR.

Supported: one-time enrollment, authenticated WebSocket reconnection, system
metrics, remote `get_status`, and durable room name/location/timezone overrides.
There is no shell execution, reboot, software update, calendar credential or
meeting-account management. Room overrides belong to this trial's state file;
they do not change the legacy agent's meeting configuration.

## Install on holocan after reviewing and merging

Record the merge commit SHA and use it in place of `<AGENT_MERGE_SHA>`. Pinning the
commit avoids installing unrelated future changes. Run the following on the Pi
with administrator access, before changing the existing service:

```sh
sudo install -d -m 0700 /var/backups/croom-trial
sudo cp -a /etc/croom/config.yaml /var/backups/croom-trial/config.yaml
sudo cp -a /etc/systemd/system/croom.service /var/backups/croom-trial/croom.service
sudo /opt/croom/venv/bin/pip freeze > /tmp/croom-before-trial.txt
sudo install -m 0600 /tmp/croom-before-trial.txt /var/backups/croom-trial/requirements.txt
rm /tmp/croom-before-trial.txt
# Preserve the installed package, including any previous local changes.
sudo tar -C /opt/croom -czf /var/backups/croom-trial/venv.tar.gz venv
sudo /opt/croom/venv/bin/pip install --no-deps \
  'https://github.com/Inflection-Space-Systems/croom.to/archive/<AGENT_MERGE_SHA>.tar.gz'
sudo /opt/croom/venv/bin/python -c 'import aiohttp, yaml, croom.trial_management'
```

In the dashboard's Provisioning page, generate a token for holocan. Use
`sudoedit /etc/croom/config.yaml` to set the following while preserving existing
settings. Do not put the token in a command line or commit it to Git:

```yaml
dashboard:
  enabled: true
  url: https://croom.dev.inflection-space.com
  enrollment_token: '<TOKEN_FROM_PROVISIONING_PAGE>'
  heartbeat_interval_seconds: 30
  metrics_interval_seconds: 60
```

Confirm the Pi resolves the hostname through the tailnet and validates its TLS
certificate (`curl -I https://croom.dev.inflection-space.com`). A browser-login
redirect is normal at `/`; `/ws` and `/api/provisioning/enroll` use machine
credentials and must not redirect to Authelia.

Create `/etc/systemd/system/croom.service.d/management-trial.conf` with
`sudo mkdir -p /etc/systemd/system/croom.service.d` and `sudoedit`:

```ini
[Service]
ExecStart=
ExecStart=/opt/croom/venv/bin/python -m croom.trial_management -c /etc/croom/config.yaml
StateDirectory=croom/trial-management
StateDirectoryMode=0700
UMask=0077
NoNewPrivileges=true
```

```sh
sudo systemctl daemon-reload
sudo systemctl restart croom
systemctl status croom --no-pager
journalctl -u croom -n 50 --no-pager
```

The service still runs as the existing `croom` user. Systemd creates its state
directory with the correct ownership. The enrollment exchange stores only the
per-device key in a 0600 state file and never logs it. Keep that state file when
restarting or reinstalling. Tokens are consumed once: if the enrollment response
is lost or cannot be saved, cancel/recreate the enrollment explicitly. Do not
remove identity state to troubleshoot an ordinary connection failure.

Verify Online status, new metrics, Read Device Status, Apply Room Configuration,
and a service restart preserving the room and enrollment. These checks do not
reboot the Pi or join a meeting. The dashboard commits configuration only after
the device confirms durable storage; if a network/database failure makes the
result uncertain, read status and reapply the intended values.

## Roll back

Stop the service, remove only `management-trial.conf`, restore the config and
venv backups, then reload systemd and start the service. This restores the
previous installation, including its known upstream startup failure.
Preserve the trial identity file securely unless intentionally retiring the
enrollment; a future trial can reuse it with the same dashboard.

## Tests

```sh
pip install aiohttp pyyaml
PYTHONPATH=src python -m unittest discover -s tests/trial -v
```

For an already-running disposable local Node/PostgreSQL dashboard with a
bootstrap administrator, set `TRIAL_DASHBOARD_URL`, `TRIAL_ADMIN_EMAIL` and
`TRIAL_ADMIN_PASSWORD` in your environment, then run:

```sh
PYTHONPATH=src python tests/trial/dashboard_smoke.py
```

The smoke test restricts its target to loopback and exercises real enrollment,
metrics, acknowledged configuration delivery, status reads and restart state.
Plain HTTP is accepted only with the explicit localhost testing option; HTTPS
and normal certificate validation are required for holocan.
