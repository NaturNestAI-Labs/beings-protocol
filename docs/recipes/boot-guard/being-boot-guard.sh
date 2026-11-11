#!/usr/bin/env bash
# Check that the OS entry is first in the UEFI BootOrder and flag a CMOS reset seen at this boot.
#   being-boot-guard.sh [check|fix]   check = log only (any user); fix = also reorder (root; never deletes entries)
# Exit: 0 ok or fixed, 1 drift left unfixed, 2 EFI state unreadable.
set -uo pipefail
MODE=${1:-check}
ENTRY=${BOOT_GUARD_ENTRY:-ubuntu}   # label of the boot entry that must stay first
LOG=${BOOT_GUARD_LOG:-}
if [[ -z $LOG ]]; then
  if [[ $EUID -eq 0 ]]; then LOG=/var/log/being-boot-guard.log; else LOG="${XDG_STATE_HOME:-$HOME/.local/state}/being-boot-guard/boot-guard.log"; fi
fi
mkdir -p "$(dirname "$LOG")"
note() { local m; m="$(date -Is) [$MODE] $*"; echo "$m" >>"$LOG"; echo "$m"; logger -t being-boot-guard -- "$*" 2>/dev/null || true; }

# An RTC still at the firmware's factory year means the CMOS lost power, and BIOS settings were reset with it.
rtc=$(journalctl -b 0 -k -o cat 2>/dev/null | grep -m1 -oP 'RTC time: .*date: \K[0-9-]+' || true)
if [[ -n $rtc && ${rtc:0:4} -lt $(date -d "$(stat -c %y /usr/lib/systemd/systemd)" +%Y) ]]; then
  note "CMOS-RESET: RTC at boot was $rtc (factory date). Replace the CMOS battery; check BIOS settings."
fi

out=$(efibootmgr 2>/dev/null) || { note "ERROR: efibootmgr failed (not UEFI, or efivars unreadable)"; exit 2; }
order=$(awk -F': ' '/^BootOrder:/{print $2}' <<<"$out")
id=$(grep -m1 -iP "^Boot[0-9A-F]{4}\*? \Q$ENTRY\E\b" <<<"$out" | grep -oP '^Boot\K[0-9A-F]{4}')
[[ -n $id ]] || { note "DRIFT: no '$ENTRY' boot entry in NVRAM (order=$order); reinstall the boot loader"; exit 1; }
[[ ${order%%,*} == "$id" ]] && { note "OK: BootOrder=$order ($ENTRY=Boot$id first)"; exit 0; }

note "DRIFT: BootOrder=$order, $ENTRY=Boot$id not first"
[[ $MODE == fix && $EUID -eq 0 ]] || exit 1
rest=$(tr ',' '\n' <<<"$order" | grep -vx "$id" | paste -sd, -)
new="$id${rest:+,$rest}"
if efibootmgr -o "$new" >/dev/null; then note "FIXED: BootOrder $order -> $new"; exit 0; fi
note "ERROR: efibootmgr -o $new failed"; exit 1
