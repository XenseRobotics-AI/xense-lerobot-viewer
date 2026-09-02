# SMTP smoke test

This directory contains a backend-only SMTP smoke test for QQ Mail.

## 1. Get a QQ Mail authorization code

1. Log in to QQ Mail.
2. Open `Settings` -> `Account`.
3. Enable the `POP3/IMAP/SMTP` service.
4. Generate an authorization code in the same section.

The authorization code is the password for third-party mail clients. It is not
your QQ account password.

## 2. Where to store the authorization code

Do not commit the code into this repository.
For local use, store it in `/tmp/qq_smtp_password`:

```bash
umask 077
printf '%s' 'your-qq-mail-authorization-code' > /tmp/qq_smtp_password
```

The script can read either `SMTP_PASSWORD` directly or `SMTP_PASSWORD_FILE`.

## 3. How to set the sender address

Set the sender and login address to the QQ mailbox you want to use:

- `SMTP_FROM_ADDRESS=1796262052@qq.com`
- `SMTP_USERNAME=1796262052@qq.com`

The recipient, subject, and body can be passed in the environment:

- `SMTP_TO_ADDRESS=frank@xenserobotics.com`
- `SMTP_SUBJECT=...`
- `SMTP_BODY=...`

Recommended runtime settings:

- `SMTP_HOST=smtp.qq.com`
- `SMTP_PORT=465`
- `SMTP_USE_SSL=1`

## 4. Run it

```bash
SMTP_PASSWORD_FILE=/tmp/qq_smtp_password \
SMTP_FROM_ADDRESS=1796262052@qq.com \
SMTP_USERNAME=1796262052@qq.com \
SMTP_TO_ADDRESS=frank@xenserobotics.com \
SMTP_SUBJECT='SMTP smoketest' \
SMTP_BODY='SMTP smoke test from xense-lerobot-viewer.' \
SMTP_HOST=smtp.qq.com \
SMTP_PORT=465 \
SMTP_USE_SSL=1 \
python scripts/mail-smoke-test/smtp_smoke_test.py
```
