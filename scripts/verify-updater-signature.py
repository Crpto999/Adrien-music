"""Replicate tauri-plugin-updater's signature check, end to end.

`tauri-plugin-updater` decodes the `pubkey` from tauri.conf.json with
base64, then hands it to `minisign_verify::PublicKey::decode`, which expects
the two-line minisign public key *file* format. It then decodes the
`signature` field of latest.json the same way and checks:

    public_key.verify(downloaded_bytes, &signature, /* allow_legacy */ true)

which is: key ids must match, and the Ed25519 signature over the BLAKE2b
hash of the bytes (or over the bytes themselves in legacy mode) must
verify.

This script walks that path so a release can be validated locally before
it is published.

Usage:
    python scripts/verify-updater-signature.py <artifact> <sig-file> \
        [--pubkey <base64 or minisign.pub contents>]
"""

import argparse
import base64
import hashlib
import json
import sys

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

BLAKE2B_OUTBYTES = 64
SIG_ALGORITHM_LEGACY = b"Ed"
SIG_ALGORITHM_PREHASHED = b"ED"


def decode_text_field(value: str) -> str:
    """Mirror tauri-plugin-updater's base64_to_string."""
    return base64.standard_b64decode(value).decode("utf-8")


def parse_public_key(text: str):
    """Parse the two-line minisign public key file format."""
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if len(lines) < 2:
        raise ValueError("public key must have at least two lines")
    raw = base64.standard_b64decode(lines[1])
    if len(raw) != 42:
        raise ValueError(f"public key must decode to 42 bytes, got {len(raw)}")
    algorithm = raw[0:2]
    if algorithm not in (SIG_ALGORITHM_LEGACY, SIG_ALGORITHM_PREHASHED):
        raise ValueError(f"unsupported public key algorithm {algorithm!r}")
    key_id = raw[2:10]
    key = raw[10:42]
    return algorithm, key_id, key


def parse_signature(text: str):
    """Parse the four-line minisign signature file format."""
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if len(lines) < 4:
        raise ValueError("signature must have four lines")
    bin1 = base64.standard_b64decode(lines[1])
    if len(bin1) != 74:
        raise ValueError(f"signature must decode to 74 bytes, got {len(bin1)}")
    trusted_comment = lines[2]
    if not trusted_comment.startswith("trusted comment: "):
        raise ValueError("third line must be a trusted comment")
    bin2 = base64.standard_b64decode(lines[3])
    if len(bin2) != 64:
        raise ValueError(f"global signature must decode to 64 bytes, got {len(bin2)}")
    algorithm = bin1[0:2]
    if algorithm not in (SIG_ALGORITHM_LEGACY, SIG_ALGORITHM_PREHASHED):
        raise ValueError(f"unsupported signature algorithm {algorithm!r}")
    return {
        "algorithm": algorithm,
        "key_id": bin1[2:10],
        "signature": bin1[10:74],
        "trusted_comment": trusted_comment[len("trusted comment: ") :],
        "global_signature": bin2,
    }


def verify(artifact: bytes, pubkey_text: str, signature_text: str) -> None:
    pub_algorithm, pub_key_id, pub_key = parse_public_key(pubkey_text)
    sig = parse_signature(signature_text)

    if pub_key_id != sig["key_id"]:
        raise ValueError(
            f"key id mismatch: public key {pub_key_id.hex()} vs "
            f"signature {sig['key_id'].hex()}"
        )

    is_prehashed = sig["algorithm"] == SIG_ALGORITHM_PREHASHED
    if is_prehashed:
        payload = hashlib.blake2b(artifact, digest_size=BLAKE2B_OUTBYTES).digest()
    else:
        payload = artifact

    public_key = Ed25519PublicKey.from_public_bytes(pub_key)

    try:
        public_key.verify(sig["signature"], payload)
    except InvalidSignature:
        raise ValueError("the artifact signature does not verify")

    # The global signature covers the signature bytes plus the trusted
    # comment, which is what pins the filename and timestamp.
    global_payload = sig["signature"] + sig["trusted_comment"].encode("utf-8")
    try:
        public_key.verify(sig["global_signature"], global_payload)
    except InvalidSignature:
        raise ValueError("the global signature does not verify")


def load_pubkey(raw: str) -> str:
    """Accept either the base64 blob from tauri.conf.json or raw file text."""
    candidate = raw.strip()
    try:
        decoded = base64.standard_b64decode(candidate)
        return decoded.decode("utf-8")
    except Exception:
        return candidate


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact", help="the downloaded installer")
    parser.add_argument("signature", help="the .sig file next to it")
    parser.add_argument(
        "--pubkey",
        help="base64 pubkey from tauri.conf.json, or a minisign .pub file",
    )
    parser.add_argument("--manifest", help="a latest.json to take the signature from")
    args = parser.parse_args()

    if args.manifest:
        with open(args.manifest, encoding="utf-8") as fh:
            manifest = json.load(fh)
        platforms = manifest.get("platforms", {})
        if len(platforms) != 1:
            print(
                f"manifest has {len(platforms)} platforms; pass --platform to pick one",
                file=sys.stderr,
            )
            return 2
        signature_text = decode_text_field(next(iter(platforms.values()))["signature"])
    else:
        with open(args.signature, encoding="utf-8") as fh:
            signature_text = decode_text_field(fh.read().strip())

    if args.pubkey:
        pubkey_text = load_pubkey(args.pubkey)
    else:
        with open("src-tauri/tauri.conf.json", encoding="utf-8") as fh:
            pubkey_text = load_pubkey(
                json.load(fh)["plugins"]["updater"]["pubkey"]
            )

    with open(args.artifact, "rb") as fh:
        artifact = fh.read()

    try:
        verify(artifact, pubkey_text, signature_text)
    except ValueError as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        return 1

    print(f"OK: {args.artifact} verifies against the configured public key")
    return 0


if __name__ == "__main__":
    sys.exit(main())
