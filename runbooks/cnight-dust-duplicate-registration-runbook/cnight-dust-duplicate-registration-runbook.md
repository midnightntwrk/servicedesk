# Runbook: cNIGHT→DUST duplicate registrations ("DUST stopped generating")

A recurring mainnet support issue. Use this to diagnose and resolve reports where a
cNIGHT holder's DUST generation silently stops or their DUST balance reads 0.

_Compiled 2026-09-12 from session investigation. Verify code line references against
current source before asserting — the Midnight ecosystem changes fast._

---

## Symptom

- User registered cNIGHT for DUST via the DApp (`midnight-dust-mainnet.nethermind.io`).
- DUST generation is paused / balance is 0, often with a "Replicate Registrations
  Detected" warning, or after the user re-registered (e.g. to change DUST address).
- User may report "I removed the duplicates but they're still there."
- **After a successful de-registration**, the DApp still shows a "Replicate Registrations
  Detected" screen listing UTXOs that are **already spent** (often days old), and this
  screen **blocks or silently no-ops the register flow** — so the user cannot register a
  fresh single mapping. This is a **stale client-side view**, not chain state (see
  "Re-registering from zero" below). Users often re-submit here, which is exactly how the
  original duplicates were created.

## Root cause

The cNgD pallet counts registrations by Cardano **stake credential** and requires
**exactly one** live registration UTXO at the mapping validator. 2+ live UTXOs for one
stake key ⇒ the wallet is treated as **unregistered** ⇒ no DUST. (A second mapping also
emits a Deregistration event — see `midnight-node` changelog `node-0.18.0`
"Fix missing Deregistration event when user adds second mapping".)

Duplicates are created by the DApp because its lookup filters by stake key **AND**
`dustPKH`, while the chain counts by stake key only. Re-registering with a different DUST
address adds a second UTXO the DApp can't see or clear. **This filter bug is still in
`main`** (`midnight-cnight-to-dust-dapp/src/hooks/useRegistrationUtxo.ts`, the
`registrations.filter(r => r.dustPKH === dustPKH)` line and the `searchByTxHash`
equivalent). Tracking issue: `midnightntwrk/midnight-cnight-to-dust-dapp#249`.

DUST is generated from cNIGHT **held at / received by** a validly-registered stake key,
and accrues to the DUST address in the datum (independent of the Cardano wallet).

## Key on-chain identifiers (Cardano mainnet)

- Mapping validator address: `addr1w9e7ft4rrdd4rkdseguxr9hudfxyytm5ckh2qy0yhz7lfeg9lvhq7`
- Auth NFT: policy `73e4aea31b5b51d9b0ca386196fc6a4c422f74c5aea011e4b8bdf4e5`, **empty** asset name
- Registration datum: `Constr0[ Constr0[ bytes28 stakeKeyHash ], bytes dust_address ]`
- Mainnet cNIGHT token: policy `0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa`,
  asset name `4e49474854` ("NIGHT") → unit = concat of the two
- Repos: dapp `midnightntwrk/midnight-cnight-to-dust-dapp` (TS, Lucid+Blockfrost);
  validator `midnightntwrk/midnight-cnight-generates-dust` (Haskell/Plutus)

## Diagnose (no API key — Koios public API)

Given the user's Cardano **stake address** (`stake1…`), count their live registration
UTXOs. `>1` confirms the bug. If they only give a registration tx hash, resolve its
datum stake credential first (Koios `/tx_utxos`).

Save as `cnight_dust_diag.py`, run: `python3 cnight_dust_diag.py stake1...`

```python
#!/usr/bin/env python3
import sys, json, time, datetime, urllib.request
KOIOS="https://api.koios.rest/api/v1"
MV="addr1w9e7ft4rrdd4rkdseguxr9hudfxyytm5ckh2qy0yhz7lfeg9lvhq7"
CHARSET="qpzry9x8gf2tvdw0s3jn54khce6mua7l"
def cb(data,frm,to,pad=True):
    acc=0;bits=0;ret=[];maxv=(1<<to)-1
    for v in data:
        acc=(acc<<frm)|v;bits+=frm
        while bits>=to: bits-=to;ret.append((acc>>bits)&maxv)
    if pad and bits: ret.append((acc<<(to-bits))&maxv)
    return ret
def keyhash(a):
    pos=a.rfind('1');d=[CHARSET.find(c) for c in a[pos+1:]]
    return bytes(cb(d[:-6],5,8,False))[1:29].hex()   # header byte + 28-byte cred
def post(path,payload):
    req=urllib.request.Request(KOIOS+path,data=json.dumps(payload).encode(),
        headers={"accept":"application/json","content-type":"application/json"})
    return json.load(urllib.request.urlopen(req,timeout=90))
def datum_fields(h):   # -> (stakeKeyHash, dust_address) best-effort
    m=h.find("d8799f581c"); sc=dust=None
    if m!=-1:
        sc=h[m+10:m+10+56]; rest=h[m+10+56:]
        if rest.startswith("ff"): rest=rest[2:]
        if rest.startswith("58"):
            blen=int(rest[2:4],16); dust=rest[4:4+blen*2]
    return sc,dust
tkh=keyhash(sys.argv[1]); print("credential:",tkh,file=sys.stderr)
seen={}; off=0; lim=1000
while True:                                            # dedup by (tx,ix): offset paging can overlap
    rows=post(f"/address_utxos?offset={off}&limit={lim}",{"_addresses":[MV],"_extended":True})
    if not rows: break
    for u in rows: seen[(u["tx_hash"],u["tx_index"])]=u
    if len(rows)<lim: break
    off+=lim; time.sleep(0.3)
print("distinct live UTxOs at validator:",len(seen),file=sys.stderr)
m=[]
for (tx,ix),u in seen.items():
    inl=u.get("inline_datum"); hx=inl.get("bytes") if isinstance(inl,dict) else None
    if not hx: continue
    sc,dust=datum_fields(hx)
    if sc==tkh: m.append({"tx":tx,"ix":ix,"block":u.get("block_height"),"time":u.get("block_time"),"dust":dust})
m.sort(key=lambda r:(r["block"] or 0))
refs=[f"{r['tx']}#{r['ix']}" for r in m]; st={}
if refs:
    for r in post("/utxo_info",{"_utxo_refs":refs,"_extended":False}):
        st[(r["tx_hash"],r["tx_index"])]=r.get("is_spent")   # authoritative unspent check
print(f"\nLIVE REGISTRATIONS: {len(m)}\n")
print("| # | tx_hash#ix | Block | Timestamp (UTC) | dust_address | is_spent |")
print("|---|---|---|---|---|---|")
for i,r in enumerate(m,1):
    ts=datetime.datetime.utcfromtimestamp(r["time"]).strftime("%Y-%m-%d %H:%M:%S")
    print(f"| {i} | `{r['tx']}#{r['ix']}` | {r['block']} | {ts} | `{r['dust']}` | {st.get((r['tx'],r['ix']))} |")
```

Notes:
- The validator holds ~3,000+ UTXOs; the script pages and dedups (Koios offset paging
  over a live set can return overlaps). It confirms each match unspent via `/utxo_info`.
- To verify a claimed de-registration tx actually spent a registration UTXO: Koios
  `/tx_utxos` and check for inputs at `MV` (mapping-validator address) with 0 outputs back.

## Remediation (accrued DUST is NEVER lost — it lives at the DUST address)

Target state: **exactly one** live registration for the stake key.

1. **Fresh wallet (simplest, no tooling — recommend for non-devs).** Move NIGHT to a
   brand-new Cardano wallet (**new seed → new stake key**, not just a new address in the
   same account), then register **once** via the DApp to the **same DUST address**.
   Works only if the NIGHT is transferable (NOT locked in Glacier-Drop vesting).
   Register only once — repeating registration recreates the bug.
2. **Keep same wallet — targeted de-registration.** Spend the specific duplicate UTXO(s)
   directly. On-chain authorization needs only the **stake-key signature** (the datum's
   `c_wallet`), which the owner has, so cross-DUST-address duplicates are removable even
   though the DApp hides them. Reuse the DApp's own builder
   `DustTransactionsUtils.buildUnregistrationTransaction(lucid, dustPKH, registrationUtxo)`
   (burns 1 auth NFT + `collectFrom([utxo], Data.void())`, signs payment+stake). Needs a
   Blockfrost key and local wallet signing. **The user runs it themselves — never take
   their keys/seed.** Companion script: [`scripts/deregister-specific.ts`](scripts/deregister-specific.ts)
   — drop it into the dapp repo's `scripts/` dir (it imports `../src/lib/dustTransactionsUtils`
   so it stays in lock-step with production), pass the UTXO ref(s) to spend, dry-run by
   default, `--submit` to send. Verify the import path still resolves against current dapp
   `main` before handing it over.
3. **NOT the fix:** `midnight-node-toolkit deregister-dust-address`. That acts on the
   Midnight-ledger native-NIGHT `DustRegistration` (via `--src-url wss://rpc…`,
   `--wallet-seed`), **not** the Cardano cNIGHT mapping validator. Different path.

## Re-registering from zero (stale DApp view after de-registration)

Once the duplicates are cleared, the user is often at **zero** live registrations and needs
**exactly one**. But the DApp frequently keeps showing a "Replicate Registrations Detected"
screen listing the **already-spent** UTXOs (client-side cache, not chain — the data can be
days old, far longer than any indexer lag), and that screen blocks/no-ops the register
flow. **First confirm the real count** with the Koios diagnostic — never trust the screen.
This is a distinct failure mode from the filter bug (still #249); worth its own note there.

Two rules to give the user, both to avoid re-creating duplicates:
1. Never judge success from the DApp screen — confirm on the Cardano address / re-run the
   diagnostic.
2. Never re-submit "because the screen didn't update" — that double-submit is how duplicates
   are born. Submit once, then verify on-chain.

**Path A — clear the stale view, register once via the DApp (default, no tooling).**
1. Clear the DApp origin's site data (DevTools → Application → **Clear site data**:
   localStorage + IndexedDB + cache/service worker), or use a fresh incognito window /
   different browser; reconnect the wallet. At zero registrations the phantom duplicate
   screen clears and the register action becomes available.
2. **Register once**, pointing at the **same DUST address** the user was accruing to (keeps
   DUST continuous — it lives at the DUST address, not the wallet). Then stop.
3. Verify: one new tx on the Cardano address → re-run the diagnostic → expect **exactly 1**
   live registration. DUST resumes.
Prefer this path because the DApp derives `dustPKH` from the connected wallet, so the user
never hand-types the DUST address (see Path B hazard).

**Path B — register via script, bypassing the UI (fallback when the stale view won't
clear).** The DApp's own builder `DustTransactionsUtils.buildRegistrationTransaction(lucid,
dustPKH)` is a **pure, single-registration builder with no existing-registration guard** —
calling it once creates exactly one clean registration. Companion script:
[`scripts/register-once.ts`](scripts/register-once.ts) (internal validation +
`dustPKH`-sourcing notes: [`scripts/register-once.NOTES.md`](scripts/register-once.NOTES.md)).
Same runtime caveats as `deregister-specific.ts` (`CARDANO_NET=Mainnet`, `@/` alias
resolution). Two extra hazards, both enforced/warned by the script:
- **Only run at ZERO.** The builder has no dup guard; running it when a registration exists
  recreates the bug. Confirm zero via the diagnostic first.
- **`dustPKH` correctness is critical.** It is written verbatim into the datum as the DUST
  address that receives DUST; a wrong value is unrecoverable. Source it authoritatively (the
  DApp's DUST-address field / `[DustTransactions]` `dustPKH:` log line), never by guessing.
Verify the import path and builder signature against current dapp `main` before handing over.

## Reference material

- Finding format to emulate: `shieldedtech/mnf-stl-support#299` (comment by ozgb).
- Worked support case this runbook came from: `midnightntwrk/servicedesk#188`.
- Filter-bug tracking issue: `midnightntwrk/midnight-cnight-to-dust-dapp#249`
  (related symptom reports #230, #148).
- Architecture: `midnightntwrk/midnight-architecture` proposal
  `0018-cnight-generates-dust.md`; ledger spec
  `midnight-ledger/spec/cardano-system-transactions.md` and `spec/dust.md`;
  docs `docs.midnight.network/concepts/dust-architecture`.
- History/scale: internal "Dev Experience Friction Report" (Notion) — ~25% of mainnet
  stake keys had 2+ active UTXOs at peak; both the Nethermind dapp and the 1AM wallet
  hit this independently.
