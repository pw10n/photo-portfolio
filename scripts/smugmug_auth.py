#!/usr/bin/env python3
"""
smugmug_auth.py — One-shot helper to mint a SmugMug OAuth 1.0a access token.

SmugMug's API uses OAuth 1.0a. You can't use the API key / secret pair
directly to make user-scoped calls — you must trade them (plus the account
owner's approval) for an *access token* pair via a three-legged exchange:

    1. POST  getRequestToken    →  request_token, request_token_secret
    2. Open  authorize?...      →  user approves, copies a 6-digit verifier
    3. POST  getAccessToken     →  access_token, access_token_secret

This script automates steps 1 and 3. Step 2 is interactive: the script
prints a URL, you open it in a browser, log in to SmugMug, approve, then
paste the 6-digit verifier (PIN) back into the terminal.

The resulting access token belongs to whichever SmugMug account you log
in as during step 2. For migration, log in as the account owner so the
crawler can see private albums and Password fields.

────────────────────────────────────────────────────────────────────────────
Usage
────────────────────────────────────────────────────────────────────────────
    export SMUGMUG_API_KEY=...     # the consumer key from your app
    export SMUGMUG_API_SECRET=...  # the consumer secret
    python scripts/smugmug_auth.py

The script prints:

    export SMUGMUG_ACCESS_TOKEN=...
    export SMUGMUG_ACCESS_TOKEN_SECRET=...

Paste those into your shell (or your .env), and smugmug_crawl.py is ready
to run.

────────────────────────────────────────────────────────────────────────────
Scope requested
────────────────────────────────────────────────────────────────────────────
The authorize URL requests:
    Access=Full          — include private/unlisted content
    Permissions=Read     — read-only; migration never writes back

Tighten or widen by editing AUTHORIZE_PARAMS below.
"""

from __future__ import annotations

import os
import sys

from requests_oauthlib import OAuth1Session


REQUEST_TOKEN_URL = "https://api.smugmug.com/services/oauth/1.0a/getRequestToken"
AUTHORIZE_URL = "https://api.smugmug.com/services/oauth/1.0a/authorize"
ACCESS_TOKEN_URL = "https://api.smugmug.com/services/oauth/1.0a/getAccessToken"

AUTHORIZE_PARAMS = {
    "Access": "Full",       # "Public" hides private albums; "Full" includes them
    "Permissions": "Read",  # "Read" | "Add" | "Modify"; migration only reads
}


def main() -> None:
    api_key = os.environ.get("SMUGMUG_API_KEY")
    api_secret = os.environ.get("SMUGMUG_API_SECRET")
    if not api_key or not api_secret:
        sys.exit(
            "Set SMUGMUG_API_KEY and SMUGMUG_API_SECRET in the environment first.\n"
            "Create an app at https://api.smugmug.com/api/developer/apply to get them."
        )

    # Step 1: request token, callback="oob" → SmugMug will show a PIN instead of redirecting.
    session = OAuth1Session(api_key, client_secret=api_secret, callback_uri="oob")
    try:
        request_token = session.fetch_request_token(REQUEST_TOKEN_URL)
    except Exception as exc:
        sys.exit(f"Failed to fetch request token: {exc}")

    # Step 2: send the user to authorize, then collect the verifier PIN.
    auth_url = session.authorization_url(AUTHORIZE_URL, **AUTHORIZE_PARAMS)
    print()
    print("Open this URL in a browser, log in as the SmugMug account owner,")
    print("approve the app, and copy the 6-digit verifier shown afterwards:")
    print()
    print(f"    {auth_url}")
    print()
    verifier = input("Verifier (6-digit PIN): ").strip()
    if not verifier:
        sys.exit("No verifier entered; aborting.")

    # Step 3: exchange request token + verifier for the long-lived access token.
    session = OAuth1Session(
        api_key,
        client_secret=api_secret,
        resource_owner_key=request_token["oauth_token"],
        resource_owner_secret=request_token["oauth_token_secret"],
        verifier=verifier,
    )
    try:
        access_token = session.fetch_access_token(ACCESS_TOKEN_URL)
    except Exception as exc:
        sys.exit(f"Failed to fetch access token: {exc}")

    print()
    print("Success. Add these to your environment (or .env):")
    print()
    print(f"    export SMUGMUG_ACCESS_TOKEN={access_token['oauth_token']}")
    print(f"    export SMUGMUG_ACCESS_TOKEN_SECRET={access_token['oauth_token_secret']}")
    print()
    print("These tokens are long-lived; treat them like passwords.")


if __name__ == "__main__":
    main()
