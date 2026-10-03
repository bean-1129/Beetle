# Offline proof procedure (manual rehearsal)

This procedure was written on 2026-10-03 and has NOT been executed automatically. `scripts/offline-proof.mjs` only observes and records; it never changes a route, a firewall rule or a setting. The operator performs the steps below by hand during the rehearsal, then runs the script to record the evidence. The result (date, record file, outcome) goes into BUILD_STATUS.md under "Offline proof".

## What the proof is meant to show

That a fresh, model-backed edit is composed, validated and committed while the machine has no path to the internet, and that the two phones on the team LAN keep playing throughout. The team LAN stays up; only the internet uplink is removed.

## Route captured at the time of writing (2026-10-03 12:41 CDT)

```
$ ip route show default
default via 192.168.192.1 dev wlP9s9 proto dhcp src 192.168.204.116 metric 600

$ ip -6 route show default
(none)

$ ip route show
default via 192.168.192.1 dev wlP9s9 proto dhcp src 192.168.204.116 metric 600
172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1 linkdown
192.168.192.0/20 dev wlP9s9 proto kernel scope link src 192.168.204.116 metric 600
```

Interface `wlP9s9` (Wi-Fi "Hult-Wifi"), address 192.168.204.116/20, gateway 192.168.192.1, DHCP lease 40374 s. DNS is systemd-resolved forwarding to 8.8.8.8 and 8.8.4.4 (public resolvers, reached only through the default route). The address differs from the one in docs/ENVIRONMENT.md (172.20.65.84/20, observed earlier in the morning): the Wi-Fi handed out a new lease. Always capture the live route again before the rehearsal; do not rely on the values above.

## Method A: remove the default route (recommended)

Run these on the GB10, in a terminal that stays open for the whole rehearsal.

1. Capture the current route and keep it (also printed on screen so it is in the terminal history):

   ```bash
   mkdir -p data/offline-proof
   ip route show default | tee data/offline-proof/default-route.txt
   ip -6 route show default | tee -a data/offline-proof/default-route.txt
   ```

   If `ip -6 route show default` prints anything, the same remove and restore steps apply to that route with `ip -6`.

2. Record the "before" state (egress expected to succeed):

   ```bash
   node scripts/offline-proof.mjs
   ```

3. Remove the default route. Use the exact line captured in step 1; with the values at the time of writing:

   ```bash
   sudo ip route del default via 192.168.192.1 dev wlP9s9
   ip route show default        # must print nothing
   curl -m 3 https://registry.npmjs.org/ ; echo "exit=$?"   # expected: curl: (7) ... Network is unreachable, or (6) could not resolve host
   ```

4. Run the demonstration: start the server and agent if not already running (`npm run dev -- --prod`), both phones join through the QR, the director submits a brief, then at least one fresh edit while the phones are moving. Then record the evidence, including one scripted edit through the director API:

   ```bash
   node scripts/offline-proof.mjs --edit "add a bridge from the north island to the east island" --expect-offline
   ```

   The script reads the director token from `BEETLE_DIRECTOR_TOKEN` or `data/secrets.json`; the token is never written to the record. It writes `data/offline-proof/<unix ms>.json` with the routes, the listening sockets, the Ollama model list, the server health, the egress probe result and the edit outcome with elapsed time and the activity entries. `--expect-offline` makes the exit code 1 if the evidence does not show blocked egress, so a mistake is caught on the spot.

5. Restore the default route from the captured line (every field, so the metric and source address match what DHCP set):

   ```bash
   sudo ip route add default via 192.168.192.1 dev wlP9s9 proto dhcp src 192.168.204.116 metric 600
   ip route show default
   curl -m 5 -sS -o /dev/null -w "%{http_code}\n" https://registry.npmjs.org/   # expected 200
   ```

   Generic form, if the captured line was saved in step 1: `sudo ip route add $(head -1 data/offline-proof/default-route.txt)`.

   Alternative restore without typing the route: `sudo nmcli connection up "Hult-Wifi"` re-applies the DHCP lease including the default route, but it drops and re-joins the Wi-Fi, which also drops the phones' connection to the server for a few seconds. Prefer `ip route add`.

### Why this keeps the team LAN working and blocks the internet

- The phones and the GB10 are on the same subnet, 192.168.192.0/20. Traffic between them uses the connected ("scope link") route `192.168.192.0/20 dev wlP9s9`, which stays in the table, and ARP on the Wi-Fi. No gateway is involved, so the server on port 7700, the WebSocket and the QR join keep working.
- Every destination outside the subnet (any internet address, including 8.8.8.8 for DNS) needs the default route. With it removed the kernel answers `connect()` with `ENETUNREACH` ("Network is unreachable") immediately. Nothing is dropped silently; a process that tries to reach the internet gets a hard error, which is what `offline-proof.mjs` records as the probe failure.
- Ollama (127.0.0.1:11434) and the OpenClaw gateway are on loopback and do not use any route.
- The join QR carries the LAN IP (`BEETLE_PUBLIC_URL` or the auto-detected 192.168.204.116), not a hostname, so the phones never need DNS.

Caveats for Method A:

- NetworkManager may re-add the default route when the DHCP lease renews (at half the lease time, about 5.6 h after the lease started at the lease above) or when the Wi-Fi roams or reconnects. Check `ip route show default` right before and right after the demonstration; the script records it at the moment it runs.
- The router still has internet; only this machine is cut off. The phones keep their own mobile data unless the operator turns it off. That is acceptable because the claim is about the machine running the model, not about the phones.
- Docker's `docker0` bridge is link-down and carries no route to the internet; it is unrelated and untouched.

## Method B: disconnect the uplink at the router or access point

If the team controls the Wi-Fi router or AP: unplug the WAN cable from the router (or disable the WAN interface in its admin page) while leaving the Wi-Fi radio on. Every device on the LAN, phones included, loses the internet while the LAN keeps working. The route on the GB10 stays in place, so `scripts/offline-proof.mjs` reports "egress blocked: probably (indirect evidence)" because the probe fails although a default route exists; the record then needs a note from the operator saying how the uplink was cut. This method proves more (nothing on the LAN can reach out) but is only possible with access to the router. On a venue network (such as the one observed at the time of writing) it is usually not possible; use Method A, or run the demo on a phone hotspot with mobile data switched off, which gives the same effect as Method B.

Do not use the Wi-Fi off switch on the GB10: that also disconnects the phones from the server.

## What the proof shows and what it does not

Shown, when Method A is followed and the record says "egress blocked: yes, by missing default route":

- At the moment of the record there was no IPv4 or IPv6 default route and an HTTPS probe to registry.npmjs.org failed within 3 s.
- Ollama was listening on loopback only and the configured model was present locally.
- The Beetle server was up, the agent worker had claimed within the last 30 s, and (with `--edit`) one director edit went through the request queue to a terminal phase, with the measured elapsed time and the activity phases.

Not shown:

- It is a snapshot. It does not show the state of the route a minute earlier or later; the operator's terminal history and the "before" record are the only record of the sequence. Run the script again right after the live edits to narrow the window.
- One probe to one host. It does not enumerate every possible path (an HTTP proxy variable, a VPN, another interface with its own route). The script records the full `ip route` default output and `ss -ltn`, not a packet capture.
- It does not prove that no process attempted an outbound connection, only that any such attempt would have failed with no route.
- It does not prove anything about model weights or cached content; those are local files and the inventory is in THIRD_PARTY.md.
- The sockets list shows where services listen, not who connected.
- Without `--edit`, the record does not show that the agent produced a world change during the window. The edit in step 4 is the part that ties "offline" to "working".

## Recording the result

Paste into BUILD_STATUS.md under "Offline proof": the method (A or B), the record file name, the "before" and "during" verdict lines printed by the script, the time the route was removed and restored, and whether the two phones were on real devices or on a laptop browser. If the rehearsal was not done, say so; do not quote a result that was not recorded.
