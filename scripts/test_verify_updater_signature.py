"""Tests for the updater signature verification script.

The script reimplements tauri-plugin-updater's check so a release can be
validated before it is published. If it drifts from the plugin's rules,
a broken release would pass locally and fail for every user -- so the
parsing rules are pinned here.

Run with: python -m unittest discover -s scripts
"""

import base64
import hashlib
import importlib.util
import os
import unittest

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

SCRIPT = os.path.join(os.path.dirname(__file__), "verify-updater-signature.py")

spec = importlib.util.spec_from_file_location("verify_updater_signature", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def make_keypair():
    """A minisign-style keypair: raw ed25519 bytes plus a key id."""
    private = Ed25519PrivateKey.generate()
    public_bytes = private.public_key().public_bytes(
        Encoding.Raw, PublicFormat.Raw
    )
    key_id = b"\x01\x02\x03\x04\x05\x06\x07\x08"
    return private, public_bytes, key_id


def sign(private, artifact: bytes, trusted_comment: str, prehashed: bool = True):
    """Produce a four-line minisign signature file."""
    if prehashed:
        payload = hashlib.blake2b(artifact, digest_size=64).digest()
        algorithm = b"ED"
    else:
        payload = artifact
        algorithm = b"Ed"

    signature = private.sign(payload)
    global_signature = private.sign(signature + trusted_comment.encode("utf-8"))

    bin1 = algorithm + KEY_ID + signature
    bin2 = global_signature
    return "\n".join(
        [
            "untrusted comment: signature from tauri secret key",
            base64.standard_b64encode(bin1).decode(),
            f"trusted comment: {trusted_comment}",
            base64.standard_b64encode(bin2).decode(),
        ]
    )


KEY_ID = b"\x01\x02\x03\x04\x05\x06\x07\x08"


def public_key_file(public_bytes, key_id=KEY_ID) -> str:
    bin1 = b"Ed" + key_id + public_bytes
    return "\n".join(
        [
            "untrusted comment: minisign public key: 0102030405060708",
            base64.standard_b64encode(bin1).decode(),
        ]
    )


class ParsePublicKeyTest(unittest.TestCase):
    def test_round_trips_the_key_id_and_key(self):
        _, public_bytes, key_id = make_keypair()
        algorithm, parsed_id, parsed_key = mod.parse_public_key(
            public_key_file(public_bytes, key_id)
        )
        self.assertEqual(algorithm, b"Ed")
        self.assertEqual(parsed_id, key_id)
        self.assertEqual(parsed_key, public_bytes)

    def test_rejects_a_truncated_key(self):
        with self.assertRaises(ValueError):
            mod.parse_public_key(
                "untrusted comment: x\n" + base64.standard_b64encode(b"short").decode()
            )

    def test_rejects_an_unknown_algorithm(self):
        _, public_bytes, key_id = make_keypair()
        bin1 = b"XX" + key_id + public_bytes
        with self.assertRaises(ValueError):
            mod.parse_public_key(
                "untrusted comment: x\n" + base64.standard_b64encode(bin1).decode()
            )


class ParseSignatureTest(unittest.TestCase):
    def test_extracts_the_trusted_comment(self):
        private, _, _ = make_keypair()
        text = sign(private, b"payload", "timestamp:123\tfile:thing.exe")
        parsed = mod.parse_signature(text)
        self.assertEqual(parsed["trusted_comment"], "timestamp:123\tfile:thing.exe")
        self.assertEqual(parsed["algorithm"], b"ED")

    def test_rejects_a_missing_trusted_comment(self):
        private, _, _ = make_keypair()
        text = sign(private, b"payload", "timestamp:123")
        broken = "\n".join(text.split("\n")[:2] + ["not a trusted comment", ""])
        with self.assertRaises(ValueError):
            mod.parse_signature(broken)


class VerifyTest(unittest.TestCase):
    def test_accepts_a_prehashed_signature(self):
        private, public_bytes, key_id = make_keypair()
        artifact = b"the installer bytes"
        signature = sign(private, artifact, "timestamp:1\tfile:x.exe")
        mod.verify(artifact, public_key_file(public_bytes, key_id), signature)

    def test_accepts_a_legacy_signature(self):
        private, public_bytes, key_id = make_keypair()
        artifact = b"the installer bytes"
        signature = sign(private, artifact, "timestamp:1\tfile:x.exe", prehashed=False)
        mod.verify(artifact, public_key_file(public_bytes, key_id), signature)

    def test_rejects_a_modified_artifact(self):
        private, public_bytes, key_id = make_keypair()
        signature = sign(private, b"original", "timestamp:1\tfile:x.exe")
        with self.assertRaises(ValueError):
            mod.verify(b"tampered", public_key_file(public_bytes, key_id), signature)

    def test_rejects_a_mismatched_key(self):
        private, public_bytes, _ = make_keypair()
        _, other_public, other_id = make_keypair()
        artifact = b"the installer bytes"
        signature = sign(private, artifact, "timestamp:1\tfile:x.exe")
        with self.assertRaises(ValueError):
            mod.verify(artifact, public_key_file(other_public, other_id), signature)

    def test_rejects_a_tampered_trusted_comment(self):
        """The global signature covers the trusted comment, so editing
        the filename inside it must fail."""
        private, public_bytes, key_id = make_keypair()
        artifact = b"the installer bytes"
        signature = sign(private, artifact, "timestamp:1\tfile:x.exe")
        tampered = signature.replace("file:x.exe", "file:evil.exe")
        with self.assertRaises(ValueError):
            mod.verify(artifact, public_key_file(public_bytes, key_id), tampered)

    def test_a_renamed_artifact_still_verifies(self):
        """The signature covers the content, not the name -- which is
        what lets the release job rename the installers."""
        private, public_bytes, key_id = make_keypair()
        artifact = b"the installer bytes"
        signature = sign(private, artifact, "timestamp:1\tfile:x.exe")
        # Same bytes under a different name: still the same artifact.
        mod.verify(artifact, public_key_file(public_bytes, key_id), signature)


class LoadPubkeyTest(unittest.TestCase):
    def test_accepts_a_base64_blob(self):
        _, public_bytes, key_id = make_keypair()
        text = public_key_file(public_bytes, key_id)
        blob = base64.standard_b64encode(text.encode()).decode()
        self.assertEqual(mod.load_pubkey(blob), text)

    def test_accepts_raw_file_contents(self):
        _, public_bytes, key_id = make_keypair()
        text = public_key_file(public_bytes, key_id)
        self.assertEqual(mod.load_pubkey(text), text)


if __name__ == "__main__":
    unittest.main()
