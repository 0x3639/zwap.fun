# zwap agent notes

- Settlement is two Zenon HTLCs sharing one hashlock: the maker locks the
  base leg with the long locktime, the taker locks the quote leg with the
  short locktime. `hashType` is always `1` (SHA-256) and `keyMaxSize` is
  always `32`; reject any observed HTLC that differs.
- **Never trust a DM-carried HTLC id.** Every id received in a private
  message must be re-verified with `embedded.htlc.getById(id)` against the
  node before acting on it. A private message is a pointer to look up, not
  evidence that a leg is funded.
- Every settlement plan and every verified HTLC is checked against the
  configured `VITE_ZENON_CHAIN_ID`. A mismatch must freeze the trade, not
  fall back to some other chain.
- Use the order-authority key only for rendezvous and acceptance; use fresh,
  persisted per-reservation Nostr session keys for bearer-material messages
  (ADR 0003).
- Bind each private message to protocol version, chain id, order ID, session
  ID, expiry, each leg's token standard and amount, negotiated `price`, and
  transcript hash.
- **Never expose a mnemonic, private key, wallet backup, or a preimage before
  it has appeared on chain** in commands, fixtures, logs, screenshots, or
  docs. Once a preimage is on-chain (after the maker's `Unlock`) it is public
  by definition and no longer sensitive — but never publish one you
  generated for a trade you have not yet unlocked.
- One locally controlled address signs its account blocks **sequentially**.
  The Zenon account chain is a hash-linked sequence; a concurrent send from
  two callers to the same address races into a rejected or forked block. Use
  one `KeystoreSigner` instance per address and serialize sends through it.
- Every account block needs fused plasma or proof-of-work. A
  `plasma_unavailable` error is retryable and does not change the trade's
  phase — fuse plasma or wait for the proof-of-work worker, then retry the
  same action.
- Publish with test keys and small amounts only; verify the signer first,
  then record relay URLs, acknowledgements, and event IDs. There is no
  testnet faucet or plasma bot today, so manual testing usually happens on
  mainnet with amounts you can afford to lose.
- Negative tests must cover: an HTLC whose on-chain terms differ from the
  signed terms, wrong hash type/key max size, an already-unlocked or
  already-reclaimed HTLC, chain id mismatch, replay, duplicate reservation,
  expiry boundaries, peer disconnect, an unreachable node, insufficient
  plasma, and mid-swap abort.
- `nostr-tools@2.23.3` NIP-17 unwrap only decrypts; validate both signatures,
  both kinds, tags, rumor hash, recipient, and seal/rumor author match
  yourself.
- zwap is privacy-first: use ephemeral per-reservation Nostr keys so relays
  and counterparties learn as little as the protocol requires. Zenon
  addresses are not similarly ephemeral — an address is reused across a
  wallet's trades — but they appear only inside encrypted DMs, never in
  public Nostr events.
- Public Nostr data is an ephemeral order-book rendezvous, not a transaction
  ledger. Do not add receipt histories, bearer material, preimages before
  they are on-chain, or unnecessary identity/linkability metadata to public
  events.
