# Recipe: Boot Guard After Power Cuts (optional)

**Problem.** After a power cut a Being's box can come back to a firmware screen instead of the OS: the CMOS battery lost
power and the BIOS reset its settings, or a firmware/boot-loader update moved another entry (a second OS, a network boot)
ahead of the OS in the UEFI boot order. Nobody is at the box, so the Being stays offline until someone notices.

**Pattern.** A small root oneshot runs at every boot and after every package transaction:

| Check | How | Action |
|---|---|---|
| Boot order drift | `efibootmgr`: is the OS entry (`BOOT_GUARD_ENTRY`, default `ubuntu`) first in `BootOrder`? | `fix` moves it first. It never deletes or adds an entry |
| CMOS reset | the kernel's `RTC time … date:` line at this boot is older than the installed system | logs `CMOS-RESET`: replace the battery and re-check BIOS settings (power-on after AC loss, boot mode) |
| Boot loader updates | apt `DPkg::Post-Invoke` hook | re-runs `fix` after every package run, because boot-loader packages may rewrite NVRAM entries |

Exit codes: 0 ok or fixed, 1 drift left unfixed, 2 EFI state unreadable. Log lines start with `OK`, `DRIFT`, `FIXED`,
`CMOS-RESET` or `ERROR`, so the heartbeat can grep the log and raise one blocker.

## Install (needs root once)

```bash
sudo install -m 0755 docs/recipes/boot-guard/being-boot-guard.sh /usr/local/sbin/being-boot-guard
sudo tee /etc/systemd/system/being-boot-guard.service >/dev/null <<'UNIT'
[Unit]
Description=Keep the OS first in UEFI BootOrder; log drift and CMOS resets
ConditionPathIsDirectory=/sys/firmware/efi/efivars
After=local-fs.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/being-boot-guard fix

[Install]
WantedBy=multi-user.target
UNIT
echo 'DPkg::Post-Invoke { "if [ -x /usr/local/sbin/being-boot-guard ]; then /usr/local/sbin/being-boot-guard fix >/dev/null || true; fi"; };' \
  | sudo tee /etc/apt/apt.conf.d/99being-boot-guard >/dev/null
sudo systemctl daemon-reload && sudo systemctl enable --now being-boot-guard.service
```

`being-boot-guard check` runs as any user and only logs (to `~/.local/state/being-boot-guard/`).

## What it does not fix

- A box that hangs in POST (bad disk, failing PSU, a peripheral) never reaches the guard. Set the BIOS to power on after
  AC loss, and keep a person or a smart plug able to power-cycle it.
- A dead CMOS battery resets settings again at the next cut; the guard only tells you. Replace the battery.
- Legacy-BIOS boxes have no `efivars`; the unit skips itself there.

Remove: disable the unit, delete the unit, the apt hook and `/usr/local/sbin/being-boot-guard`.
