# Codex review queue for program milestone

- No audit has occurred. Remove “audited-by-us preset” language in INTERFACE; say validated supported constraints.
- Program can accept varied curve, fee recipients, supply and token decimals. App preset is fixed 6 decimal 1B supply, creator fee100 and creator locked LP100, leftover0, initialFDV3SOL/final55SOL. RPC state must either show actual config or restrict UI-created subset; don't mislabel arbitrary campaigns.
- Receipt closure is safe only because no receipt recreation is allowed after close and old account data is cleared; test full withdraw/redeposit and failed duplicate claim.
- Prefunded campaign/receipt PDAs must not allow permanent denial of service through a dust transfer before initialization. Test allocate/assign logic.
- Existing WSOL ATA can receive unsynchronized SOL donations. Before measuring its initial amount, SyncNative may be needed; otherwise an attacker can make the post-spend equal-before test fail. Refund still exists but avoid needless settlement DoS.
- Combined claim payout must use floor(c*(T-G)/T), not c-floor(c*G/T). Current shared interface has correct form.
- Actual settlement includes 20 accounts, no data payload beyond tag; check real packet size, not the old router size.
- Setup budget permanently locked in v1 is disclosed in create confirmation; provide separate cleanup later only after liability proof. Do not claim exact refund of network/setup fees.
- Need test direct donation to vault doesn't enter total. Mutation/config hash rejects while refund works.
